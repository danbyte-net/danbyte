"""Provisioning Danbyte's inventory into Zabbix (#162 phase 2).

The thing under test is mostly restraint. Danbyte is writing into somebody
else's monitoring system, so most of these assert that it does **not** write:
not when the mode says off, not when the match is a guess, not when the host
is not one Danbyte made.
"""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from api.models import Device, DeviceRole, DeviceType, IPAddress, Manufacturer, Prefix, Site
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings
from monitoring.models import CheckState, CheckTemplate, MonitoringEngine

from . import provision
from .client import ZabbixClient, ZabbixError
from .matching import index_hosts, match_device
from .models import ZabbixChange, ZabbixConnection, ZabbixHostLink

TOKEN = "t" * 64


def host(hostid, name, ip=None, serial=None, host_name=None):
    return {
        "hostid": hostid,
        "host": host_name or name,
        "name": name,
        "status": "0",
        "interfaces": [{"ip": ip, "type": "1"}] if ip else [],
        "inventory": {"serialno_a": serial} if serial else {},
    }


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"zabbix_enabled": True}
        )
        self.conn = ZabbixConnection.objects.create(
            tenant=self.tenant, name="zbx", url="https://z.example.com",
            credentials={"token": TOKEN}, version="7.0.30",
            provision_mode=ZabbixConnection.REVIEW,
        )
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="zbx", slug="zbx", kind="zabbix"
        )
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        vendor = Manufacturer.objects.create(
            tenant=self.tenant, name="Acme", slug="acme"
        )
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=vendor, model="SW-1"
        )
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Switch", slug="switch"
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.7.0.0/24")
        self.tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="Zabbix", kind="zabbix", interval_seconds=300
        )

    def make_device(self, name, last_octet, serial=""):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"10.7.0.{last_octet}/24",
            prefix=self.prefix,
        )
        device = Device.objects.create(
            tenant=self.tenant, name=name, device_type=self.dtype,
            role=self.role, site=self.site, serial_number=serial,
        )
        ip.assigned_device = device
        ip.save(update_fields=["assigned_device"])
        device.primary_ip = ip
        device.save(update_fields=["primary_ip"])
        return device

    def scope(self, device):
        """Put a device in scope the way an operator would - by asking Zabbix
        to watch it."""
        CheckState.objects.create(
            tenant=self.tenant, target_ip=device.primary_ip, template=self.tmpl,
            engine=self.engine, kind="zabbix", interval_seconds=300,
            next_run=timezone.now(),
        )

    def plan(self, hosts):
        with mock.patch.object(ZabbixClient, "all_hosts", return_value=hosts):
            return provision.plan(self.conn)


class ScopeTests(_Base):
    def test_scope_is_the_devices_zabbix_was_asked_to_watch(self):
        """One scope definition, not two that can disagree."""
        watched = self.make_device("sw1", 10)
        self.make_device("sw2", 11)  # no check - not in scope
        self.scope(watched)
        self.assertEqual(
            [d.name for d in provision.devices_in_scope(self.conn)], ["sw1"]
        )

    def test_a_check_on_another_engine_is_not_in_scope(self):
        d = self.make_device("sw1", 10)
        CheckState.objects.create(
            tenant=self.tenant, target_ip=d.primary_ip, template=self.tmpl,
            engine=MonitoringEngine.local_for(self.tenant), kind="zabbix",
            interval_seconds=300, next_run=timezone.now(),
        )
        self.assertFalse(provision.devices_in_scope(self.conn).exists())


