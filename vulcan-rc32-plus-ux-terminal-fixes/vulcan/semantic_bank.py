#!/usr/bin/env python3
"""
vulcan_semantic.py
==================

One-file bootstrap + runtime for Vulcan's lightweight semantic lookup.

First run / build:
    python vulcan_semantic.py build ./semantic_bank

This will:
  1. ensure NumPy + spaCy are available,
  2. download/install en_core_web_lg 3.8.0 from GitHub if necessary,
  3. extract the useful lowercase alphabetic word vectors,
  4. L2-normalize them,
  5. write:
       semantic_bank/
         words.txt
         vectors.npy
         metadata.json

After the bank exists, spaCy is NOT needed for normal runtime use.

Examples:
    python vulcan_semantic.py nn ./semantic_bank efficiency -n 20

    python vulcan_semantic.py expand ./semantic_bank \
        car engine efficiency --generations 3

    python vulcan_semantic.py benchmark ./semantic_bank \
        car engine efficiency --repeats 5

    python vulcan_semantic.py benchmark ./semantic_bank \
        car engine efficiency --database ./chatgpt_history.sqlite

    python vulcan_semantic.py search ./semantic_bank \
        --query car engine efficiency \
        --text "The engine gets excellent fuel mileage." \
        --text "I bought a sofa." \
        --text "Vehicle efficiency improves with lower weight."

Python API:
    from vulcan_semantic import SemanticBank

    bank = SemanticBank("./semantic_bank")
    print(bank.nearest_neighbors("fruit", 20))
    print(bank.expand_category(["car", "engine", "efficiency"]))
    print(bank.search_strings(
        ["car", "engine", "efficiency"],
        ["great fuel mileage", "unrelated sentence"]
    ))

Runtime dependency after build:
    numpy
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence
import re


SPACY_VERSION = "3.8.11"
MODEL_VERSION = "3.8.0"
MODEL_PACKAGE = "en_core_web_lg"
MODEL_WHEEL_URL = (
    "https://github.com/explosion/spacy-models/releases/download/"
    f"en_core_web_lg-{MODEL_VERSION}/"
    f"en_core_web_lg-{MODEL_VERSION}-py3-none-any.whl"
)

_WORD_RE = re.compile(r"[A-Za-z]+")


# ---------------------------------------------------------------------------
# Bootstrap / transformation
# ---------------------------------------------------------------------------

def _pip_install(*packages: str) -> None:
    command = [sys.executable, "-m", "pip", "install"]
    # Arch and other PEP 668 distributions mark the system interpreter as
    # externally managed. Vulcan's existing installer already opts in there;
    # preserve ordinary isolation when running inside a virtual environment.
    if sys.prefix == sys.base_prefix:
        command.append("--break-system-packages")
    subprocess.check_call([*command, *packages])


def ensure_build_dependencies() -> None:
    try:
        import numpy  # noqa: F401
    except ImportError:
        print("Installing NumPy...")
        _pip_install("numpy")

    try:
        import spacy  # noqa: F401
    except ImportError:
        print(f"Installing spaCy {SPACY_VERSION}...")
        _pip_install(f"spacy=={SPACY_VERSION}")

    try:
        __import__(MODEL_PACKAGE)
    except ImportError:
        print(
            f"Downloading/installing {MODEL_PACKAGE} "
            f"{MODEL_VERSION}..."
        )
        _pip_install(MODEL_WHEEL_URL)


def build_bank(output_dir: str | Path) -> Path:
    """
    Download/load en_core_web_lg and transform its vector table into a
    portable Vulcan bank.

    Result:
        words.txt
        vectors.npy
        metadata.json

    Only lowercase alphabetic words are retained. Each exported vector is
    L2-normalized float32, so dot product == cosine similarity.
    """
    ensure_build_dependencies()

    import numpy as np
    import spacy
    import en_core_web_lg

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("Loading en_core_web_lg...")
    nlp = en_core_web_lg.load()

    vectors = nlp.vocab.vectors
    vocab = nlp.vocab

    records: list[tuple[str, int]] = []

    print("Extracting lowercase alphabetic vector vocabulary...")
    for key, row in vectors.key2row.items():
        try:
            word = vocab.strings[int(key)]
        except KeyError:
            continue

        if word.isalpha() and word == word.lower():
            records.append((word, int(row)))

    # Stable/reproducible mapping.
    records.sort(key=lambda item: item[0])

    words = [word for word, _ in records]
    rows = np.fromiter(
        (row for _, row in records),
        dtype=np.int64,
        count=len(records),
    )

    print(f"Extracting {len(words):,} vectors...")
    matrix = np.asarray(
        vectors.data[rows],
        dtype=np.float32,
    ).copy()

    print("L2-normalizing...")
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    np.divide(
        matrix,
        norms,
        out=matrix,
        where=norms != 0,
    )

    words_path = output_dir / "words.txt"
    vectors_path = output_dir / "vectors.npy"
    metadata_path = output_dir / "metadata.json"

    words_path.write_text(
        "\n".join(words) + "\n",
        encoding="utf-8",
    )

    np.save(
        vectors_path,
        matrix,
        allow_pickle=False,
    )

    metadata = {
        "format": "vulcan-semantic-bank",
        "version": 1,
        "source_model": f"{MODEL_PACKAGE}-{MODEL_VERSION}",
        "source_spacy_version": spacy.__version__,
        "word_count": len(words),
        "dimensions": int(matrix.shape[1]),
        "dtype": str(matrix.dtype),
        "normalized": True,
        "normalization": "lowercase alphabetic words only + L2 vector normalization",
        "mapping": "words.txt line N == vectors.npy row N",
        "similarity": "dot product equals cosine similarity",
    }

    metadata_path.write_text(
        json.dumps(metadata, indent=2) + "\n",
        encoding="utf-8",
    )

    print()
    print("Done.")
    print(f"Words:   {len(words):,}")
    print(
        f"Vectors: {matrix.shape[0]:,} x "
        f"{matrix.shape[1]} {matrix.dtype}"
    )
    print(
        f"Size:    "
        f"{vectors_path.stat().st_size / 1024**2:.2f} MiB vectors + "
        f"{words_path.stat().st_size / 1024**2:.2f} MiB words"
    )
    print(f"Bank:    {output_dir.resolve()}")

    return output_dir


# ---------------------------------------------------------------------------
# Runtime data classes
# ---------------------------------------------------------------------------

@dataclass
class Neighbor:
    word: str
    score: float


@dataclass
class CategoryMember:
    word: str
    score: float
    generation: int
    anchor: bool = False
    active: bool = True


@dataclass
class ExpansionGeneration:
    generation: int
    threshold: float
    category_mean_similarity: float
    candidate_mean: float
    candidate_std: float
    added: list[CategoryMember]
    pruned: list[CategoryMember]


@dataclass
class CategoryExpansion:
    anchors: list[str]
    active_words: list[str]
    members: list[CategoryMember]
    generations: list[ExpansionGeneration]


@dataclass
class StringSearchResult:
    index: int
    text: str
    score: float
    matched_words: list[str]
    contributions: list[tuple[str, float]]


# ---------------------------------------------------------------------------
# Portable runtime
# ---------------------------------------------------------------------------

class SemanticBank:
    """
    Runtime semantic bank.

    Requires only NumPy and the transformed words.txt + vectors.npy.
    """

    def __init__(self, directory: str | Path):
        import numpy as np

        self.np = np
        self.directory = Path(directory)

        self.words = (
            self.directory / "words.txt"
        ).read_text(
            encoding="utf-8"
        ).splitlines()

        # mmap avoids eagerly copying the ~283 MiB matrix.
        self.vectors = np.load(
            self.directory / "vectors.npy",
            mmap_mode="r",
        )

        if (
            len(self.words) != self.vectors.shape[0]
            or self.vectors.shape[1] != 300
        ):
            raise ValueError(
                "Semantic bank files do not agree: "
                f"{len(self.words)} words, "
                f"vectors shape {self.vectors.shape}"
            )

        self.word_to_row = {
            word: i
            for i, word in enumerate(self.words)
        }

    # ------------------------------------------------------------------
    # Basic lookup
    # ------------------------------------------------------------------

    def has_word(self, word: str) -> bool:
        return word.lower() in self.word_to_row

    def vector(self, word: str):
        row = self.word_to_row.get(word.lower())

        if row is None:
            return None

        return self.np.asarray(
            self.vectors[row],
            dtype=self.np.float32,
        )

    def nearest_neighbors(
        self,
        word: str,
        n: int = 20,
        *,
        exclude_self: bool = True,
    ) -> list[Neighbor]:
        q = self.vector(word)

        if q is None:
            return []

        scores = self.vectors @ q

        extra = 1 if exclude_self else 0
        k = min(len(scores), n + extra)

        indices = self.np.argpartition(
            scores,
            -k,
        )[-k:]

        indices = indices[
            self.np.argsort(scores[indices])[::-1]
        ]

        target = word.lower()
        output: list[Neighbor] = []

        for index in indices:
            candidate = self.words[int(index)]

            if exclude_self and candidate == target:
                continue

            output.append(
                Neighbor(
                    candidate,
                    float(scores[int(index)]),
                )
            )

            if len(output) >= n:
                break

        return output

    def nearest_neighbors_batch(
        self,
        words: Sequence[str],
        n: int = 20,
        *,
        exclude_self: bool = True,
        batch_size: int = 32,
    ) -> list[list[Neighbor]]:
        """Find exact neighbors for many words with batched matrix products.

        Results retain input order, including duplicate or unknown words. The
        bounded batch size keeps the temporary query-by-vocabulary score matrix
        small enough to use with the complete 247,556-word semantic bank.
        """
        if batch_size < 1:
            raise ValueError("batch_size must be at least 1")

        output: list[list[Neighbor]] = [[] for _ in words]

        if n <= 0 or not words or not self.words:
            return output

        valid_queries = [
            (position, word.lower(), self.word_to_row[word.lower()])
            for position, word in enumerate(words)
            if word.lower() in self.word_to_row
        ]

        extra = 1 if exclude_self else 0
        k = min(len(self.words), n + extra)

        for start in range(0, len(valid_queries), batch_size):
            chunk = valid_queries[start : start + batch_size]
            rows = [row for _, _, row in chunk]
            queries = self.np.asarray(
                self.vectors[rows], dtype=self.np.float32
            )
            score_matrix = queries @ self.vectors.T

            for score_row, (position, target, _) in zip(
                score_matrix, chunk
            ):
                indices = self.np.argpartition(score_row, -k)[-k:]
                indices = indices[
                    self.np.argsort(score_row[indices])[::-1]
                ]

                for index in indices:
                    candidate = self.words[int(index)]

                    if exclude_self and candidate == target:
                        continue

                    output[position].append(
                        Neighbor(candidate, float(score_row[int(index)]))
                    )

                    if len(output[position]) >= n:
                        break

        return output

    # ------------------------------------------------------------------
    # Category helpers
    # ------------------------------------------------------------------

    def _vectors_for_words(
        self,
        words: Iterable[str],
    ):
        found_words = []
        vectors = []

        for word in words:
            normalized = word.lower()
            row = self.word_to_row.get(normalized)

            if row is None:
                continue

            found_words.append(normalized)
            vectors.append(
                self.np.asarray(
                    self.vectors[row],
                    dtype=self.np.float32,
                )
            )

        if not vectors:
            return (
                [],
                self.np.empty(
                    (0, 300),
                    dtype=self.np.float32,
                ),
            )

        return found_words, self.np.stack(vectors)

    def _mean_pairwise_similarity(
        self,
        matrix,
    ) -> float:
        """
        Exact mean pairwise cosine similarity for unit vectors:

            μ = (||Σv||² - n) / (n(n-1))

        Avoids constructing an NxN similarity matrix.
        """
        n = len(matrix)

        if n < 2:
            return 1.0

        total = matrix.sum(axis=0)

        return float(
            (
                self.np.dot(total, total)
                - n
            )
            / (n * (n - 1))
        )

    def _weighted_center(
        self,
        anchor_matrix,
        mutable_matrix,
        anchor_weight: float,
    ):
        total = self.np.zeros(
            300,
            dtype=self.np.float32,
        )
        weight = 0.0

        if len(anchor_matrix):
            total += (
                anchor_matrix.sum(axis=0)
                * anchor_weight
            )
            weight += (
                len(anchor_matrix)
                * anchor_weight
            )

        if len(mutable_matrix):
            total += mutable_matrix.sum(axis=0)
            weight += len(mutable_matrix)

        if weight == 0:
            return total

        return total / weight

    # ------------------------------------------------------------------
    # Semantic Seeding
    # ------------------------------------------------------------------

    def expand_category(
        self,
        seeds: Sequence[str],
        *,
        generations: int = 3,
        neighbors_per_word: int = 35,
        max_additions_per_generation: int = 12,
        anchor_weight: float = 1.5,
        minimum_threshold: float = 0.30,
        retention_margin: float = 0.03,
        batched: bool = True,
    ) -> CategoryExpansion:
        """
        Iteratively grow a semantic category.

        Original seeds:
            permanent anchors

        Generated terms:
            become NN generators on later generations
            receive one generation of pruning immunity
            may later be removed if they become stale

        Candidate fitness:
            dot(candidate, weighted category center)

        Dynamic threshold:
            max(
                minimum_threshold,
                0.25 + 0.40 * category_mean_similarity,
                candidate_mean + candidate_std
            )
        """

        anchors = []

        for seed in seeds:
            word = seed.lower()

            if (
                word in self.word_to_row
                and word not in anchors
            ):
                anchors.append(word)

        if not anchors:
            return CategoryExpansion(
                anchors=[],
                active_words=[],
                members=[],
                generations=[],
            )

        anchor_words, anchor_matrix = (
            self._vectors_for_words(anchors)
        )

        mutable: dict[str, CategoryMember] = {}
        history_members: dict[str, CategoryMember] = {}
        generations_out: list[ExpansionGeneration] = []

        for generation in range(
            1,
            generations + 1,
        ):
            mutable_words = [
                word
                for word, member in mutable.items()
                if member.active
            ]

            _, mutable_matrix = (
                self._vectors_for_words(
                    mutable_words
                )
            )

            current_words = (
                anchor_words
                + mutable_words
            )

            if len(mutable_matrix):
                category_matrix = self.np.concatenate(
                    [
                        anchor_matrix,
                        mutable_matrix,
                    ],
                    axis=0,
                )
            else:
                category_matrix = anchor_matrix

            category_mean = (
                self._mean_pairwise_similarity(
                    category_matrix
                )
            )

            center = self._weighted_center(
                anchor_matrix,
                mutable_matrix,
                anchor_weight,
            )

            # ----------------------------------------------
            # Generate NN candidates from every active member
            # ----------------------------------------------

            current_set = set(current_words)
            candidate_words: set[str] = set()

            if batched:
                neighbor_groups = self.nearest_neighbors_batch(
                    current_words, neighbors_per_word
                )
            else:
                neighbor_groups = [
                    self.nearest_neighbors(word, neighbors_per_word)
                    for word in current_words
                ]

            for neighbors in neighbor_groups:
                for hit in neighbors:
                    if hit.word not in current_set:
                        candidate_words.add(
                            hit.word
                        )

            (
                candidate_word_list,
                candidate_matrix,
            ) = self._vectors_for_words(
                candidate_words
            )

            if len(candidate_matrix):
                candidate_scores = (
                    candidate_matrix @ center
                )

                candidate_mean = float(
                    candidate_scores.mean()
                )

                candidate_std = float(
                    candidate_scores.std()
                )
            else:
                candidate_scores = self.np.empty(
                    0,
                    dtype=self.np.float32,
                )
                candidate_mean = 0.0
                candidate_std = 0.0

            # ----------------------------------------------
            # Dynamic threshold
            # ----------------------------------------------

            threshold = max(
                minimum_threshold,
                (
                    0.25
                    + 0.40
                    * category_mean
                ),
                (
                    candidate_mean
                    + candidate_std
                ),
            )

            ranked = sorted(
                zip(
                    candidate_word_list,
                    candidate_scores,
                ),
                key=lambda pair: float(pair[1]),
                reverse=True,
            )

            added: list[CategoryMember] = []

            for word, score in ranked:
                score = float(score)

                if score < threshold:
                    break

                if (
                    word in mutable
                    or word in current_set
                ):
                    continue

                member = CategoryMember(
                    word=word,
                    score=score,
                    generation=generation,
                    anchor=False,
                    active=True,
                )

                mutable[word] = member
                history_members[word] = member
                added.append(member)

                if (
                    len(added)
                    >= max_additions_per_generation
                ):
                    break

            # ----------------------------------------------
            # Prune stale generated members
            # ----------------------------------------------

            active_mutable = [
                word
                for word, member
                in mutable.items()
                if member.active
            ]

            _, active_matrix = (
                self._vectors_for_words(
                    active_mutable
                )
            )

            grown_center = (
                self._weighted_center(
                    anchor_matrix,
                    active_matrix,
                    anchor_weight,
                )
            )

            pruned: list[CategoryMember] = []

            for word, member in list(
                mutable.items()
            ):
                if not member.active:
                    continue

                # Newborn members get one generation
                # to participate before pruning.
                if (
                    member.generation
                    >= generation
                ):
                    continue

                score = float(
                    self.vector(word)
                    @ grown_center
                )

                member.score = score

                if (
                    score
                    < threshold
                    - retention_margin
                ):
                    member.active = False
                    pruned.append(member)

            generations_out.append(
                ExpansionGeneration(
                    generation=generation,
                    threshold=float(
                        threshold
                    ),
                    category_mean_similarity=float(
                        category_mean
                    ),
                    candidate_mean=float(
                        candidate_mean
                    ),
                    candidate_std=float(
                        candidate_std
                    ),
                    added=added,
                    pruned=pruned,
                )
            )

        active_mutable = [
            word
            for word, member
            in mutable.items()
            if member.active
        ]

        members = [
            CategoryMember(
                word=word,
                score=1.0,
                generation=0,
                anchor=True,
                active=True,
            )
            for word in anchor_words
        ]

        members.extend(
            history_members.values()
        )

        return CategoryExpansion(
            anchors=anchor_words,
            active_words=(
                anchor_words
                + active_mutable
            ),
            members=members,
            generations=generations_out,
        )

    # ------------------------------------------------------------------
    # Fuzzy lexical search within caller-supplied strings
    # ------------------------------------------------------------------

    @staticmethod
    def _tokens(text: str) -> list[str]:
        return [
            token.lower()
            for token
            in _WORD_RE.findall(text)
        ]

    def search_strings(
        self,
        query: str | Sequence[str],
        strings: Sequence[str],
        *,
        top_k: int = 10,
        expand: bool = True,
        generations: int = 3,
        exact_weight: float = 2.0,
        semantic_weight: float = 1.0,
        minimum_word_similarity: float = 0.30,
    ) -> list[StringSearchResult]:
        """
        Fuzzy lexical search constrained strictly to `strings`.

        This does NOT embed whole strings.

        Query:
            words -> optional Semantic Seeding expansion

        Candidate strings:
            only words actually occurring in each string can score

        Exact query terms receive a stronger boost.
        Generated semantic terms are weighted by their category score.
        """

        if isinstance(query, str):
            query_words = [
                word
                for word in self._tokens(query)
                if word in self.word_to_row
            ]
        else:
            query_words = [
                str(word).lower()
                for word in query
                if (
                    str(word).lower()
                    in self.word_to_row
                )
            ]

        query_words = list(
            dict.fromkeys(query_words)
        )

        if not query_words:
            return []

        if expand:
            expansion = self.expand_category(
                query_words,
                generations=generations,
            )

            active_words = set(
                expansion.active_words
            )

            generated_scores = {
                member.word: member.score
                for member
                in expansion.members
                if (
                    not member.anchor
                    and member.active
                )
            }
        else:
            active_words = set(
                query_words
            )
            generated_scores = {}

        anchors = set(query_words)

        results: list[StringSearchResult] = []

        for index, text in enumerate(strings):
            tokens = self._tokens(text)

            if not tokens:
                continue

            token_set = set(tokens)
            matched = (
                token_set
                & active_words
            )

            if not matched:
                continue

            score = 0.0
            contributions: list[
                tuple[str, float]
            ] = []

            for word in matched:
                count = tokens.count(word)

                if word in anchors:
                    contribution = (
                        exact_weight
                        * count
                    )
                else:
                    semantic_score = (
                        generated_scores.get(
                            word,
                            minimum_word_similarity,
                        )
                    )

                    if (
                        semantic_score
                        < minimum_word_similarity
                    ):
                        continue

                    contribution = (
                        semantic_weight
                        * semantic_score
                        * count
                    )

                score += contribution

                contributions.append(
                    (
                        word,
                        float(
                            contribution
                        ),
                    )
                )

            if score <= 0:
                continue

            contributions.sort(
                key=lambda pair: pair[1],
                reverse=True,
            )

            results.append(
                StringSearchResult(
                    index=index,
                    text=text,
                    score=float(score),
                    matched_words=[
                        word
                        for word, _
                        in contributions
                    ],
                    contributions=contributions,
                )
            )

        results.sort(
            key=lambda result: result.score,
            reverse=True,
        )

        return results[:top_k]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Build and use the Vulcan "
            "portable semantic word bank."
        )
    )

    sub = parser.add_subparsers(
        dest="command",
        required=True,
    )

    build_p = sub.add_parser(
        "build",
        help=(
            "Download en_core_web_lg and "
            "build portable vector bank"
        ),
    )
    build_p.add_argument("output")

    nn_p = sub.add_parser(
        "nn",
        help="Nearest-neighbor lookup",
    )
    nn_p.add_argument("bank")
    nn_p.add_argument("word")
    nn_p.add_argument(
        "-n",
        type=int,
        default=20,
    )

    expand_p = sub.add_parser(
        "expand",
        help="Semantic category expansion",
    )
    expand_p.add_argument("bank")
    expand_p.add_argument(
        "seeds",
        nargs="+",
    )
    expand_p.add_argument(
        "--generations",
        type=int,
        default=3,
    )

    benchmark_p = sub.add_parser(
        "benchmark",
        help="Compare sequential and batched lookup on this machine",
    )
    benchmark_p.add_argument("bank")
    benchmark_p.add_argument("seeds", nargs="+")
    benchmark_p.add_argument("--generations", type=int, default=3)
    benchmark_p.add_argument("--neighbors", type=int, default=35)
    benchmark_p.add_argument("--repeats", type=int, default=3)
    benchmark_p.add_argument(
        "--database",
        help="Optional SQLite chat history with a message_fts index",
    )
    benchmark_p.add_argument("--limit", type=int, default=20)

    search_p = sub.add_parser(
        "search",
        help=(
            "Fuzzy lexical search within "
            "explicit strings"
        ),
    )
    search_p.add_argument("bank")
    search_p.add_argument(
        "--query",
        nargs="+",
        required=True,
    )
    search_p.add_argument(
        "--text",
        action="append",
        default=[],
        required=True,
    )
    search_p.add_argument(
        "--top-k",
        type=int,
        default=10,
    )

    args = parser.parse_args()

    if args.command == "build":
        build_bank(args.output)
        return

    bank = SemanticBank(args.bank)

    if args.command == "nn":
        for hit in bank.nearest_neighbors(
            args.word,
            args.n,
        ):
            print(
                f"{hit.word:20} "
                f"{hit.score:.4f}"
            )

    elif args.command == "expand":
        result = bank.expand_category(
            args.seeds,
            generations=args.generations,
        )

        print(
            "Anchors:",
            ", ".join(result.anchors),
        )

        for generation in result.generations:
            print()
            print(
                f"Generation "
                f"{generation.generation}"
                f"  T="
                f"{generation.threshold:.3f}"
            )

            print(
                "  added:",
                ", ".join(
                    member.word
                    for member
                    in generation.added
                )
                or "—",
            )

            print(
                "  pruned:",
                ", ".join(
                    member.word
                    for member
                    in generation.pruned
                )
                or "—",
            )

        print()
        print(
            "Final:",
            ", ".join(
                result.active_words
            ),
        )

    elif args.command == "benchmark":
        if args.repeats < 1:
            parser.error("--repeats must be at least 1")

        seeds = [word.lower() for word in args.seeds if bank.has_word(word)]

        if not seeds:
            parser.error("none of the supplied seeds exist in the bank")

        def measure(action):
            durations = []
            result = None

            for _ in range(args.repeats):
                started = time.perf_counter()
                result = action()
                durations.append(time.perf_counter() - started)

            return result, sorted(durations)[len(durations) // 2]

        sequential_neighbors, sequential_nn = measure(
            lambda: [
                bank.nearest_neighbors(word, args.neighbors)
                for word in seeds
            ]
        )
        batched_neighbors, batched_nn = measure(
            lambda: bank.nearest_neighbors_batch(seeds, args.neighbors)
        )
        sequential_expansion, sequential_expand = measure(
            lambda: bank.expand_category(
                seeds,
                generations=args.generations,
                neighbors_per_word=args.neighbors,
                batched=False,
            )
        )
        batched_expansion, batched_expand = measure(
            lambda: bank.expand_category(
                seeds,
                generations=args.generations,
                neighbors_per_word=args.neighbors,
                batched=True,
            )
        )

        same_neighbors = all(
            [hit.word for hit in old] == [hit.word for hit in new]
            for old, new in zip(sequential_neighbors, batched_neighbors)
        )
        same_expansion = (
            sequential_expansion.active_words
            == batched_expansion.active_words
        )

        report = {
                    "bank_words": len(bank.words),
                    "seeds": seeds,
                    "generations": args.generations,
                    "neighbors_per_word": args.neighbors,
                    "repeats": args.repeats,
                    "nearest_neighbors": {
                        "sequential_median_ms": round(sequential_nn * 1000, 3),
                        "batched_median_ms": round(batched_nn * 1000, 3),
                        "speedup": round(sequential_nn / batched_nn, 3),
                        "same_results": same_neighbors,
                    },
                    "category_expansion": {
                        "sequential_median_ms": round(
                            sequential_expand * 1000, 3
                        ),
                        "batched_median_ms": round(batched_expand * 1000, 3),
                        "speedup": round(sequential_expand / batched_expand, 3),
                        "same_results": same_expansion,
                        "active_words": batched_expansion.active_words,
                    },
                }

        if args.database:
            connection = sqlite3.connect(
                f"file:{Path(args.database).resolve()}?mode=ro",
                uri=True,
            )

            def retrieve(words):
                expression = " OR ".join(
                    '"' + word.replace('"', '""') + '"'
                    for word in words
                )

                return connection.execute(
                    "SELECT title, role, conversation_id, node_id "
                    "FROM message_fts WHERE message_fts MATCH ? LIMIT ?",
                    (expression, args.limit),
                ).fetchall()

            seed_matches, seed_retrieval = measure(
                lambda: retrieve(seeds)
            )
            expanded_matches, expanded_retrieval = measure(
                lambda: retrieve(batched_expansion.active_words)
            )

            report["database_recall"] = {
                "database": str(Path(args.database).resolve()),
                "result_limit": args.limit,
                "seed_only_median_ms": round(seed_retrieval * 1000, 3),
                "seed_only_results": len(seed_matches),
                "expanded_fts_median_ms": round(
                    expanded_retrieval * 1000, 3
                ),
                "expanded_results": len(expanded_matches),
                "sequential_expansion_plus_fts_ms": round(
                    (sequential_expand + expanded_retrieval) * 1000, 3
                ),
                "batched_expansion_plus_fts_ms": round(
                    (batched_expand + expanded_retrieval) * 1000, 3
                ),
            }
            connection.close()

        print(json.dumps(report, indent=2))

    elif args.command == "search":
        results = bank.search_strings(
            args.query,
            args.text,
            top_k=args.top_k,
        )

        for result in results:
            print()
            print(
                f"{result.score:.3f}"
                f"  [{result.index}]"
            )

            print(
                "  matched:",
                ", ".join(
                    result.matched_words
                ),
            )

            print(
                " ",
                result.text,
            )


if __name__ == "__main__":
    main()
