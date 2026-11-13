"""The project's test runner.

One per-request value, the session idle timeout, is cached for a minute
(core.middleware). Inside a test the deployment-settings row does not exist
until something loads it, so the request that follows an expiry creates it -
nine extra queries - and whether that lands inside a measured request
depended on the wall clock. Tests that count queries failed at random on
long runs. Under test the value does not expire; tests that change the
setting clear it, as they already did.

Parallel runs (--parallel N): each worker process gets its own cache key
prefix. The prefix carries the runner's pid, and forked workers share it, so
without this one worker's cached values leaked into another's tests; and
cache.clear() there removes only that worker's keys, not the Redis database.
A module's tests run in one worker, longest modules first. Workers may start
processes of their own, as the PDF renders do, and a failure whose traceback
cannot be pickled (no tblib) reaches the runner as text instead of ending the
run. With --keepdb each worker's copy is still made fresh from the kept test
database.

Shards (CI): --shard K/N runs the K-th of N slices of the whole discovered
suite. Every test module lands in exactly one slice, balanced by the measured
seconds in danbyte/test_timings.json; a module missing from that file still
lands in a slice, with the median weight. --shard-check N prints the slices
and fails unless they are disjoint and together hold the whole suite.

--create-db-only migrates the test database and keeps it. The migration graph
takes about ten minutes to apply, so CI does it once, dumps the database and
every shard restores it and runs with --keepdb.

DANBYTE_TEST_TIMINGS=<file> writes the wall time spent per test module, class
setup and teardown included, as JSON - the source of danbyte/test_timings.json.
Under --parallel each module is timed in its worker.
"""
from __future__ import annotations

import json
import multiprocessing
import os
import pickle
import statistics
import sys
import time
import traceback
import unittest
from pathlib import Path

from django.test import TestCase, TransactionTestCase
from django.test import runner as django_runner
from django.test.runner import (
    DiscoverRunner,
    ParallelTestSuite,
    RemoteTestResult,
    RemoteTestRunner,
)

TIMINGS_FILE = Path(__file__).with_name("test_timings.json")


def _module_of(test) -> str:
    # A module that fails to import arrives as unittest.loader._FailedTest.
    return type(test).__module__


def _init_worker(counter, *args, **kwargs):
    django_runner._init_worker(counter, *args, **kwargs)
    worker = django_runner._worker_id
    # Pool workers are daemonic, and a daemonic process may not start one:
    # the PDF renders fork a child to enforce their deadline (drawing_pdf).
    multiprocessing.current_process()._config["daemon"] = False
    from django.conf import settings
    from django.core.cache import caches

    for alias, conf in settings.CACHES.items():
        conf["KEY_PREFIX"] = f"{conf.get('KEY_PREFIX', '')}:w{worker}"
        # A cache the runner already opened keeps its prefix on the instance.
        caches[alias].key_prefix = conf["KEY_PREFIX"]
    _scope_cache_clear()


def _scope_cache_clear():
    """cache.clear() on django-redis is FLUSHDB: one worker's setUp emptied
    every other worker's cache mid-test (an alert flag gone, so it fired
    twice). In a worker it removes only the keys under its own prefix."""
    try:
        from django_redis.client.default import DefaultClient, glob_escape
    except ImportError:
        return

    def clear(self, client=None):
        client = client or self.get_client(write=True)
        keys = list(client.scan_iter(match=glob_escape(self._backend.key_prefix) + ":*",
                                     count=1000))
        for start in range(0, len(keys), 1000):
            client.delete(*keys[start:start + 1000])

    DefaultClient.clear = clear


def _run_subsuite(args):
    """Django's worker entry point, timed per test class when
    DANBYTE_TEST_TIMINGS is set; each worker keeps its own file."""
    path = os.environ.get("DANBYTE_TEST_TIMINGS")
    if not path:
        return django_runner._run_subsuite(args)
    # Read before the run: a suite drops each test once it has run.
    first = next(iter(django_runner.iter_test_cases(args[2])), None)
    start = time.perf_counter()
    out = django_runner._run_subsuite(args)
    if first is not None:
        mine = f"{path}.{os.getpid()}"
        try:
            data = json.loads(Path(mine).read_text())
        except (OSError, ValueError):
            data = {}
        mod = _module_of(first)
        data[mod] = data.get(mod, 0.0) + time.perf_counter() - start
        Path(mine).write_text(json.dumps(data))
    return out


class RemoteTestError(Exception):
    """An error from a worker whose traceback could not be pickled; its
    message is the formatted traceback."""


class RemoteTestFailure(AssertionError):
    """The same for a failed assertion, so it still counts as a failure."""


def _portable(err):
    """A worker sends each failure to the runner pickled, and a traceback only
    pickles with tblib, which is not a dependency: without it the first
    failing test stopped the whole run. Send such a failure as its text."""
    try:
        pickle.loads(pickle.dumps(err))
        return err
    except Exception:  # noqa: BLE001 - anything unpicklable is sent as text
        text = "".join(traceback.format_exception(*err))
        kind = RemoteTestFailure if issubclass(err[0], AssertionError) else RemoteTestError
        return (kind, kind(text), None)