class RestraintTests(_Base):
    """Danbyte does not write unless it was asked to."""

    def test_off_plans_nothing_and_calls_nothing(self):
        self.scope(self.make_device("sw1", 10))
        self.conn.provision_mode = ZabbixConnection.OFF
        self.conn.save()
        with mock.patch.object(ZabbixClient, "all_hosts") as h:
            counts = provision.plan(self.conn)
        h.assert_not_called()
        self.assertEqual(counts["create"], 0)
        self.assertFalse(ZabbixChange.objects.exists())

    def test_off_is_the_shipped_default(self):
        fresh = ZabbixConnection(tenant=self.tenant, name="n", url="u")
        self.assertEqual(fresh.provision_mode, ZabbixConnection.OFF)
        self.assertFalse(fresh.prune_hosts)

    def test_the_tenant_switch_stops_it_too(self):
        self.scope(self.make_device("sw1", 10))
        s = IntegrationSettings.objects.get(tenant=self.tenant)
        s.zabbix_enabled = False
        s.save()
        with mock.patch.object(ZabbixClient, "all_hosts") as h:
            provision.plan(self.conn)
        h.assert_not_called()

    def test_review_proposes_but_writes_nothing(self):
        self.scope(self.make_device("sw1", 10))
        with mock.patch.object(ZabbixClient, "create_host") as create:
            counts = self.plan([])
        create.assert_not_called()
        self.assertEqual(counts["create"], 1)
        self.assertEqual(
            ZabbixChange.objects.get().kind, ZabbixChange.CREATE
        )

    def test_a_read_failure_proposes_nothing_rather_than_everything(self):
        """If the host list did not arrive, every device looks unmatched - and
        proposing to create the whole estate would be catastrophic."""
        self.scope(self.make_device("sw1", 10))
        with mock.patch.object(
            ZabbixClient, "all_hosts", side_effect=ZabbixError("down")
        ):
            counts = provision.plan(self.conn)
        self.assertEqual(counts["create"], 0)
        self.assertFalse(ZabbixChange.objects.exists())


class MatchingTests(_Base):
    def _match(self, device, hosts, link=None):
        index = index_hosts(hosts)
        index["by_id"] = {h["hostid"]: h for h in hosts}
        return match_device(device, index, link)

    def test_matches_on_address(self):
        d = self.make_device("sw1", 10)
        m = self._match(d, [host("1", "anything", ip="10.7.0.10")])
        self.assertEqual((m.how, m.host["hostid"]), ("address", "1"))

    def test_matches_on_serial_when_the_address_does_not(self):
        d = self.make_device("sw1", 10, serial="ABC123")
        m = self._match(d, [host("1", "renamed", ip="10.9.9.9", serial="abc123")])
        self.assertEqual(m.how, "serial")

    def test_matches_on_name_last(self):
        d = self.make_device("sw1", 10)
        m = self._match(d, [host("1", "sw1")])
        self.assertEqual(m.how, "name")

    def test_a_stored_link_beats_everything(self):
        """A rename on either side must not break an established pairing."""
        d = self.make_device("sw1", 10)
        link = ZabbixHostLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=d, hostid="9"
        )
        m = self._match(d, [host("9", "renamed-in-zabbix"), host("1", "sw1")], link)
        self.assertEqual((m.how, m.host["hostid"]), ("link", "9"))

    def test_a_link_to_a_vanished_host_falls_back_rather_than_giving_up(self):
        """A host deleted and recreated in Zabbix is still the same box."""
        d = self.make_device("sw1", 10)
        link = ZabbixHostLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=d, hostid="gone"
        )
        m = self._match(d, [host("1", "sw1", ip="10.7.0.10")], link)
        self.assertEqual((m.how, m.host["hostid"]), ("address", "1"))

    def test_two_hosts_on_one_address_is_ambiguous_not_a_coin_flip(self):
        d = self.make_device("sw1", 10)
        m = self._match(
            d, [host("1", "a", ip="10.7.0.10"), host("2", "b", ip="10.7.0.10")]
        )
        self.assertFalse(m.matched)
        self.assertEqual(m.how, "ambiguous")
        self.assertIn("2 Zabbix hosts", m.reason)

    def test_one_host_with_two_interfaces_on_one_address_is_not_ambiguous(self):
        d = self.make_device("sw1", 10)
        h = host("1", "a", ip="10.7.0.10")
        h["interfaces"].append({"ip": "10.7.0.10", "type": "2"})
        m = self._match(d, [h])
        self.assertEqual(m.how, "address")

    def test_no_match_is_reported_plainly(self):
        d = self.make_device("sw1", 10)
        m = self._match(d, [host("1", "somethingelse", ip="10.9.9.9")])
        self.assertFalse(m.matched)
        self.assertEqual(m.how, "none")

    def test_ambiguity_becomes_a_change_a_person_must_resolve(self):
        d = self.make_device("sw1", 10)
        self.scope(d)
        counts = self.plan(
            [host("1", "a", ip="10.7.0.10"), host("2", "b", ip="10.7.0.10")]
        )
        self.assertEqual(counts["ambiguous"], 1)
        self.assertEqual(counts["create"], 0)
        change = ZabbixChange.objects.get()
        self.assertEqual(change.kind, ZabbixChange.AMBIGUOUS)
        with self.assertRaises(ValueError):
            provision.apply_change(change)


