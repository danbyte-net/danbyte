"""Milestone 3 tests — hysteresis state machine, materialisation, dispatch."""
from __future__ import annotations

import socket

from django.utils import timezone
from django.test import TestCase

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

from .checkers import CheckOutcome
from .models import (
    CheckAssignment,
    CheckKind,
    CheckResult,
    CheckState,
    CheckStatus,
    StateTransition,
)
from .scheduler import dispatch, materialise_ip, materialise_states
from .state import apply_outcome


from api.test_utils import status_for


def _free_loopback_listener():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    s.listen(8)
    return s, s.getsockname()[1]


class Base(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="127.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="127.0.0.1", prefix=self.prefix
        )

    def _state(self, template, **kw):
        return CheckState.objects.create(
            tenant=self.tenant,
            target_ip=self.ip,
            template=template,
            kind=template.kind,
            **kw,
        )

    def _tmpl(self, **kw):
        kw.setdefault("name", f"t{kw.get('slug','x')}")
        kw.setdefault("slug", kw["name"])
        kw.setdefault("kind", CheckKind.ICMP)
        return __import__("monitoring.models", fromlist=["CheckTemplate"]).CheckTemplate.objects.create(
            tenant=self.tenant, **kw
        )


class StateMachineTests(Base):
    def test_rise_requires_consecutive_successes(self):
        t = self._tmpl(slug="rise", rise=2, fall=2)
        st = self._state(t, status=CheckStatus.DOWN)
        now = timezone.now()
        # first success: not enough to rise yet
        tr = apply_outcome(st, rise=2, fall=2, outcome=CheckOutcome("up", 1.0), now=now)
        self.assertIsNone(tr)
        self.assertEqual(st.status, "down")
        # second success: rise
        tr = apply_outcome(st, rise=2, fall=2, outcome=CheckOutcome("up", 1.0), now=now)
        self.assertIsNotNone(tr)
        self.assertEqual((tr.from_status, tr.to_status), ("down", "up"))
        self.assertEqual(st.status, "up")

    def test_fall_requires_consecutive_failures(self):
        t = self._tmpl(slug="fall", rise=1, fall=3)
        st = self._state(t, status=CheckStatus.UP)
        now = timezone.now()
        for _ in range(2):
            tr = apply_outcome(st, rise=1, fall=3, outcome=CheckOutcome("down"), now=now)
            self.assertIsNone(tr)
            self.assertEqual(st.status, "up")
        tr = apply_outcome(st, rise=1, fall=3, outcome=CheckOutcome("down"), now=now)
        self.assertEqual(st.status, "down")
        self.assertEqual((tr.from_status, tr.to_status), ("up", "down"))

    def test_degraded_surfaces_immediately(self):
        t = self._tmpl(slug="deg", rise=5, fall=5)
        st = self._state(t, status=CheckStatus.UP)
        tr = apply_outcome(
            st, rise=5, fall=5, outcome=CheckOutcome("degraded", 50.0), now=timezone.now()
        )
        self.assertEqual(st.status, "degraded")
        self.assertEqual(tr.to_status, "degraded")

    def test_unknown_does_not_flip_up_to_down(self):
        t = self._tmpl(slug="unk", rise=1, fall=1)
        st = self._state(t, status=CheckStatus.UP)
        tr = apply_outcome(
            st, rise=1, fall=1, outcome=CheckOutcome.unknown("boom"), now=timezone.now()
        )
        self.assertIsNone(tr)
        self.assertEqual(st.status, "up")
        self.assertEqual(st.consecutive_fail, 0)

    def test_first_success_from_unknown_rises(self):
        t = self._tmpl(slug="first", rise=1, fall=3)
        st = self._state(t)  # default status unknown
        tr = apply_outcome(st, rise=1, fall=3, outcome=CheckOutcome("up", 2.0), now=timezone.now())
        self.assertEqual(st.status, "up")
        self.assertEqual((tr.from_status, tr.to_status), ("unknown", "up"))


class MaterialiseTests(Base):
    def test_prefix_assignment_materialises_child_state(self):
        t = self._tmpl(slug="m")
        CheckAssignment.objects.create(tenant=self.tenant, template=t, prefix=self.prefix)
        n = materialise_ip(self.ip)
        self.assertEqual(n, 1)
        self.assertTrue(CheckState.objects.filter(target_ip=self.ip, template=t).exists())

    def test_materialise_deletes_stale_state(self):
        t = self._tmpl(slug="stale")
        a = CheckAssignment.objects.create(
            tenant=self.tenant, template=t, ip_address=self.ip
        )
        materialise_ip(self.ip)
        self.assertEqual(CheckState.objects.filter(target_ip=self.ip).count(), 1)
        a.delete()  # no longer effective
        materialise_ip(self.ip)
        self.assertEqual(CheckState.objects.filter(target_ip=self.ip).count(), 0)

    def test_materialise_states_counts(self):
        t = self._tmpl(slug="all")
        CheckAssignment.objects.create(tenant=self.tenant, template=t, ip_address=self.ip)
        result = materialise_states(tenant=self.tenant)
        self.assertEqual(result["effective_checks"], 1)


