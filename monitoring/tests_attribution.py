"""Who answered - stamped on every result and status change.

Three engines fold results through one path, and until now the rows could
not say which one saw the host go down. The stamp is the *executing* engine,
which is not the binding: a ping on a Zabbix-bound device is run by the
core's own workers, and its rows have to say so.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant
from danbyte_checks.base import CheckOutcome

from .engines import SOURCE_EXPR, STAMPED_SOURCE_EXPR, executing_engine, source_of
from .models import (
    CheckResult,
    CheckState,
    CheckTemplate,
    MonitoringEngine,
    StateTransition,
)
from .worker import _finalise, ingest_results


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.1", prefix=self.prefix
        )
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind="icmp", interval_seconds=60,
            rise=1, fall=1,
        )
        self.zbx_tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="Zabbix", slug="zbx", kind="zabbix",
            interval_seconds=300, rise=1, fall=1,
        )
        self.outpost = MonitoringEngine.objects.create(
            tenant=self.tenant, name="Aarhus", slug="aarhus", kind="remote"
        )
        self.zabbix = MonitoringEngine.objects.create(
            tenant=self.tenant, name="db-zabbix", slug="zbx", kind="zabbix"
        )

    def state(self, template, engine=None, status="up"):
        return CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=template, engine=engine,
            kind=template.kind, interval_seconds=60, status=status,
            next_run=timezone.now(),
        )


class StampTests(_Base):
    def test_an_outpost_result_and_transition_carry_the_outpost(self):
        st = self.state(self.ping, engine=self.outpost, status="up")
        st.in_flight = True
        st.save(update_fields=["in_flight"])
        ingest_results(
            {str(st.id): CheckOutcome("down", 12.0, {})},
            engine_id=self.outpost.id, tenant_id=self.tenant.id,
        )
        result = CheckResult.objects.get(target_ip=self.ip)
        transition = StateTransition.objects.get(target_ip=self.ip)
        self.assertEqual(result.engine_id, self.outpost.id)
        self.assertEqual(transition.engine_id, self.outpost.id)
        self.assertEqual(transition.to_status, "down")

    def test_a_local_run_leaves_the_engine_null(self):
        st = self.state(self.ping, status="up")
        _finalise([st], [CheckOutcome("down", 5.0, {})], {})
        self.assertIsNone(CheckResult.objects.get().engine_id)
        self.assertIsNone(StateTransition.objects.get().engine_id)

    def test_the_stamp_is_the_executor_not_the_binding(self):
        """A ping on a Zabbix-bound device is run locally; its rows say so
        even though the state is bound to the Zabbix engine."""
        st = self.state(self.ping, engine=self.zabbix, status="up")
        _finalise([st], [CheckOutcome("down", 5.0, {})], {})   # the local path
        self.assertIsNone(CheckResult.objects.get().engine_id)


class SourceTests(_Base):
    def test_source_words(self):
        self.assertEqual(source_of(None), "local")
        self.assertEqual(source_of(MonitoringEngine.local_for(self.tenant)), "local")
        self.assertEqual(source_of(self.outpost), "outpost")
        self.assertEqual(source_of(self.zabbix), "zabbix")

    def test_executing_engine_follows_the_claim_rule(self):
        ping_on_zbx = self.state(self.ping, engine=self.zabbix)
        zbx_on_zbx = self.state(self.zbx_tmpl, engine=self.zabbix)
        self.assertIsNone(executing_engine(ping_on_zbx))
        self.assertEqual(executing_engine(zbx_on_zbx), self.zabbix)
        on_outpost = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, engine=self.outpost, kind="icmp",
            template=CheckTemplate.objects.create(
                tenant=self.tenant, name="P2", slug="p2", kind="icmp",
                interval_seconds=60,
            ),
            interval_seconds=60, next_run=timezone.now(),
        )
        self.assertEqual(executing_engine(on_outpost), self.outpost)

    def test_the_timeline_says_who_runs_each_check(self):
        """The strip's label is the executor: a ping on a Zabbix-bound address
        is the core's own, and must not read as Zabbix beside a table that
        says Local."""
        self.state(self.ping, engine=self.zabbix)
        self.state(self.zbx_tmpl, engine=self.zabbix)
        user = get_user_model().objects.create_superuser("root", "r@b.c", "pw")
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()
        r = self.client.get(f"/api/monitoring/ips/{self.ip.id}/timeline/?days=1")
        self.assertEqual(r.status_code, 200, r.content)
        by_kind = {c["kind"]: c["source"] for c in r.json()["checks"]}
        self.assertEqual(by_kind, {"icmp": "local", "zabbix": "zabbix"})

    def test_the_annotation_agrees_with_the_python(self):
        self.state(self.ping, engine=self.zabbix)
        self.state(self.zbx_tmpl, engine=self.zabbix)
        rows = {
            r["kind"]: r["source"]
            for r in CheckState.objects.annotate(source=SOURCE_EXPR).values("kind", "source")
        }
        self.assertEqual(rows, {"icmp": "local", "zabbix": "zabbix"})

    def test_a_pre_attribution_transition_reads_as_local(self):
        StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
            from_status="up", to_status="down",
        )
        [src] = StateTransition.objects.annotate(source=STAMPED_SOURCE_EXPR).values_list(
            "source", flat=True
        )
        self.assertEqual(src, "local")


class ApiTests(_Base):
    def setUp(self):
        super().setUp()
        user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_the_checks_list_says_and_filters_the_source(self):
        self.state(self.ping, engine=self.zabbix)      # runs locally
        self.state(self.zbx_tmpl, engine=self.zabbix)  # answered by Zabbix
        r = self.client.get("/api/monitoring/checks/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["source_counts"], {"local": 1, "zabbix": 1})
        by_kind = {row["kind"]: row for row in body["results"]}
        self.assertEqual(by_kind["icmp"]["source"], "local")
        self.assertEqual(by_kind["zabbix"]["source"], "zabbix")
        self.assertEqual(by_kind["zabbix"]["engine"]["name"], "db-zabbix")
        r = self.client.get("/api/monitoring/checks/?source=zabbix")
        self.assertEqual([row["kind"] for row in r.json()["results"]], ["zabbix"])
        r = self.client.get(f"/api/monitoring/checks/?engine={self.zabbix.id}&source=local")
        self.assertEqual([row["kind"] for row in r.json()["results"]], ["icmp"])

    def test_history_rows_carry_source(self):
        st = self.state(self.ping, engine=self.outpost, status="up")
        st.in_flight = True
        st.save(update_fields=["in_flight"])
        ingest_results(
            {str(st.id): CheckOutcome("down", 1.0, {})},
            engine_id=self.outpost.id, tenant_id=self.tenant.id,
        )
        r = self.client.get(f"/api/monitoring/ips/{self.ip.id}/history/")
        self.assertEqual(r.status_code, 200, r.content)
        [row] = r.json()["results"] if "results" in r.json() else r.json()
        self.assertEqual(row["source"], "outpost")
        self.assertEqual(row["engine"]["name"], "Aarhus")
        stats = self.client.get("/api/monitoring/stats/").json()
        self.assertEqual(stats["recent_transitions"][0]["source"], "outpost")
