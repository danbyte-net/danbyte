"""Claiming due checks: exactly one dispatcher runs each, "Check now" leaves a
running check alone, and a superseded job cannot overwrite a newer result
(#220, #221)."""
from __future__ import annotations

import threading
from datetime import timedelta
from unittest import mock

from django.db import connection
from django.test import TransactionTestCase
from django.utils import timezone

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant

from .checkers import CheckOutcome
from .models import CheckKind, CheckState, CheckTemplate
from .scheduler import claim_states


class _Base(TransactionTestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="192.0.2.0/24",
            status=status_for(self.tenant, "container"),
        )
        self.tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="tcp", slug="tcp", kind=CheckKind.TCP,
            params={"port": 22}, fall=1, rise=1,
        )
        self.states = []
        for i in range(1, 5):
            ip = IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"192.0.2.{i}", prefix=prefix
            )
            self.states.append(CheckState.objects.create(
                tenant=self.tenant, target_ip=ip, template=self.tmpl, kind="tcp",
                next_run=timezone.now() - timedelta(seconds=5),
            ))


class ClaimTests(_Base):
    def test_two_dispatchers_holding_the_same_due_list_split_it(self):
        """Both selected the rows before either claimed - the race in #221."""
        now = timezone.now()
        first = list(CheckState.objects.filter(in_flight=False))
        second = list(CheckState.objects.filter(in_flight=False))

        won_a = claim_states(first, now)
        won_b = claim_states(second, now)

        self.assertEqual(len(won_a), 4)
        self.assertEqual(won_b, [])
        self.assertEqual(CheckState.objects.filter(in_flight=True).count(), 4)

    def test_concurrent_claims_never_hand_a_row_out_twice(self):
        now = timezone.now()
        results: dict[int, list] = {}
        barrier = threading.Barrier(2)

        def worker(n):
            try:
                due = list(CheckState.objects.filter(in_flight=False))
                barrier.wait()
                results[n] = [s.id for s in claim_states(due, now)]
            finally:
                connection.close()

        threads = [threading.Thread(target=worker, args=(n,)) for n in (1, 2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        a, b = set(results[1]), set(results[2])
        self.assertEqual(a & b, set(), "a check was claimed by both dispatchers")
        self.assertEqual(len(a | b), 4)


class CheckNowTests(_Base):
    def setUp(self):
        super().setUp()
        from django.contrib.auth import get_user_model
        from rest_framework.test import APIClient

        self.client = APIClient()
        user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_a_running_check_is_left_alone(self):
        running = self.states[0]
        claimed = timezone.now() - timedelta(seconds=2)
        CheckState.objects.filter(pk=running.pk).update(
            in_flight=True, in_flight_since=claimed
        )
        # Materialising would rebuild the target's checks from its policy;
        # this state is hand-made, and the arming is what is under test.
        with mock.patch("monitoring.scheduler.dispatch", return_value={"jobs": 0}), \
                mock.patch("monitoring.scheduler.materialise_ip"):
            r = self.client.post(
                "/api/monitoring/bulk-check-now/",
                {"ip_ids": [str(running.target_ip_id)]}, format="json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["checks"], 0)
        self.assertEqual(r.json()["already_running"], 1)
        running.refresh_from_db()
        self.assertTrue(running.in_flight)
        self.assertEqual(running.in_flight_since, claimed)


class WriteGuardTests(_Base):
    def test_a_superseded_job_does_not_overwrite_the_newer_result(self):
        from .worker import _finalise, _load_settings

        now = timezone.now()
        [state] = claim_states([self.states[0]], now)
        stale_copy = CheckState.objects.get(pk=state.pk)  # what job A holds

        # The reaper gave up on job A; job B reclaimed the row and finished.
        later = now + timedelta(minutes=5)
        CheckState.objects.filter(pk=state.pk).update(
            in_flight=True, in_flight_since=later
        )
        b_copy = CheckState.objects.get(pk=state.pk)
        settings_map = _load_settings({self.tenant.id})
        _finalise([b_copy], [CheckOutcome("down")], settings_map)

        # Job A's slow probe comes back "up" and tries to write.
        _finalise([stale_copy], [CheckOutcome("up")], settings_map)

        state.refresh_from_db()
        self.assertEqual(state.status, "down")
