"""Traffic control for the General WebSocket: egress lanes, admission, lag.

Design rules (see the traffic architecture handoff):

* The asyncio loop is the traffic cop, not one of the trucks.
* No amount of model output may make the control plane unavailable.

Egress is split into physically separate, byte-accounted lanes:

``CONTROL``  register/auth, cancel, answer, status, relay control. Always
             serviced first; never refused and never budget-blocked.
``STATE``    authoritative, ordered, non-droppable boundaries (event created
             or finalized, run status, questions, full snapshots).
``STREAM``   live token deltas. Bounded: when a subscriber falls behind, its
             deltas degrade to one coalesced replacement snapshot per event.
``BULK``     hydration, exports, listings, large tool results. Producers
             (request handlers) wait for lane capacity.

Remaining service after CONTROL is deficit-round-robin weighted
STATE > STREAM > BULK, so no lane starves while higher lanes still win.

Ordering: a STREAM delta must never overtake an authoritative (``ordered``)
message enqueued before it, otherwise a renderer could see a delta for an
event it has not been told exists yet. Each STREAM item records the ordered
sequence at its enqueue time and is held until all of those were sent.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

logger = logging.getLogger("vulcan.traffic")

CONTROL, STATE, STREAM, BULK = 0, 1, 2, 3
LANE_NAMES = ("control", "state", "stream", "bulk")

_WEIGHTS = {STATE: 8, STREAM: 4, BULK: 1}
_ROUND_ROBIN = (STATE, STREAM, BULK)
_QUANTUM = 16 * 1024
_LAZY_ESTIMATE = 4 * 1024
# A lazily-built replacement snapshot may only be sent once every ordered
# message enqueued before it is out; its content is built at send time.
_BARRIER_ALL = -1


@dataclass
class EgressBudgets:
    """Byte budgets. Deliberately modest: large buffers only recreate backlog."""

    state_soft: int = 4 * 1024 * 1024
    state_hard: int = 64 * 1024 * 1024
    stream: int = 512 * 1024
    bulk_soft: int = 8 * 1024 * 1024


class _Item:
    __slots__ = ("plaintext", "build", "future", "size", "ordered", "barrier", "key")

    def __init__(self, plaintext: bytes | None, *, build: Callable[[], Any] | None = None,
                 future: asyncio.Future | None = None, ordered: int = 0,
                 barrier: int = 0, key: str | None = None) -> None:
        self.plaintext = plaintext
        self.build = build
        self.future = future
        self.size = len(plaintext) if plaintext is not None else _LAZY_ESTIMATE
        self.ordered = ordered
        self.barrier = barrier
        self.key = key


class EgressScheduler:
    """Byte-budgeted multi-lane sender feeding one ordered secure transport."""

    def __init__(
        self,
        transmit: Callable[[bytes], Awaitable[None]],
        encode: Callable[[Any], bytes],
        *,
        budgets: EgressBudgets | None = None,
        on_overflow: Callable[[str], None] | None = None,
    ) -> None:
        self._transmit = transmit
        self._encode = encode
        self.budgets = budgets or EgressBudgets()
        self._on_overflow = on_overflow
        self._lanes: list[deque[_Item]] = [deque() for _ in LANE_NAMES]
        self._bytes = [0 for _ in LANE_NAMES]
        self._deficit = [0 for _ in LANE_NAMES]
        self._rr = 0
        self._wakeup = asyncio.Event()
        self._space = [asyncio.Event() for _ in LANE_NAMES]
        for event in self._space:
            event.set()
        self._ordered_seq = 0
        self._ordered_pending: deque[int] = deque()
        self._ordered_done: set[int] = set()
        self._stream_placeholders: dict[str, _Item] = {}
        self._closed = False
        self.stats: dict[str, Any] = {
            "sent_bytes": [0, 0, 0, 0],
            "sent_messages": [0, 0, 0, 0],
            "peak_bytes": [0, 0, 0, 0],
            "stream_resyncs": 0,
            "stream_dropped": 0,
            "overflows": 0,
        }
        self._task = asyncio.create_task(self._drain(), name="general-ws-egress")

    # ── Introspection ─────────────────────────────────────────────────────

    def snapshot(self) -> dict[str, Any]:
        return {
            name: {
                "queued_bytes": self._bytes[lane],
                "queued_messages": len(self._lanes[lane]),
                "peak_bytes": self.stats["peak_bytes"][lane],
                "sent_bytes": self.stats["sent_bytes"][lane],
                "sent_messages": self.stats["sent_messages"][lane],
            }
            for lane, name in enumerate(LANE_NAMES)
        } | {
            "stream_resyncs": self.stats["stream_resyncs"],
            "stream_dropped": self.stats["stream_dropped"],
            "overflows": self.stats["overflows"],
        }

    def queued_bytes(self, lane: int) -> int:
        return self._bytes[lane]

    # ── Producers ─────────────────────────────────────────────────────────

    def reserve_ordered(self) -> int:
        """Claim an ordering slot now for a frame whose content is captured
        now but encoded later (e.g. in a worker); pass it to send()."""
        return self._reserve_ordered()

    async def send(self, plaintext: bytes, lane: int, *, ordered: bool = False, reserved: int = 0) -> None:
        """Enqueue and wait for delivery; waits for lane capacity first.

        CONTROL is never budget-blocked. Budget waits admit at least one item
        into an empty lane so a single oversized payload still makes progress.
        """
        if self._closed:
            raise ConnectionError("General WS egress closed")
        # An ordered frame claims its place in the ordering *before* waiting
        # for capacity: its content was captured now, so no live delta
        # produced while it waits may overtake it.
        if not reserved:
            reserved = self._reserve_ordered() if ordered else 0
        try:
            soft = self._soft_budget(lane)
            while soft is not None and self._bytes[lane] and self._bytes[lane] + len(plaintext) > soft:
                self._space[lane].clear()
                await self._space[lane].wait()
                if self._closed:
                    raise ConnectionError("General WS egress closed")
        except BaseException:
            if reserved:
                self._ordered_done.add(reserved)
                self._wakeup.set()
            raise
        future = asyncio.get_running_loop().create_future()
        item = _Item(plaintext, future=future, ordered=reserved)
        self._enqueue(lane, item, ordered=False)
        await future

    def post(self, plaintext: bytes, lane: int, *, ordered: bool | None = None) -> bool:
        """Non-blocking enqueue for server pushes. False if it was refused."""
        if self._closed:
            return False
        if ordered is None:
            ordered = lane == STATE
        if lane == STATE and self._bytes[STATE] and self._bytes[STATE] + len(plaintext) > self.budgets.state_hard:
            # Authoritative state cannot be dropped, and it cannot queue
            # forever either. A subscriber this far behind is disconnected
            # and resynchronizes from a full snapshot when it reconnects.
            self.stats["overflows"] += 1
            if self._on_overflow is not None:
                self._on_overflow("state lane backlog exceeded")
            return False
        self._enqueue(lane, _Item(plaintext), ordered=ordered)
        return True

    def post_stream(self, key: str, plaintext: bytes | None, build: Callable[[], Any]) -> None:
        """Enqueue a replaceable live delta, degrading to a coalesced snapshot.

        ``plaintext`` is the ordered delta frame (None for subscribers that do
        not understand deltas). ``build`` returns a full replacement message
        built from current state at send time.
        """
        if self._closed:
            return
        placeholder = self._stream_placeholders.get(key)
        if placeholder is not None:
            # A replacement snapshot for this key is already queued; it will
            # contain this delta's content when it is built.
            self.stats["stream_dropped"] += 1
            return
        if plaintext is None or self._bytes[STREAM] + len(plaintext) > self.budgets.stream:
            if plaintext is not None:
                self.stats["stream_resyncs"] += 1
                self.stats["stream_dropped"] += 1
            item = _Item(None, build=build, barrier=_BARRIER_ALL, key=key)
            self._stream_placeholders[key] = item
            self._enqueue(STREAM, item, ordered=False)
            return
        self._enqueue(STREAM, _Item(plaintext, barrier=self._ordered_seq), ordered=False)

    def release_reservation(self, reserved: int) -> None:
        """Give back an unused ordering slot (the frame will not be sent)."""
        if reserved:
            self._ordered_done.add(reserved)
            self._wakeup.set()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._task.cancel()
        for lane in self._lanes:
            while lane:
                item = lane.popleft()
                if item.future is not None and not item.future.done():
                    item.future.cancel()
        self._stream_placeholders.clear()
        for event in self._space:
            event.set()

    # ── Scheduling ────────────────────────────────────────────────────────

    def _soft_budget(self, lane: int) -> int | None:
        if lane == STATE:
            return self.budgets.state_soft
        if lane == BULK:
            return self.budgets.bulk_soft
        if lane == STREAM:
            return self.budgets.stream
        return None

    def _reserve_ordered(self) -> int:
        self._ordered_seq += 1
        self._ordered_pending.append(self._ordered_seq)
        return self._ordered_seq

    def _enqueue(self, lane: int, item: _Item, *, ordered: bool) -> None:
        if ordered:
            item.ordered = self._reserve_ordered()
        self._lanes[lane].append(item)
        self._bytes[lane] += item.size
        if self._bytes[lane] > self.stats["peak_bytes"][lane]:
            self.stats["peak_bytes"][lane] = self._bytes[lane]
        self._wakeup.set()

    def _min_pending_ordered(self) -> int | None:
        pending = self._ordered_pending
        while pending and pending[0] in self._ordered_done:
            self._ordered_done.discard(pending.popleft())
        return pending[0] if pending else None

    def _eligible(self, lane: int) -> bool:
        queue = self._lanes[lane]
        if not queue:
            return False
        if lane != STREAM:
            return True
        barrier = queue[0].barrier
        oldest = self._min_pending_ordered()
        if oldest is None:
            return True
        if barrier == _BARRIER_ALL:
            return False
        return oldest > barrier

    def _pick(self) -> int | None:
        if self._lanes[CONTROL]:
            return CONTROL
        eligible = [lane for lane in _ROUND_ROBIN if self._eligible(lane)]
        if not eligible:
            return None
        if len(eligible) == 1:
            return eligible[0]
        # Deficit round robin by bytes. Bounded loop; a huge head item simply
        # accumulates credit over several rounds of competing traffic.
        for _ in range(4096):
            lane = _ROUND_ROBIN[self._rr]
            if lane in eligible:
                head = self._lanes[lane][0]
                if head.size <= self._deficit[lane]:
                    self._deficit[lane] -= head.size
                    return lane
                self._deficit[lane] += _QUANTUM * _WEIGHTS[lane]
            else:
                self._deficit[lane] = 0
            self._rr = (self._rr + 1) % len(_ROUND_ROBIN)
        return eligible[0]

    async def _drain(self) -> None:
        while True:
            lane = self._pick()
            if lane is None:
                self._wakeup.clear()
                await self._wakeup.wait()
                continue
            item = self._lanes[lane].popleft()
            self._bytes[lane] -= item.size
            soft = self._soft_budget(lane)
            if soft is None or self._bytes[lane] <= soft:
                self._space[lane].set()
            if item.key is not None and self._stream_placeholders.get(item.key) is item:
                self._stream_placeholders.pop(item.key, None)
            try:
                plaintext = item.plaintext
                if plaintext is None and item.build is not None:
                    message = item.build()
                    plaintext = self._encode(message) if message is not None else None
                if plaintext is not None:
                    await self._transmit(plaintext)
                    self.stats["sent_bytes"][lane] += len(plaintext)
                    self.stats["sent_messages"][lane] += 1
            except asyncio.CancelledError:
                if item.future is not None and not item.future.done():
                    item.future.cancel()
                raise
            except Exception as exc:
                if item.future is not None and not item.future.done():
                    item.future.set_exception(exc)
                elif item.future is None:
                    logger.debug("General WS push failed", exc_info=True)
            else:
                if item.future is not None and not item.future.done():
                    item.future.set_result(None)
            finally:
                if item.ordered:
                    self._ordered_done.add(item.ordered)


# ── Ingress admission ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AdmissionClass:
    name: str
    active: int
    queued: int
    queued_bytes: int


class Admission:
    """Bounded handler execution: admission happens *before* task creation.

    Each class owns its own active slots and its own bounded waiting room, so
    a flood of bulk/generic RPCs can never occupy the capacity reserved for
    control traffic. Waiting requests are stored as plain callables, not as
    parked tasks.
    """

    def __init__(self, classes: list[AdmissionClass]) -> None:
        self.classes = {item.name: item for item in classes}
        self._active = {item.name: 0 for item in classes}
        self._waiting: dict[str, deque[tuple[Callable[[], Awaitable[None]], int]]] = {
            item.name: deque() for item in classes
        }
        self._waiting_bytes = {item.name: 0 for item in classes}
        self.tasks: set[asyncio.Task] = set()
        self.rejected = {item.name: 0 for item in classes}
        self._closed = False

    def submit(self, name: str, factory: Callable[[], Awaitable[None]], size: int = 0, label: str = "") -> bool:
        if self._closed:
            return False
        spec = self.classes[name]
        if self._active[name] < spec.active:
            self._start(name, factory, label)
            return True
        if len(self._waiting[name]) >= spec.queued or self._waiting_bytes[name] + size > spec.queued_bytes:
            self.rejected[name] += 1
            return False
        self._waiting[name].append((factory, size))
        self._waiting_bytes[name] += size
        return True

    def _start(self, name: str, factory: Callable[[], Awaitable[None]], label: str) -> None:
        self._active[name] += 1
        task = asyncio.create_task(factory(), name=f"general-ws:{label or name}")
        self.tasks.add(task)

        def done(finished: asyncio.Task) -> None:
            self.tasks.discard(finished)
            self._active[name] -= 1
            if self._closed:
                return
            waiting = self._waiting[name]
            if waiting and self._active[name] < self.classes[name].active:
                next_factory, size = waiting.popleft()
                self._waiting_bytes[name] -= size
                self._start(name, next_factory, name)

        task.add_done_callback(done)

    def snapshot(self) -> dict[str, Any]:
        return {
            name: {
                "active": self._active[name],
                "waiting": len(self._waiting[name]),
                "waiting_bytes": self._waiting_bytes[name],
                "rejected": self.rejected[name],
            }
            for name in self.classes
        }

    async def close(self) -> None:
        self._closed = True
        for waiting in self._waiting.values():
            waiting.clear()
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


# ── Event-loop lag ────────────────────────────────────────────────────────────

class LoopLagMonitor:
    """Measures how late the loop wakes a periodic timer (service delay)."""

    INTERVAL = 0.25

    def __init__(self) -> None:
        self.last = 0.0
        self.peak = 0.0
        self.ewma = 0.0
        self.samples = 0
        self._task: asyncio.Task | None = None

    def ensure_started(self) -> None:
        if self._task is not None and not self._task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._task = loop.create_task(self._run(), name="vulcan-loop-lag")

    async def _run(self) -> None:
        while True:
            started = time.perf_counter()
            await asyncio.sleep(self.INTERVAL)
            lag = max(0.0, time.perf_counter() - started - self.INTERVAL)
            self.last = lag
            self.peak = max(self.peak, lag)
            self.ewma = lag if not self.samples else self.ewma * 0.9 + lag * 0.1
            self.samples += 1
            if lag >= 0.5:
                logger.warning("Event loop lag %.3fs", lag)

    def snapshot(self) -> dict[str, float]:
        return {"last_ms": self.last * 1000, "peak_ms": self.peak * 1000, "ewma_ms": self.ewma * 1000}


LOOP_LAG = LoopLagMonitor()