class PayloadTests(_Base):
    def test_states_only_what_danbyte_owns(self):
        """Nothing about items, triggers or templates: two systems editing one
        field is how both stop being trusted."""
        d = self.make_device("sw1", 10, serial="SN-1")
        payload = provision.host_payload(d, "5")
        self.assertEqual(payload["host"], "sw1")
        self.assertEqual(payload["groups"], [{"groupid": "5"}])
        self.assertEqual(payload["interfaces"][0]["ip"], "10.7.0.10")
        self.assertEqual(payload["inventory"], {"serialno_a": "SN-1"})
        for forbidden in ("templates", "items", "triggers"):
            self.assertNotIn(forbidden, payload)

    def test_a_device_with_no_address_falls_back_to_its_name(self):
        d = Device.objects.create(
            tenant=self.tenant, name="sw9", device_type=self.dtype,
            role=self.role, site=self.site,
        )
        iface = provision.host_payload(d, "5")["interfaces"][0]
        self.assertEqual(iface["useip"], 0)
        self.assertEqual(iface["dns"], "sw9")

    def test_no_serial_means_no_inventory_claim(self):
        d = self.make_device("sw1", 10)
        self.assertNotIn("inventory", provision.host_payload(d, "5"))


class UpdateTests(_Base):
    def test_an_identical_host_proposes_nothing(self):
        d = self.make_device("sw1", 10)
        self.scope(d)
        counts = self.plan([host("1", "sw1", ip="10.7.0.10")])
        self.assertEqual(counts["linked"], 1)
        self.assertEqual(counts["update"], 0)
        self.assertFalse(ZabbixChange.objects.exists())

    def test_a_renamed_host_proposes_the_rename(self):
        d = self.make_device("sw1", 10)
        self.scope(d)
        counts = self.plan([host("1", "old", ip="10.7.0.10", host_name="old")])
        self.assertEqual(counts["update"], 1)
        self.assertEqual(
            ZabbixChange.objects.get().detail["changes"]["host"], "sw1"
        )

    def test_a_stale_proposal_is_dropped_when_it_stops_being_true(self):
        d = self.make_device("sw1", 10)
        self.scope(d)
        self.plan([])
        self.assertEqual(ZabbixChange.objects.count(), 1)
        # Somebody created it by hand in the meantime.
        self.plan([host("1", "sw1", ip="10.7.0.10")])
        self.assertFalse(ZabbixChange.objects.exists())


class PruneTests(_Base):
    def _linked(self, device, created_here):
        return ZabbixHostLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            hostid="1", host_name=device.name, created_here=created_here,
        )

    def test_a_host_danbyte_did_not_create_is_never_pruned(self):
        """Somebody else's host is theirs. Danbyte losing interest is not a
        reason to delete it."""
        d = self.make_device("sw1", 10)
        self._linked(d, created_here=False)
        self.conn.prune_hosts = True
        self.conn.prune_after_days = 0
        self.conn.save()
        counts = self.plan([])
        self.assertEqual(counts["prune"], 0)
        self.assertFalse(
            ZabbixChange.objects.filter(kind=ZabbixChange.PRUNE).exists()
        )

    def test_pruning_off_marks_but_never_proposes(self):
        d = self.make_device("sw1", 10)
        link = self._linked(d, created_here=True)
        counts = self.plan([])
        self.assertEqual(counts["prune"], 0)
        link.refresh_from_db()
        self.assertIsNotNone(link.unwanted_since)

    def test_the_grace_period_has_to_elapse(self):
        d = self.make_device("sw1", 10)
        link = self._linked(d, created_here=True)
        self.conn.prune_hosts = True
        self.conn.prune_after_days = 7
        self.conn.save()
        self.assertEqual(self.plan([])["prune"], 0)
        link.refresh_from_db()
        link.unwanted_since = timezone.now() - timedelta(days=8)
        link.save(update_fields=["unwanted_since"])
        self.assertEqual(self.plan([])["prune"], 1)

    def test_coming_back_into_scope_clears_the_mark(self):
        d = self.make_device("sw1", 10)
        link = self._linked(d, created_here=True)
        self.plan([])
        link.refresh_from_db()
        self.assertIsNotNone(link.unwanted_since)
        self.scope(d)
        self.plan([host("1", "sw1", ip="10.7.0.10")])
        link.refresh_from_db()
        self.assertIsNone(link.unwanted_since)