class DanbyteRemoteTestResult(RemoteTestResult):
    def addError(self, test, err):
        super().addError(test, _portable(err))

    def addFailure(self, test, err):
        super().addFailure(test, _portable(err))

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, None if err is None else _portable(err))


class DanbyteRemoteTestRunner(RemoteTestRunner):
    resultclass = DanbyteRemoteTestResult


class DanbyteParallelTestSuite(ParallelTestSuite):
    init_worker = _init_worker
    run_subsuite = _run_subsuite
    runner_class = DanbyteRemoteTestRunner


class TimingResult(unittest.TextTestResult):
    """Charges the gap before each test (class/module setup, the previous
    class's teardown) and the test itself to the test's module."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._mark = time.perf_counter()
        self.module_seconds: dict[str, float] = {}

    def stopTest(self, test):
        super().stopTest(test)
        now = time.perf_counter()
        mod = _module_of(test)
        self.module_seconds[mod] = self.module_seconds.get(mod, 0.0) + now - self._mark
        self._mark = now

    def stopTestRun(self):
        super().stopTestRun()
        path = os.environ.get("DANBYTE_TEST_TIMINGS")
        if path:
            data = {k: round(v, 2) for k, v in sorted(self.module_seconds.items())}
            with open(path, "w") as fh:
                json.dump(data, fh, indent=1)
                fh.write("\n")


def partition(modules, shards: int, weights: dict[str, float]) -> list[list[str]]:
    """Longest-first greedy split of ``modules`` into ``shards`` slices.
    Deterministic: the same modules and weights give the same slices."""
    known = [weights[m] for m in modules if m in weights]
    default = statistics.median(known) if known else 1.0
    slices: list[list[str]] = [[] for _ in range(shards)]
    loads = [0.0] * shards
    for mod in sorted(set(modules), key=lambda m: (-weights.get(m, default), m)):
        i = min(range(shards), key=lambda k: (loads[k], k))
        slices[i].append(mod)
        loads[i] += weights.get(mod, default)
    return slices


def _load_weights() -> dict[str, float]:
    try:
        return json.loads(TIMINGS_FILE.read_text())
    except (OSError, ValueError):
        return {}


def _parse_shard(value: str) -> tuple[int, int]:
    k, _, n = value.partition("/")
    k, n = int(k), int(n)
    if not 1 <= k <= n:
        raise ValueError(f"--shard {value}: want K/N with 1 <= K <= N")
    return k, n


class DanbyteTestRunner(DiscoverRunner):
    parallel_test_suite = DanbyteParallelTestSuite

    def __init__(self, shard=None, shard_check=None, create_db_only=False, **kwargs):
        super().__init__(**kwargs)
        self.shard = _parse_shard(shard) if shard else None
        self.shard_check = shard_check
        self.create_db_only = create_db_only
        if self.shard:
            whole = self.test_suite

            def only_this_shard(tests):
                return whole(self._shard_filter(list(tests)))

            self.test_suite = only_this_shard

    @classmethod
    def add_arguments(cls, parser):
        super().add_arguments(parser)
        parser.add_argument(
            "--shard", metavar="K/N",
            help="Run only the K-th of N balanced slices of the discovered suite.",
        )
        parser.add_argument(
            "--shard-check", type=int, metavar="N",
            help="Verify that N slices cover the whole suite exactly once, then exit.",
        )
        parser.add_argument(
            "--create-db-only", action="store_true",
            help="Create and migrate the test database, keep it, and exit.",
        )

    def _slices(self, tests, shards):
        modules = sorted({_module_of(t) for t in tests})
        return partition(modules, shards, _load_weights())

    def _shard_filter(self, tests):
        k, n = self.shard
        mine = set(self._slices(tests, n)[k - 1])
        picked = [t for t in tests if _module_of(t) in mine]
        self.log(f"Shard {k}/{n}: {len(picked)} test(s) in {len(mine)} module(s).")
        return picked

    def get_resultclass(self):
        if os.environ.get("DANBYTE_TEST_TIMINGS") and self.parallel <= 1:
            return TimingResult
        return super().get_resultclass()

    def setup_test_environment(self, **kwargs):
        super().setup_test_environment(**kwargs)
        from core import middleware

        middleware._IDLE_CACHE_TTL = None  # no expiry: counts stop depending on time
        middleware.clear_idle_timeout_cache()

        # The per-user import/export type list (api.io_views, #488) is cached
        # for a minute in production. Tests change a user's roles and ask
        # again at once, and user ids repeat between runs on a kept Redis, so
        # under test it is not cached; its own test turns it on.
        from api import io_views

        io_views.IO_TYPES_TTL = 0

    def build_suite(self, test_labels=None, **kwargs):
        """Django's suite, partitioned for --parallel by module instead of by
        class: a module's classes share module-level state (a temporary
        MEDIA_ROOT one class's teardown removes, setUpModule), so they run in
        one worker. The longest modules go first so none starts last.
        TransactionTestCase classes still run after everything else, one
        subsuite each, because they leave their worker's database empty."""
        parallel, self.parallel = self.parallel, 1
        try:
            suite = super().build_suite(test_labels, **kwargs)
        finally:
            self.parallel = parallel
        if self.parallel > 1:
            subsuites = self._partition(list(django_runner.iter_test_cases(suite)))
            self.parallel = min(self.parallel, len(subsuites))
            if self.parallel > 1:
                suite = self.parallel_test_suite(
                    subsuites, self.parallel, self.failfast, self.debug_mode, self.buffer
                )
        return suite

    def _partition(self, tests) -> list[unittest.TestSuite]:
        by_module: dict[str, list] = {}
        transactional: list[list] = []
        for test in tests:
            if isinstance(test, TransactionTestCase) and not isinstance(test, TestCase):
                if transactional and type(transactional[-1][0]) is type(test):
                    transactional[-1].append(test)
                else:
                    transactional.append([test])
            else:
                by_module.setdefault(_module_of(test), []).append(test)
        modules = list(by_module)
        if not (self.shuffle is not False or self.reverse):
            weights = _load_weights()
            known = [weights[m] for m in modules if m in weights]
            default = statistics.median(known) if known else 1.0
            modules.sort(key=lambda m: -weights.get(m, default))
        return [unittest.TestSuite(by_module[m]) for m in modules] + [
            unittest.TestSuite(group) for group in transactional
        ]

    def setup_databases(self, **kwargs):
        if not (self.keepdb and self.parallel > 1):
            return super().setup_databases(**kwargs)
        # --keepdb keeps the test database, but each worker's copy is made
        # again from it: a kept copy carries what the last run left, and a
        # TransactionTestCase leaves it empty (no built-in groups).
        from django.db import connections

        patched = []
        for conn in connections.all(initialized_only=False):
            creation = conn.creation
            clone = creation._clone_test_db

            def fresh(suffix, verbosity, keepdb=False, _clone=clone):
                return _clone(suffix, verbosity, keepdb=False)

            creation._clone_test_db = fresh
            patched.append(creation)
        try:
            return super().setup_databases(**kwargs)
        finally:
            for creation in patched:
                del creation._clone_test_db

    def run_suite(self, suite, **kwargs):
        result = super().run_suite(suite, **kwargs)
        path = os.environ.get("DANBYTE_TEST_TIMINGS")
        if path and self.parallel > 1:
            merged: dict[str, float] = {}
            for part in Path(path).parent.glob(Path(path).name + ".*"):
                for mod, secs in json.loads(part.read_text()).items():
                    merged[mod] = merged.get(mod, 0.0) + secs
                part.unlink()
            data = {k: round(v, 2) for k, v in sorted(merged.items())}
            Path(path).write_text(json.dumps(data, indent=1) + "\n")
        return result

    def run_tests(self, test_labels, **kwargs):
        if self.shard_check:
            return self._check_shards(test_labels)
        if self.create_db_only:
            self.setup_test_environment()
            self.parallel = 1
            self.keepdb = True
            self.setup_databases(aliases={"default"}, serialized_aliases=set())
            self.teardown_test_environment()
            return 0
        return super().run_tests(test_labels, **kwargs)

    def _check_shards(self, test_labels) -> int:
        """Partition the full suite the way --shard does and prove every test
        runs exactly once. A failure is a CI configuration error."""
        self.parallel = 1
        tests = list(django_runner.iter_test_cases(self.build_suite(test_labels)))
        everything = {t.id() for t in tests}
        n = self.shard_check
        slices = self._slices(tests, n)
        weights = _load_weights()
        seen: dict[str, int] = {}
        problems = []
        for k, mods in enumerate(slices, 1):
            mine = set(mods)
            ids = {t.id() for t in tests if _module_of(t) in mine}
            for tid in ids:
                if tid in seen:
                    problems.append(f"{tid} in shards {seen[tid]} and {k}")
                seen[tid] = k
            est = sum(weights.get(m, 0.0) for m in mods)
            unknown = [m for m in mods if m not in weights]
            sys.stdout.write(
                f"shard {k}/{n}: {len(ids)} tests, {len(mods)} modules, "
                f"~{est:.0f}s measured, {len(unknown)} unmeasured\n"
            )
        missing = everything - set(seen)
        problems += [f"{tid} in no shard" for tid in sorted(missing)]
        for p in problems[:50]:
            sys.stdout.write(f"PROBLEM: {p}\n")
        sys.stdout.write(f"{len(everything)} tests, {len(seen)} assigned.\n")
        return 1 if problems else 0
