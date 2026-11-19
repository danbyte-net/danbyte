"""Two maintenance passes at once write one period.

Real transactions and real threads, each on its own database session, so the
advisory lock is exercised the way a web process and an RQ worker meet it.
The Zabbix side is a fake that, like Zabbix, keeps names unique.
"""
from __future__ import annotations

import threading
import time

from django.db import connections
from django.test import TransactionTestCase

from . import maintenance
from .client import ZabbixError
from .models import ZabbixMaintenance
from .tests_two_way import _Base


class FakeZabbix:
    def __init__(self):
        self.periods: dict[str, str] = {}  # name -> id
        self.creates = 0
        self.lock = threading.Lock()

    def maintenances(self, ids):
        with self.lock:
            return {i: {"maintenanceid": i} for i in self.periods.values() if i in ids}

    def maintenances_by_name(self, names):
        with self.lock:
            return {
                n: {"maintenanceid": i, "name": n}
                for n, i in self.periods.items() if n in names
            }

    def create_maintenance(self, payload):
        # Slow enough that an unserialised second pass reads "nothing there"
        # before the first one's create lands.
        time.sleep(0.3)
        with self.lock:
            self.creates += 1
            if payload["name"] in self.periods:
                raise ZabbixError(f'Maintenance "{payload["name"]}" already exists.')
            mid = str(100 + len(self.periods))
            self.periods[payload["name"]] = mid
            return mid

    def update_maintenance(self, mid, payload):
        pass

    def delete_maintenances(self, ids):
        with self.lock:
            self.periods = {n: i for n, i in self.periods.items() if i not in ids}


class RaceTests(TransactionTestCase):
    setUp = _Base.setUp
    status = _Base.status
    device = _Base.device
    event = _Base.event

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()

    def test_two_concurrent_passes_create_one_period(self):
        ev = self.event(self.device(hostid="5"))
        zbx = FakeZabbix()
        results, start = [], threading.Barrier(2)

        def run():
            try:
                start.wait(5)
                conn = type(self.conn).objects.get(pk=self.conn.pk)
                results.append(maintenance.reconcile_locked(conn, client=zbx, wait=10))
            finally:
                connections.close_all()

        threads = [threading.Thread(target=run) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(20)

        self.assertEqual(zbx.creates, 1)
        self.assertEqual(len(zbx.periods), 1)
        self.assertEqual(sorted(r["created"] for r in results), [0, 1])
        row = ZabbixMaintenance.objects.get(event=ev)
        self.assertEqual(row.maintenanceid, zbx.periods[maintenance.period_name(ev)])
        self.assertEqual(row.last_error, "")