class ApplyTests(_Base):
    def test_creating_records_the_link_as_danbytes_own(self):
        d = self.make_device("sw1", 10)
        self.scope(d)
        self.plan([])
        change = ZabbixChange.objects.get()
        with mock.patch.object(ZabbixClient, "group_ids", return_value=["5"]), \
             mock.patch.object(ZabbixClient, "create_host", return_value="77") as create:
            provision.apply_change(change)
        self.assertEqual(create.call_args[0][0]["host"], "sw1")
        link = ZabbixHostLink.objects.get()
        self.assertEqual((link.hostid, link.created_here), ("77", True))
        # A proposal that has happened is not a record of anything.
        self.assertFalse(ZabbixChange.objects.exists())

    def test_the_host_group_is_named_after_the_site(self):
        d = self.make_device("sw1", 10)
        self.scope(d)
        self.plan([])
        with mock.patch.object(ZabbixClient, "group_ids", return_value=["5"]) as g, \
             mock.patch.object(ZabbixClient, "create_host", return_value="77"):
            provision.apply_change(ZabbixChange.objects.get())
        g.assert_called_once_with(["HQ"])

    def test_one_failure_does_not_stop_the_others(self):
        for n, name in ((10, "sw1"), (11, "sw2"), (12, "sw3")):
            self.scope(self.make_device(name, n))
        self.plan([])
        self.assertEqual(ZabbixChange.objects.count(), 3)
        with mock.patch.object(ZabbixClient, "group_ids", return_value=["5"]), \
             mock.patch.object(
                 ZabbixClient, "create_host",
                 side_effect=["1", ZabbixError("refused"), "3"]):
            done = provision.apply_pending(self.conn)
        self.assertEqual((done["applied"], done["failed"]), (2, 1))

    def test_apply_pending_never_touches_an_ambiguous_change(self):
        d = self.make_device("sw1", 10)
        self.scope(d)
        self.plan([host("1", "a", ip="10.7.0.10"), host("2", "b", ip="10.7.0.10")])
        with mock.patch.object(ZabbixClient, "create_host") as create:
            done = provision.apply_pending(self.conn)
        create.assert_not_called()
        self.assertEqual(done, {"applied": 0, "failed": 0, "errors": []})
        self.assertTrue(ZabbixChange.objects.exists())

    def test_auto_mode_plans_then_applies(self):
        d = self.make_device("sw1", 10)
        self.scope(d)
        self.conn.provision_mode = ZabbixConnection.AUTO
        self.conn.save()
        with mock.patch.object(ZabbixClient, "all_hosts", return_value=[]), \
             mock.patch.object(ZabbixClient, "group_ids", return_value=["5"]), \
             mock.patch.object(ZabbixClient, "create_host", return_value="77"):
            counts = provision.sync(self.conn)
        self.assertEqual(counts["applied"], 1)
        self.assertTrue(ZabbixHostLink.objects.filter(created_here=True).exists())


