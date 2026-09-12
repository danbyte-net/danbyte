"""What Zabbix says about a linked host, read on its own cadence (#162).

The claims worth testing: it runs with provisioning off, its write leaves the
inventory row's fields and stamp alone, a host gone from Zabbix clears its
counts and keeps its link, the due gate honours the switch and the interval,
the endpoint 404s with the integration off and is site-scoped like the
device it describes.
"""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, IPAddress, Prefix, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings

from . import facts, status
from .client import ZabbixClient
from .models import ZabbixConnection, ZabbixHostFacts, ZabbixHostLink

TOKEN = "a" * 64


def host(hostid, name, *, snmp="1", error="", disabled=False, maintenance=False):
    return {
        "hostid": hostid, "host": name, "name": name,
        "status": "1" if disabled else "0",
        "maintenance_status": "1" if maintenance else "0",
        "interfaces": [
            {"type": "2", "ip": "10.7.0.10", "available": snmp, "error": error},
        ],
    }


def problem(name, severity, eventid="1"):
    return {"eventid": eventid, "name": name, "severity": str(severity), "clock": "1700000000"}


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"zabbix_enabled": True}
        )
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.7.0.0/24")
        self.conn = ZabbixConnection.objects.create(
            tenant=self.tenant, name="zbx", url="https://z.example.com",
            credentials={"token": TOKEN}, version="7.0.30",
            provision_mode=ZabbixConnection.OFF,
        )
        self.device = Device.objects.create(tenant=self.tenant, name="sw1", site=self.site_a)
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.7.0.10/24", prefix=self.prefix,
            assigned_device=self.device, site=self.site_a,
        )
        self.link = ZabbixHostLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=self.device,
            hostid="50", host_name="sw1", matched_by="ip",
        )
        self.other = Device.objects.create(tenant=self.tenant, name="sw2", site=self.site_b)
        ZabbixHostLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=self.other,
            hostid="51", host_name="sw2", matched_by="ip",
        )
        self.admin = get_user_model().objects.create_superuser("root", "r@x.io", "pw")

    def refresh(self, hosts, problems):
        with mock.patch.object(
            ZabbixClient, "hosts_by_id", return_value={h["hostid"]: h for h in hosts}
        ), mock.patch.object(ZabbixClient, "problems_by_host", return_value=problems):
            return status.refresh_host_status(self.conn)

    def login(self, user=None):
        self.client.force_login(user or self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()


class RefreshTests(_Base):
    def test_a_pass_records_problems_reachability_and_switches(self):
        counts = self.refresh(
            [host("50", "sw1", snmp="2", error="timed out"),
             host("51", "sw2", maintenance=True)],
            {"50": [problem("ICMP unavailable", 4), problem("High CPU", 2, "2")]},
        )
        self.assertEqual(counts, {"hosts": 2, "gone": 0, "problems": 2})
        row = ZabbixHostFacts.objects.get(connection=self.conn, device=self.device)
        self.assertEqual(row.problem_count, 2)
        self.assertEqual(row.worst_severity, "4")
        self.assertEqual(row.problems[0]["name"], "ICMP unavailable")
        self.assertTrue(row.problems[0]["since"].startswith("2023-11-14"))
        self.assertEqual(row.availability["snmp"]["state"], "down")
        self.assertEqual(row.availability["snmp"]["error"], "timed out")
        self.assertFalse(row.maintenance)
        other = ZabbixHostFacts.objects.get(connection=self.conn, device=self.other)
        self.assertTrue(other.maintenance)
        self.assertEqual(other.problem_count, 0)
        self.conn.refresh_from_db()
        self.assertIsNotNone(self.conn.last_status_sync_at)

    def test_it_runs_with_provisioning_off(self):
        self.assertEqual(self.conn.provision_mode, ZabbixConnection.OFF)
        self.refresh([host("50", "sw1"), host("51", "sw2")], {})
        self.assertEqual(ZabbixHostFacts.objects.filter(connection=self.conn).count(), 2)

    def test_the_status_write_leaves_the_inventory_alone(self):
        then = timezone.now() - timedelta(hours=3)
        facts.record(self.conn, self.device, {"name": "sw1", "status": "0",
                                              "inventory": {"serialno_a": "FOC1"}}, now=then)
        self.refresh([host("50", "sw1"), host("51", "sw2")], {"50": [problem("x", 3)]})
        row = ZabbixHostFacts.objects.get(connection=self.conn, device=self.device)
        self.assertEqual(row.data["serial"], "FOC1")
        self.assertEqual(row.polled_at, then)
        self.assertEqual(row.problem_count, 1)
        self.assertIsNotNone(row.status_polled_at)
        # And the other way round: a later inventory read keeps the status.
        facts.record(self.conn, self.device, {"name": "sw1", "status": "0",
                                              "inventory": {"serialno_a": "FOC2"}})
        row.refresh_from_db()
        self.assertEqual(row.data["serial"], "FOC2")
        self.assertEqual(row.problem_count, 1)

    def test_a_host_gone_from_zabbix_clears_counts_and_keeps_the_link(self):
        self.refresh([host("50", "sw1"), host("51", "sw2")], {"50": [problem("x", 5)]})
        counts = self.refresh([host("51", "sw2")], {})
        self.assertEqual(counts["gone"], 1)
        row = ZabbixHostFacts.objects.get(connection=self.conn, device=self.device)
        self.assertEqual(row.problem_count, 0)
        self.assertEqual(row.availability, {})
        self.assertTrue(ZabbixHostLink.objects.filter(pk=self.link.pk).exists())

    def test_only_the_first_twenty_problems_are_kept_by_name(self):
        many = [problem(f"p{i}", 2, str(i)) for i in range(30)]
        self.refresh([host("50", "sw1"), host("51", "sw2")], {"50": many})
        row = ZabbixHostFacts.objects.get(connection=self.conn, device=self.device)
        self.assertEqual(row.problem_count, 30)
        self.assertEqual(len(row.problems), facts.PROBLEMS_KEPT)


class DueTests(_Base):
    def test_due_honours_switch_interval_and_token(self):
        now = timezone.now()
        self.assertTrue(self.conn.status_due(now))
        self.conn.last_status_sync_at = now - timedelta(minutes=2)
        self.assertFalse(self.conn.status_due(now))
        self.conn.last_status_sync_at = now - timedelta(minutes=6)
        self.assertTrue(self.conn.status_due(now))
        self.conn.read_host_status = False
        self.assertFalse(self.conn.status_due(now))
        self.conn.read_host_status = True
        self.conn.credentials = {}
        self.assertFalse(self.conn.status_due(now))

    def test_the_beat_queues_it_on_its_own_stamp(self):
        from .sync_tasks import enqueue_due_syncs

        with mock.patch("django_rq.get_queue") as get_queue:
            queue = get_queue.return_value
            out = enqueue_due_syncs()
        self.assertEqual(out["status"], 1)
        self.assertEqual(out["queued"], 0)
        self.assertEqual(
            [c.args[0].__name__ for c in queue.enqueue.call_args_list], ["run_status_sync"]
        )

    def test_the_job_rechecks_the_switch_at_run_time(self):
        self.conn.read_host_status = False
        self.conn.save(update_fields=["read_host_status"])
        self.assertEqual(status.run_status_sync(str(self.conn.id)), {"skipped": "host status off"})


class EndpointTests(_Base):
    def test_what_the_panel_gets(self):
        self.refresh(
            [host("50", "sw1", snmp="2", error="no response"), host("51", "sw2")],
            {"50": [problem("ICMP unavailable", 4)]},
        )
        self.login()
        r = self.client.get(f"/api/zabbix/host-status/?device={self.device.id}")
        self.assertEqual(r.status_code, 200, r.content)
        [entry] = r.json()
        self.assertEqual(entry["host"], {"hostid": "50", "name": "sw1"})
        self.assertEqual(entry["connection"]["name"], "zbx")
        self.assertEqual(entry["status"]["problem_count"], 1)
        self.assertEqual(entry["status"]["worst_severity"], "4")
        self.assertEqual(entry["status"]["worst_status"], "down")
        self.assertEqual(entry["status"]["availability"]["snmp"]["state"], "down")
        r = self.client.get(f"/api/zabbix/host-status/?ip={self.ip.id}")
        self.assertEqual(r.json()[0]["host"]["hostid"], "50")

    def test_a_linked_host_not_yet_read_has_no_status_yet(self):
        self.login()
        [entry] = self.client.get(f"/api/zabbix/host-status/?device={self.device.id}").json()
        self.assertIsNone(entry["status"]["worst_status"])
        self.assertIsNone(entry["status"]["polled_at"])

    def test_unlinked_is_an_empty_list(self):
        self.login()
        lone = Device.objects.create(tenant=self.tenant, name="lone")
        self.assertEqual(
            self.client.get(f"/api/zabbix/host-status/?device={lone.id}").json(), []
        )

    def test_404_while_the_integration_is_off(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(zabbix_enabled=False)
        self.login()
        r = self.client.get(f"/api/zabbix/host-status/?device={self.device.id}")
        self.assertEqual(r.status_code, 404)

    def test_site_scoped_viewer_sees_nothing_of_the_other_site(self):
        viewer = get_user_model().objects.create_user("v", password="x")
        UserProfile.objects.create(user=viewer, role="custom").tenants.add(self.tenant)
        for slug in ("device", "ipaddress"):
            perm = ObjectPermission.objects.create(
                name=f"a-{slug}", object_types=[slug], actions=["view"]
            )
            perm.users.add(viewer)
            perm.tenants.add(self.tenant)
            perm.sites.add(self.site_a)
        self.login(viewer)
        self.assertEqual(
            len(self.client.get(f"/api/zabbix/host-status/?device={self.device.id}").json()), 1
        )
        self.assertEqual(
            self.client.get(f"/api/zabbix/host-status/?device={self.other.id}").json(), []
        )

    def test_the_connection_form_carries_the_switch(self):
        self.login()
        r = self.client.get(f"/api/zabbix/connections/{self.conn.id}/")
        self.assertTrue(r.json()["read_host_status"])
        self.assertEqual(r.json()["status_interval_minutes"], 5)
        r = self.client.patch(
            f"/api/zabbix/connections/{self.conn.id}/",
            {"read_host_status": False, "status_interval_minutes": 15}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.conn.refresh_from_db()
        self.assertFalse(self.conn.read_host_status)
        self.assertEqual(self.conn.status_interval_minutes, 15)