class DispatchTests(Base):
    def test_dispatch_runs_tcp_and_updates_state(self):
        listener, port = _free_loopback_listener()
        try:
            t = self._tmpl(slug="tcp", kind=CheckKind.TCP, params={"port": port}, rise=1)
            CheckAssignment.objects.create(
                tenant=self.tenant, template=t, ip_address=self.ip
            )
            materialise_states(tenant=self.tenant)
            out = dispatch(sync=True)
            self.assertEqual(out["due"], 1)
            self.assertGreaterEqual(out["jobs"], 1)

            st = CheckState.objects.get(target_ip=self.ip, template=t)
            self.assertEqual(st.status, "up")
            self.assertFalse(st.in_flight)
            self.assertIsNotNone(st.next_run)
            self.assertIsNotNone(st.last_checked)
            self.assertEqual(CheckResult.objects.filter(target_ip=self.ip).count(), 1)
            self.assertEqual(
                StateTransition.objects.filter(target_ip=self.ip, to_status="up").count(),
                1,
            )
        finally:
            listener.close()

    def test_dispatch_icmp_sweep(self):
        t = self._tmpl(slug="icmp", kind=CheckKind.ICMP, rise=1)
        CheckAssignment.objects.create(tenant=self.tenant, template=t, ip_address=self.ip)
        materialise_states(tenant=self.tenant)
        dispatch(sync=True)
        st = CheckState.objects.get(target_ip=self.ip, template=t)
        self.assertIn(st.status, ("up", "unknown"))  # loopback reachable, or no priv
        self.assertEqual(CheckResult.objects.filter(target_ip=self.ip).count(), 1)

    def test_nothing_due_is_noop(self):
        self.assertEqual(dispatch(sync=True), {"due": 0, "jobs": 0, "reaped": 0})

    def test_in_flight_states_not_redispatched(self):
        from django.utils import timezone

        t = self._tmpl(slug="busy", kind=CheckKind.TCP, params={"port": 9})
        CheckAssignment.objects.create(tenant=self.tenant, template=t, ip_address=self.ip)
        materialise_states(tenant=self.tenant)
        # Freshly claimed (recent in_flight_since) — not stale, so not reaped.
        CheckState.objects.update(in_flight=True, in_flight_since=timezone.now())
        self.assertEqual(dispatch(sync=True)["due"], 0)

    def test_reaper_reclaims_stale_in_flight(self):
        from datetime import timedelta
        from django.utils import timezone

        from .scheduler import reap_stale_in_flight

        t = self._tmpl(slug="stuck", kind=CheckKind.TCP, params={"port": 9})
        CheckAssignment.objects.create(tenant=self.tenant, template=t, ip_address=self.ip)
        materialise_states(tenant=self.tenant)
        old = timezone.now() - timedelta(hours=1)
        CheckState.objects.update(in_flight=True, in_flight_since=old)

        # A worker that died an hour ago leaves these claimed forever; the
        # reaper releases them and makes them due again.
        self.assertEqual(reap_stale_in_flight()["reaped"], 1)
        st = CheckState.objects.get()
        self.assertFalse(st.in_flight)
        self.assertIsNone(st.in_flight_since)
        self.assertEqual(dispatch(sync=True)["due"], 1)

    def test_reaper_reclaims_null_in_flight_since(self):
        # Rows claimed before the field existed have a NULL timestamp — always
        # treated as stale so legacy stuck states self-heal.
        from .scheduler import reap_stale_in_flight

        t = self._tmpl(slug="legacy", kind=CheckKind.TCP, params={"port": 9})
        CheckAssignment.objects.create(tenant=self.tenant, template=t, ip_address=self.ip)
        materialise_states(tenant=self.tenant)
        CheckState.objects.update(in_flight=True, in_flight_since=None)
        self.assertEqual(reap_stale_in_flight()["reaped"], 1)
        self.assertFalse(CheckState.objects.get().in_flight)

    def test_reaper_leaves_fresh_in_flight_alone(self):
        from django.utils import timezone

        from .scheduler import reap_stale_in_flight

        t = self._tmpl(slug="fresh", kind=CheckKind.TCP, params={"port": 9})
        CheckAssignment.objects.create(tenant=self.tenant, template=t, ip_address=self.ip)
        materialise_states(tenant=self.tenant)
        CheckState.objects.update(in_flight=True, in_flight_since=timezone.now())
        self.assertEqual(reap_stale_in_flight()["reaped"], 0)
        self.assertTrue(CheckState.objects.get().in_flight)