class AutoSyncTests(_Base):
    """When the pass runs, which is a separate decision from what it does."""

    def due(self, **over):
        for k, v in over.items():
            setattr(self.conn, k, v)
        self.conn.save()
        return self.conn.sync_due(timezone.now())

    def test_off_by_default(self):
        fresh = ZabbixConnection(tenant=self.tenant, name="n", url="u")
        self.assertFalse(fresh.auto_sync)
        self.assertEqual(fresh.sync_interval_minutes, 60)

    def test_never_synced_is_due(self):
        self.assertTrue(self.due(auto_sync=True))

    def test_not_due_inside_the_interval(self):
        self.assertFalse(self.due(
            auto_sync=True, sync_interval_minutes=60,
            last_sync_at=timezone.now() - timedelta(minutes=30),
        ))

    def test_due_once_the_interval_has_elapsed(self):
        self.assertTrue(self.due(
            auto_sync=True, sync_interval_minutes=60,
            last_sync_at=timezone.now() - timedelta(minutes=61),
        ))

    def test_provisioning_off_is_never_due(self):
        """Nothing to sync if Danbyte is not allowed to write."""
        self.assertFalse(self.due(
            auto_sync=True, provision_mode=ZabbixConnection.OFF
        ))

    def test_a_disabled_connection_is_never_due(self):
        self.assertFalse(self.due(auto_sync=True, enabled=False))

    def test_the_beat_queues_only_what_is_due(self):
        from zabbix import sync_tasks

        self.conn.auto_sync = True
        self.conn.save()
        with mock.patch.object(sync_tasks, "django_rq") as rq:
            out = sync_tasks.enqueue_due_syncs()
        self.assertEqual(out["queued"], 1)
        rq.get_queue.return_value.enqueue.assert_called_once()

    def test_the_beat_skips_a_tenant_with_the_switch_off(self):
        from zabbix import sync_tasks

        self.conn.auto_sync = True
        self.conn.save()
        s = IntegrationSettings.objects.get(tenant=self.tenant)
        s.zabbix_enabled = False
        s.save()
        with mock.patch.object(sync_tasks, "django_rq") as rq:
            self.assertEqual(sync_tasks.enqueue_due_syncs()["queued"], 0)
        rq.get_queue.return_value.enqueue.assert_not_called()

    def test_the_job_rechecks_the_switch_at_run_time(self):
        """A toggle flipped between enqueue and execution has to win, or
        Danbyte writes into a Zabbix somebody just switched off."""
        from zabbix.sync_tasks import run_sync

        s = IntegrationSettings.objects.get(tenant=self.tenant)
        s.zabbix_enabled = False
        s.save()
        with mock.patch("zabbix.provision.sync") as sync:
            out = run_sync(str(self.conn.id))
        sync.assert_not_called()
        self.assertEqual(out["skipped"], "integration off")

    def test_the_job_rechecks_provisioning_at_run_time_too(self):
        from zabbix.sync_tasks import run_sync

        self.conn.provision_mode = ZabbixConnection.OFF
        self.conn.save()
        with mock.patch("zabbix.provision.sync") as sync:
            out = run_sync(str(self.conn.id))
        sync.assert_not_called()
        self.assertEqual(out["skipped"], "provisioning off")

    def test_a_deleted_connection_does_not_crash_the_worker(self):
        from zabbix.sync_tasks import run_sync

        cid = str(self.conn.id)
        self.conn.delete()
        self.assertEqual(run_sync(cid), {"skipped": "gone"})

    def test_a_pass_records_when_it_ran_and_what_it_found(self):
        d = self.make_device("sw1", 10)
        self.scope(d)
        with mock.patch.object(ZabbixClient, "all_hosts", return_value=[]):
            provision.sync(self.conn)
        self.conn.refresh_from_db()
        self.assertIsNotNone(self.conn.last_sync_at)
        self.assertEqual(self.conn.last_sync_summary["create"], 1)

    def test_a_failing_pass_still_backs_off(self):
        """Without stamping the attempt, a broken connection stays permanently
        due and the every-minute beat re-queues it forever."""
        from zabbix.sync_tasks import run_sync

        self.conn.auto_sync = True
        self.conn.save()
        with mock.patch("zabbix.provision.sync", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                run_sync(str(self.conn.id))
        self.conn.refresh_from_db()
        self.assertIsNotNone(self.conn.last_sync_at)
        self.assertIn("boom", self.conn.last_sync_summary["error"])
        self.assertFalse(self.conn.sync_due(timezone.now()))
