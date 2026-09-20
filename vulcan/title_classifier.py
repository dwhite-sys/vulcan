"""Deterministic first-turn chat title classifier.

The model is an interpretable linear ranker tuned against the canonical titles
from the historical Vulcan/ChatGPT conversation corpus. Candidate phrases come
only from the first user message; the first assistant response is used only as
confirmation context. No network, provider inference, embeddings, or spaCy
runtime are required.
"""
from __future__ import annotations

from collections import Counter
import re
from typing import Iterable

# Feature weights from the 2026-09-15 joint user+assistant tuning pass.
WEIGHTS: tuple[float, ...] = (
    0.0, -0.20440827310085297, 0.26075249910354614,
    -2.1823501586914062, -0.6865781545639038, 0.3904542922973633,
    0.5032978057861328, 0.17820493876934052, 0.3662227392196655,
    -1.0699691772460938, -0.9860644936561584, -0.3499999940395355,
    -1.4925276041030884, -2.200000047683716, -0.5987539887428284,
    0.0, 0.4341563880443573, 1.202588438987732, -0.730634331703186,
    -0.17437037825584412, 0.22730302810668945, 0.6213815212249756,
    0.10000000149011612, 0.3251778185367584, 1.649999976158142,
    0.550000011920929, 1.0132921934127808, 0.7055943012237549,
    0.3499999940395355, -0.25,
)

STOP = set("""the and that this with from have has had just like about into your you for are was were be been being but not can could would should may might there their they them then than what when where which while who why how its our out too very more some thing things make made does did doing also really actually basically okay yeah yes no want think know use using used get got one two new old same message response branch chat conversation a an of to in on at as by or if it i me my we us do is am will shall""".split())
FILLER = set("""actually basically honestly lowkey kinda kind sorta really literally maybe perhaps okay ok yeah yep well so anyway anyways wait minute wondering wonder curious question favor please hey hi hello watching looking trying thinking thought guess suppose remember recall tell help need wanna gotta""".split())
GENERIC = set("""thing things stuff issue problem problems way ways idea ideas question questions something anything everything good bad right wrong work works working current currently now today here there""".split())
AUX = set("""is are was were be been being am do does did have has had can could would should will shall may might must""".split())
TAIL = AUX | set("""and or but so because if when where while with from to for of in on at by as than that this these those a an the""".split())
LEAD = set("""i im i'm ive i've id i'd ill i'll we we're weve we've wed we'd well we'll you you're youve you've you'd you'll can could would should do does did is are was were what whats what's how why where when who which tell give help please hey hi hello so well okay ok actually basically really just""".split())
TRIM_LEFT = LEAD | set("a an the my your our their this that these those".split())
TRIM_RIGHT = TAIL | set("currently actually really just maybe perhaps".split())
TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_+#.'/-]*")


def _tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(re.sub(r"\s+", " ", str(text)).strip())


def _norm(token: str) -> str:
    return token.lower().strip("._-'\"")


def _content(tokens: Iterable[str]) -> list[str]:
    return [word for token in tokens if len(word := _norm(token)) >= 2 and word not in STOP]


def _clean_title(tokens: list[str]) -> str:
    value = list(tokens)
    while len(value) > 2 and _norm(value[0]) in TRIM_LEFT:
        value = value[1:]
    while len(value) > 2 and _norm(value[-1]) in TRIM_RIGHT:
        value = value[:-1]
    value = value[:5]
    title = " ".join(value).strip(" .,:;!?-")
    return title[:1].upper() + title[1:] if title else "New Chat"


def _candidates(user_tokens: list[str]) -> list[tuple[int, list[str]]]:
    tokens = user_tokens[:120]
    result: list[tuple[int, list[str]]] = []
    seen: set[str] = set()
    for size in range(2, 7):
        for start in range(0, len(tokens) - size + 1):
            span = tokens[start:start + size]
            content = _content(span)
            if len(content) < 1 or (len(content) < 2 and size > 3):
                continue
            key = " ".join(span).lower()
            if key not in seen:
                seen.add(key)
                result.append((start, span))
    for start, token in enumerate(tokens):
        word = _norm(token)
        if len(word) >= 4 and word not in STOP and word not in seen:
            seen.add(word)
            result.append((start, [token]))
    return result


