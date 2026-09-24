"""Circuits as SLA members, "all must be up" agreements, and the list
columns on circuits, sites and clusters."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    Cable,
    CableTermination,
    Circuit,
    CircuitTermination,
    Cluster,
    ClusterType,
    Interface,
    IPAddress,
    Provider,
)
from api.test_utils import status_for

from . import sla
from .models import CheckRollupDaily, CheckState, EventImpact, MaintenanceEvent, SlaMember
from .tests_sla import NOW, SEP, _Base

S = "/api/monitoring/sla-status/"


class _Circuit(_Base):
    def setUp(self):
        super().setUp()
        self.edge, self.edge_ip = self.device("edge1", 5)
        iface = Interface.objects.create(device=self.edge, name="Gi0/0")
        self.edge_ip.assigned_interface = iface
        self.edge_ip.save()
        prov = Provider.objects.create(tenant=self.tenant, name="Telco", slug="telco")
        self.circuit = Circuit.objects.create(tenant=self.tenant, cid="TEL-1", provider=prov)
        term = CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", site=self.site
        )
        cable = Cable.objects.create(tenant=self.tenant, type="cat6")
        CableTermination.objects.create(cable=cable, end="A", circuit_termination=term)
        CableTermination.objects.create(cable=cable, end="B", interface=iface)

    def add(self, otype, oid, **kw):
        return SlaMember.objects.create(
            tenant=self.tenant, agreement=self.agreement, group=self.group,
            object_type=otype, object_id=oid, joined_at=SEP - timedelta(days=30), **kw,
        )


class CircuitMemberTests(_Circuit):
    def test_a_circuit_reads_the_address_cabled_to_its_end(self):
        self.add("api.circuit", self.circuit.id)
        self.tr(self.edge_ip, self.ping, SEP + timedelta(days=5), "down")
        out = self.compute()
        self.assertAlmostEqual(out["figures"]["availability"], 50.0, places=2)
        member = next(u for u in out["units"] if u.get("member"))
        self.assertEqual(member["name"], "TEL-1")
        self.assertEqual({i["address"] for i in member["items"]}, {"10.0.0.5"})

    def test_a_monitor_address_wins_over_the_trace(self):
        gw = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.99",
                                      prefix=self.prefix)
        CheckState.objects.create(tenant=self.tenant, target_ip=gw, template=self.ping,
                                  kind="icmp", status="up")
        self.tr(gw, self.ping, SEP - timedelta(days=1), "up")
        self.add("api.circuit", self.circuit.id, monitor_ip=gw)
        self.tr(self.edge_ip, self.ping, SEP + timedelta(days=5), "down")  # not read
        self.assertEqual(self.compute()["figures"]["availability"], 100.0)

    def test_an_uncabled_circuit_has_no_data(self):
        CableTermination.objects.all().delete()
        self.add("api.circuit", self.circuit.id)
        self.assertEqual(self.compute()["figures"]["state"], "no_data")

    def test_carrier_maintenance_on_the_circuit_is_excluded(self):
        self.add("api.circuit", self.circuit.id)
        self.tr(self.edge_ip, self.ping, SEP + timedelta(days=2), "down")
        self.tr(self.edge_ip, self.ping, SEP + timedelta(days=2, hours=2), "up")
        ev = MaintenanceEvent.objects.create(
            tenant=self.tenant, name="Carrier works", status=status_for(self.tenant, "confirmed"),
            starts_at=SEP + timedelta(days=2), ends_at=SEP + timedelta(days=2, hours=1),
        )
        EventImpact.objects.create(tenant=self.tenant, event=ev, object_type="api.circuit",
                                   object_id=self.circuit.id, level="outage")
        self.assertEqual(self.compute()["figures"]["down_s"], 3600)


class SeriesTests(_Circuit):
    def test_all_must_be_up_adds_outages_that_average_hides(self):
        a, ip_a = self.device("fw1", 11)
        b, ip_b = self.device("fw2", 12)
        self.add("api.device", a.id)
        self.add("api.device", b.id)
        self.tr(ip_a, self.ping, SEP + timedelta(days=2), "down")
        self.tr(ip_a, self.ping, SEP + timedelta(days=3), "up")
        self.tr(ip_b, self.ping, SEP + timedelta(days=6), "down")
        self.tr(ip_b, self.ping, SEP + timedelta(days=7), "up")
        self.assertAlmostEqual(self.compute()["figures"]["availability"], 90.0, places=2)
        self.agreement.aggregation = "all"
        self.agreement.save()
        f = self.compute()["figures"]
        self.assertAlmostEqual(f["availability"], 80.0, places=2)
        self.assertEqual(f["down_s"], 2 * 86400)
        self.assertEqual(f["incidents"], 2)

    def test_circuit_and_a_redundant_pair_in_series(self):
        # Internet = circuit AND (fw1 OR fw2): a single firewall down is fine,
        # the circuit down is not.
        a, ip_a = self.device("fw1", 11)
        b, ip_b = self.device("fw2", 12)
        self.add("api.circuit", self.circuit.id)
        self.add("api.device", a.id, redundancy_group="fw")
        self.add("api.device", b.id, redundancy_group="fw")
        self.agreement.aggregation = "all"
        self.agreement.save()
        self.tr(ip_a, self.ping, SEP + timedelta(days=2), "down")  # never back
        self.tr(self.edge_ip, self.ping, SEP + timedelta(days=5), "down")
        self.tr(self.edge_ip, self.ping, SEP + timedelta(days=6), "up")
        self.assertAlmostEqual(self.compute()["figures"]["availability"], 90.0, places=2)

    def test_the_days_follow_the_series(self):
        a, ip_a = self.device("fw1", 11)
        self.add("api.circuit", self.circuit.id)
        self.add("api.device", a.id)
        self.agreement.aggregation = "all"
        self.agreement.save()
        self.tr(ip_a, self.ping, SEP + timedelta(days=4), "down")
        self.tr(ip_a, self.ping, SEP + timedelta(days=5), "up")
        day = next(d for d in self.compute()["days"] if d["date"] == "2026-09-05")
        self.assertEqual(day["availability"], 0.0)


class StatusKindTests(_Circuit, APITestCase):
    def setUp(self):
        super().setUp()
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        CheckRollupDaily.objects.create(
            tenant=self.tenant, target_ip=self.edge_ip, template=self.ping, kind="icmp",
            # The frame runs from the real clock, not the fixtures' NOW.
            bucket=timezone.now().replace(hour=0, minute=0, second=0, microsecond=0)
            - timedelta(days=1), up_s=43200, down_s=43200,
            samples=10, closed=True,
        )

    def status(self, kind, ids):
        r = self.client.post(S, {"kind": kind, "ids": [str(i) for i in ids],
                                 "frame": "7d"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["results"]

    def test_circuit(self):
        self.add("api.circuit", self.circuit.id)
        sla.refresh_agreement(self.agreement)
        row = self.status("circuit", [self.circuit.id])[str(self.circuit.id)]
        self.assertEqual(row["availability"]["availability"], 50.0)
        self.assertEqual(row["sla"][0]["agreement"]["name"], "Gold")

    def test_circuit_availability_reads_its_monitor_address(self):
        CableTermination.objects.all().delete()
        self.add("api.circuit", self.circuit.id, monitor_ip=self.edge_ip)
        row = self.status("circuit", [self.circuit.id])[str(self.circuit.id)]
        self.assertEqual(row["availability"]["availability"], 50.0)

    def test_site_gets_the_agreements_provided_for_it(self):
        self.agreement.provided_for = "sites"
        self.agreement.save()
        self.agreement.sites.add(self.site)
        self.add("api.device", self.edge.id)
        sla.refresh_agreement(self.agreement)
        row = self.status("site", [self.site.id])[str(self.site.id)]
        self.assertEqual(row["availability"]["availability"], 50.0)
        self.assertEqual([s["agreement"]["name"] for s in row["sla"]], ["Gold"])

    def test_cluster_gets_its_hosts_agreements(self):
        ctype = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ctype)
        self.edge.cluster = cluster
        self.edge.save()
        self.add("api.device", self.edge.id)
        sla.refresh_agreement(self.agreement)
        row = self.status("cluster", [cluster.id])[str(cluster.id)]
        self.assertEqual(row["availability"]["availability"], 50.0)
        self.assertEqual(len(row["sla"]), 1)


class MonitorAddressApiTests(_Circuit, APITestCase):
    def setUp(self):
        super().setUp()
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def post(self, otype, oid):
        return self.client.post("/api/monitoring/sla-members/", {
            "agreement": str(self.agreement.id), "group": str(self.group.id),
            "object_type": otype, "object_id": str(oid), "monitor_ip": str(self.edge_ip.id),
        }, format="json")

    def test_only_a_circuit_takes_a_monitor_address(self):
        self.assertEqual(self.post("api.device", self.edge.id).status_code, 400)
        r = self.post("api.circuit", self.circuit.id)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["monitor_ip_detail"]["address"], "10.0.0.5")

    def test_bulk_add_takes_a_monitor_address_for_circuits_only(self):
        url = "/api/monitoring/sla-members/bulk-add/"
        body = {"agreement": str(self.agreement.id), "group": str(self.group.id),
                "monitor_ip": str(self.edge_ip.id)}
        bad = self.client.post(url, {**body, "objects": [
            {"object_type": "api.device", "object_id": str(self.edge.id)}]}, format="json")
        self.assertEqual(bad.status_code, 400)
        ok = self.client.post(url, {**body, "objects": [
            {"object_type": "api.circuit", "object_id": str(self.circuit.id)}]}, format="json")
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(SlaMember.objects.get(object_id=self.circuit.id).monitor_ip, self.edge_ip)
