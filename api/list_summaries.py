"""Stored list summaries (#527, #535): derived rows the big lists page, filter,
facet and sort on in SQL.

A summary *kind* (``mac``: :mod:`api.mac_summary`; ``port``:
:mod:`api.port_stats`) registers three things here:

* ``refresh(tenant, keys)`` - rebuild those rows from their sources, the
  ground truth; only rows that differ are written. Never a delta.
* ``build_batch(tenant, cursor, limit)`` - the next ``limit`` keys of a full
  build after ``cursor`` rebuilt (rows no source names any more dropped):
  keys walked, rows written, and the new cursor (``None`` when done). What
  the backfill and the reconcile walk; the rows written are the drift.
* ``check(tenant)`` - the drift: how many rows differ from their sources.

**Writers mark, readers and jobs rebuild.** Every write that can change a
summary row calls :func:`touch` (or :func:`touch_query` for a set computed in
SQL) - the model signals in :mod:`api.summary_hooks`, and the bulk paths that
skip them by hand. A mark is a :class:`~api.models.ListSummaryDirty` row
written in the writer's own transaction: a rolled-back write leaves none, a
committed one is never lost. On commit a debounced job on RQ ``low`` works
the tenant's marks off; the list itself also works off up to
:data:`READ_FLUSH` marks before it reads, so a page shows the write that
was just made. Past that the list answers what is stored and says it is
``updating``.

**Builds.** A tenant whose summary was never built (an upgrade, a new kind)
has no :class:`~api.models.ListSummaryState` ``built_at``: the list reads
the rows stored so far and says it is ``building``. A small tenant is built
on the spot; a big one by the job - batched, each batch its own
transaction, the cursor saved after each, so an interrupted build resumes.
``manage.py list_summaries`` runs builds and the reconcile by hand; the
nightly search-reindex unit (and the end of every upgrade) runs it too.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterable
from contextlib import contextmanager
from dataclasses import dataclass

from django.db import connection, transaction
from django.utils import timezone

log = logging.getLogger(__name__)

QUEUE = "low"
JOB_TIMEOUT = 6 * 3600
DEBOUNCE_SECONDS = 30
#: Marks the list works off itself before it reads.
READ_FLUSH = 2000
#: Marks one job transaction works off.
FLUSH_BATCH = 5000
#: Keys one build batch covers.
BUILD_BATCH = 5000


@dataclass(frozen=True)
class Kind:
    name: str
    refresh: Callable  # (tenant, keys) -> rows written
    #: (tenant, cursor, limit) -> (keys walked, rows written, next cursor | None)
    build_batch: Callable
    check: Callable  # (tenant) -> rows that differ
    #: ``(tenant) -> bool``: small enough to build inline on first read.
    small: Callable


_KINDS: dict[str, Kind] = {}


def register(kind: Kind) -> None:
    _KINDS[kind.name] = kind


def kinds() -> dict[str, Kind]:
    _load()
    return dict(_KINDS)


def _load() -> None:
    # The kinds register on import.
    from . import mac_summary  # noqa: F401
    try:
        from . import port_stats  # noqa: F401
    except ImportError:  # pragma: no cover - partial checkouts
        pass


def _kind(name: str) -> Kind:
    _load()
    return _KINDS[name]


# ─── marks ───────────────────────────────────────────────────────────────────


_local = threading.local()


@contextmanager
def batched():
    """Collect the marks made inside the block and write them in one
    statement when it ends - a bulk path that saves or deletes row by row
    (the MAC list's bulk remove) pays one insert, not one per row."""
    outer = getattr(_local, "buffer", None)
    if outer is not None:
        yield
        return
    _local.buffer = buf = {}
    try:
        yield
    finally:
        _local.buffer = None
    for (kind, tenant_id), keys in buf.items():
        touch(kind, tenant_id, keys)


def touch(kind: str, tenant_id, keys: Iterable) -> None:
    """Mark ``keys`` of ``kind`` in ``tenant_id`` for a rebuild, in the
    caller's transaction, and queue the job for after it commits."""
    from .models import ListSummaryDirty

    if tenant_id is None:
        return
    wanted = {str(k) for k in keys if k not in (None, "")}
    if not wanted:
        return
    buf = getattr(_local, "buffer", None)
    if buf is not None:
        buf.setdefault((kind, tenant_id), set()).update(wanted)
        return
    ListSummaryDirty.objects.bulk_create(
        [ListSummaryDirty(tenant_id=tenant_id, kind=kind, key=k[:64]) for k in sorted(wanted)],
        ignore_conflicts=True, batch_size=2000,
    )
    _after_commit(kind, tenant_id)


def touch_query(kind: str, tenant_id, keys_qs) -> None:
    """:func:`touch` for the keys a ``values_list(flat=True)`` queryset
    selects - one ``INSERT … SELECT``, however many it names."""
    from django.core.exceptions import EmptyResultSet

    from .models import ListSummaryDirty

    if tenant_id is None:
        return
    try:
        sql, params = keys_qs.query.sql_with_params()
    except EmptyResultSet:
        return
    table = connection.ops.quote_name(ListSummaryDirty._meta.db_table)
    with connection.cursor() as cur:
        cur.execute(
            f"INSERT INTO {table} (tenant_id, kind, key) "
            f"SELECT DISTINCT %s, %s, LEFT(s.k::text, 64) FROM ({sql}) AS s(k) "
            f"WHERE s.k IS NOT NULL AND s.k::text <> '' "
            f"ON CONFLICT (tenant_id, kind, key) DO NOTHING",
            [tenant_id, kind, *params],
        )
    _after_commit(kind, tenant_id)


def _after_commit(kind: str, tenant_id) -> None:
    tid = str(tenant_id)
    transaction.on_commit(lambda: enqueue_flush(kind, tid))


def pending(kind: str, tenant_id) -> int:
    from .models import ListSummaryDirty

    return ListSummaryDirty.objects.filter(tenant_id=tenant_id, kind=kind).count()


def flush(kind: str, tenant, limit: int | None = None) -> int:
    """Work off ``tenant``'s marks of ``kind`` - at most ``limit`` (all when
    None) - in batches, each in its own transaction, the marks taken with
    ``SKIP LOCKED`` so two workers never rebuild the same key. Returns how
    many marks were worked off."""
    from .models import ListSummaryDirty

    k = _kind(kind)
    done = 0
    while limit is None or done < limit:
        size = FLUSH_BATCH if limit is None else min(FLUSH_BATCH, limit - done)
        with transaction.atomic():
            marks = list(
                ListSummaryDirty.objects.select_for_update(skip_locked=True)
                .filter(tenant_id=tenant.pk, kind=kind)
                .order_by("id").values_list("id", "key")[:size]
            )
            if not marks:
                break
            k.refresh(tenant, [key for _, key in marks])
            ListSummaryDirty.objects.filter(id__in=[i for i, _ in marks]).delete()
        done += len(marks)
        if len(marks) < size:
            break
    return done


# ─── builds ──────────────────────────────────────────────────────────────────


def state(kind: str, tenant):
    from .models import ListSummaryState

    st, _ = ListSummaryState.objects.get_or_create(tenant=tenant, kind=kind)
    return st


def is_built(kind: str, tenant) -> bool:
    from .models import ListSummaryState

    return ListSummaryState.objects.filter(
        tenant=tenant, kind=kind, built_at__isnull=False
    ).exists()


def build(kind: str, tenant, *, restart: bool = False, batch: int = BUILD_BATCH,
          progress: Callable | None = None) -> tuple[int, int]:
    """A full build of ``tenant``'s ``kind``: every key, ``batch`` at a time,
    each batch its own transaction with the cursor saved after it - an
    interrupted build resumes from there (``restart`` starts over). Rows no
    source names any more are dropped on the way. Returns the keys walked
    and the rows written (on a built tenant: the drift it put right)."""
    k = _kind(kind)
    st = state(kind, tenant)
    if restart or st.built_at is not None or not st.started_at:
        st.cursor = ""
        st.started_at = timezone.now()
        st.save(update_fields=["cursor", "started_at"])
    cursor = st.cursor
    walked = written = 0
    while True:
        with transaction.atomic():
            n, w, nxt = k.build_batch(tenant, cursor, batch)
            walked += n
            written += w
            st.cursor = nxt or ""
            if nxt is None:
                st.built_at = timezone.now()
            st.save(update_fields=["cursor", "built_at"])
        if progress:
            progress(walked)
        if nxt is None:
            return walked, written
        cursor = nxt


def ensure(kind: str, tenant) -> dict:
    """What the list says about its summary before it reads: works off up
    to :data:`READ_FLUSH` marks, builds a small tenant on the spot, queues
    the build of a big one. ``{"building": bool, "updating": bool}``."""
    building = not is_built(kind, tenant)
    if building and _kind(kind).small(tenant):
        build(kind, tenant, restart=True)
        building = False
    elif building:
        enqueue_build(kind, tenant.pk)
    flush(kind, tenant, limit=READ_FLUSH)
    updating = pending(kind, tenant.pk) > 0
    if updating:
        enqueue_flush(kind, str(tenant.pk))
    return {"building": building, "updating": updating}


def reconcile(kind: str, tenant, *, fix: bool = True) -> int:
    """The rows that differ from their sources: counted (``fix=False``,
    nothing written) or put right by a full build that writes only them.
    An unfinished build resumes. Returns the drift."""
    flush(kind, tenant)
    if not fix:
        return _kind(kind).check(tenant)
    return build(kind, tenant)[1]


# ─── jobs ────────────────────────────────────────────────────────────────────


def _redis():
    import django_rq

    return django_rq.get_connection(QUEUE)


def _claim(key: str, seconds: int) -> bool:
    try:
        return bool(_redis().set(key, "1", nx=True, ex=seconds))
    except Exception:  # noqa: BLE001 - Redis down: no debounce
        return True


def _release(key: str) -> None:
    try:
        _redis().delete(key)
    except Exception:  # noqa: BLE001
        pass


def _push(func, *args) -> None:
    try:
        import django_rq

        django_rq.get_queue(QUEUE).enqueue(func, *args, job_timeout=JOB_TIMEOUT)
    except Exception:  # noqa: BLE001 - Redis down: the next read or the
        # nightly reconcile works the marks off.
        log.warning("RQ unavailable; %s waits for the next read", func.__name__)


def enqueue_flush(kind: str, tenant_id: str) -> None:
    if _claim(f"danbyte:summary:flush:{kind}:{tenant_id}", DEBOUNCE_SECONDS):
        _push(run_flush, kind, str(tenant_id))


def enqueue_build(kind: str, tenant_id) -> None:
    if _claim(f"danbyte:summary:build:{kind}:{tenant_id}", JOB_TIMEOUT):
        _push(run_build, kind, str(tenant_id))


def _tenant(tenant_id):
    from core.models import Tenant

    return Tenant.objects.filter(pk=tenant_id).first()


def run_flush(kind: str, tenant_id: str) -> int:
    _release(f"danbyte:summary:flush:{kind}:{tenant_id}")
    tenant = _tenant(tenant_id)
    if tenant is None:
        return 0
    return flush(kind, tenant)


def run_build(kind: str, tenant_id: str) -> int:
    try:
        tenant = _tenant(tenant_id)
        if tenant is None:
            return 0
        n = build(kind, tenant)[0]
        flush(kind, tenant)
        return n
    finally:
        _release(f"danbyte:summary:build:{kind}:{tenant_id}")