def _base_features(user_text: str, start: int, span: list[str], user_tokens: list[str], content_counts: Counter[str], early: set[str], question_token_index: int) -> list[float]:
    normalized = [_norm(token) for token in span]
    content = _content(span)
    content_len = len(content)
    size = len(span)
    position = start / max(1, len(user_tokens) - 1)
    repeated = sum(max(0, content_counts[word] - 1) for word in content)
    caps = sum(bool(re.match(r"^[A-Z][A-Za-z0-9.+#/-]*$", token)) for token in span)
    acronyms = sum(bool(re.match(r"^[A-Z0-9][A-Z0-9.+#/-]{1,}$", token)) and any(ch.isalpha() for ch in token) for token in span)
    technical = sum(bool(re.search(r"[0-9+#/_-]", token)) or (len(token) > 1 and any(ch.isupper() for ch in token[1:])) for token in span)
    before_question = 1.0 if question_token_index >= 0 and start < max(1, question_token_index) else 0.0
    proper = 1.0 if caps >= 2 else 0.0
    return [
        1.0,
        float(content_len), float(size), position, position * position,
        float(repeated), float(caps), float(acronyms), float(technical),
        float(sum(word in FILLER for word in normalized)),
        float(sum(word in GENERIC for word in normalized)),
        float(sum(word in STOP for word in normalized)),
        float(sum(word in LEAD for word in normalized[:min(2, size)])),
        1.0 if normalized[-1] in TAIL else 0.0,
        1.0 if normalized[-1].endswith(("ing", "ed")) and size > 2 else 0.0,
        before_question,
        float(sum(word in early for word in content)),
        1.0 if 2 <= content_len <= 5 else 0.0,
        1.0 if size > 5 else 0.0,
        1.0 if start == 0 else 0.0,
        proper,
        content_len / max(1, size),
    ]


def _assistant_features(span: list[str], assistant_content: list[str], assistant_set: set[str], assistant_counts: Counter[str], assistant_early: set[str], assistant_first_position: dict[str, float], assistant_normalized: str) -> list[float]:
    content = _content(span)
    if not content:
        return [0.0] * 8
    unique = set(content)
    hit = sum(word in assistant_set for word in content)
    frequency = sum(assistant_counts[word] for word in content)
    fraction = hit / len(content)
    early_fraction = sum(word in assistant_early for word in content) / len(content)
    phrase = " ".join(_norm(token) for token in span)
    exact = 1.0 if phrase and phrase in assistant_normalized else 0.0
    all_confirmed = 1.0 if hit == len(content) else 0.0
    positions = [assistant_first_position[word] for word in unique if word in assistant_first_position]
    mean_position = sum(positions) / len(positions) if positions else 1.0
    return [
        float(hit), float(frequency), fraction, exact, early_fraction,
        sum(word in assistant_set for word in unique) / max(1, len(unique)),
        all_confirmed, mean_position,
    ]


def generate_chat_title(user_message: str, assistant_message: str) -> str:
    """Return a deterministic title from the first user + assistant turn."""
    user_tokens = _tokens(user_message)[:120]
    if not user_tokens:
        return "New Chat"

    user_content = _content(user_tokens)
    content_counts = Counter(user_content)
    early = set(_content(user_tokens[:12]))
    question_char = str(user_message).find("?")
    question_token_index = len(_tokens(str(user_message)[:question_char])) if question_char >= 0 else -1

    assistant_tokens = _tokens(assistant_message)[:240]
    assistant_content = _content(assistant_tokens)
    assistant_set = set(assistant_content)
    assistant_counts = Counter(assistant_content)
    assistant_early = set(assistant_content[:32])
    denom = max(1, len(assistant_content) - 1)
    assistant_first_position: dict[str, float] = {}
    for index, word in enumerate(assistant_content):
        assistant_first_position.setdefault(word, index / denom)
    assistant_normalized = " ".join(_norm(token) for token in assistant_tokens)

    best_title = "New Chat"
    best_score = float("-inf")
    for start, span in _candidates(user_tokens):
        features = _base_features(
            user_message, start, span, user_tokens,
            content_counts, early, question_token_index,
        ) + _assistant_features(
            span, assistant_content, assistant_set, assistant_counts,
            assistant_early, assistant_first_position, assistant_normalized,
        )
        score = sum(weight * feature for weight, feature in zip(WEIGHTS, features))
        if score > best_score:
            best_score = score
            best_title = _clean_title(span)
    return best_title
