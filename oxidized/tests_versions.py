"""The running software version read out of Oxidized configs (#451)."""
from __future__ import annotations

from datetime import timedelta
from io import StringIO

from django.core.management import call_command
from django.test import SimpleTestCase
from django.utils import timezone

from api.models import Device, Platform
from api.software_versions import extract_config, less_specific, record
from integrations.models import IntegrationSettings

from . import schedule
from .models import OxidizedConnection, OxidizedNodeLink
from .tests import FAKE, _Base, node
from .tests_schedule import _SchedBase
from .versions import backup_time, read_versions, run_read_versions

IOS_CFG = """! Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E8, RELEASE SOFTWARE (fc3)
! Image: Software: C2960X-UNIVERSALK9-M, 15.2(7)E8, RELEASE SOFTWARE (fc3)
! Chassis type: WS-C2960X-48TS-L
!
version 15.2
no service pad
hostname sw1
"""
IOS_BARE = "!\nversion 15.2\nservice timestamps debug datetime msec\nhostname sw1\n"
IOSXE_CFG = """! Cisco IOS XE Software, Version 17.09.04a
! Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4a, RELEASE SOFTWARE (fc3)
!
version 17.9
hostname core1
"""
IOSXE_IMAGE = (
    "! Image: Software: CAT9K_IOSXE, 17.9.4a, RELEASE SOFTWARE (fc3)\n!\nversion 17.9\n"
    "hostname core1\n"
)
IOSXE_BARE = "! Chassis type: C9300-48P\n! Model: IOS-XE\n!\nversion 17.9\nhostname core1\n"
NXOS_CFG = """! Cisco Nexus Operating System (NX-OS) Software
! BIOS: version 05.47
! NXOS: version 9.3(10)
!
!Command: show running-config
version 9.3(10) Bios:version 05.47
hostname leaf1
"""
NXOS_BARE = "!Command: show running-config\nversion 10.3(4) Bios:version 05.47\nhostname n1\n"
JUNOS_CFG = """# Chassis                                MX204
# Junos: 22.4R3-S2.11
#
version 22.4R3-S2.11;
system {
    host-name mx1;
}
"""
JUNOS_BARE = "## Last commit: 2026-10-01\nversion 22.4R3-S2;\nsystem {\n    host-name mx1;\n}\n"
EOS_CFG = """! Arista DCS-7050SX3-48YC8
! Software image version: 4.31.2F
!
! device: leaf2 (DCS-7050SX3-48YC8, EOS-4.31.2F)
!
hostname leaf2
"""
EOS_BARE = "! Command: show running-config\n! device: leaf2 (DCS-7280SR, EOS-4.28.3M)\n!\nhostname x\n"


class ConfigExtractorTests(SimpleTestCase):
    def test_each_platform_family(self):
        cases = [
            (IOS_CFG, ("15.2(7)E8", "cisco_ios")),
            (IOS_BARE, ("15.2", "cisco_ios")),
            (IOSXE_CFG, ("17.09.04a", "cisco_iosxe")),
            (IOSXE_IMAGE, ("17.9.4a", "cisco_iosxe")),
            (IOSXE_BARE, ("17.9", "cisco_iosxe")),
            (NXOS_CFG, ("9.3(10)", "cisco_nxos")),
            (NXOS_BARE, ("10.3(4)", "cisco_nxos")),
            (JUNOS_CFG, ("22.4R3-S2.11", "junos")),
            (JUNOS_BARE, ("22.4R3-S2", "junos")),
            (EOS_CFG, ("4.31.2F", "arista_eos")),
            (EOS_BARE, ("4.28.3M", "arista_eos")),
        ]
        for text, want in cases:
            with self.subTest(want=want):
                self.assertEqual(extract_config(text), want)

    def test_nothing_to_read(self):
        for text in ("", None, "hostname x\ninterface Gi0/1\n", "set system host-name x\n"):
            self.assertIsNone(extract_config(text))

    def test_the_platform_pattern_wins(self):
        self.assertEqual(
            extract_config(IOS_CFG, r"Image: Software: \S+, (?P<version>[^,]+)"),
            ("15.2(7)E8", "custom"),
        )
        self.assertEqual(extract_config(JUNOS_CFG, r"(?m)^version (\d+\.\d+)"), ("22.4", "custom"))
        # A pattern that does not match falls back to the built-in ones.
        self.assertEqual(extract_config(EOS_CFG, r"nothing (?P<version>\d+)"),
                         ("4.31.2F", "arista_eos"))

    def test_only_the_head_is_read(self):
        text = "hostname x\n" * 250 + "version 15.2\n"
        self.assertIsNone(extract_config(text))

    def test_less_specific(self):
        self.assertTrue(less_specific("17.9", "17.9.4a"))
        self.assertTrue(less_specific("17.9", "17.09.04a"))
        self.assertTrue(less_specific("15.2", "15.2(7)E8"))
        self.assertFalse(less_specific("17.9", "17.9"))
        self.assertFalse(less_specific("17.12", "17.9.4a"))
        self.assertFalse(less_specific("17.9.4a", "17.9"))

    def test_backup_time(self):
        self.assertIsNotNone(backup_time({"time": "2026-10-01 10:00:00 UTC"}))
        self.assertIsNotNone(backup_time({"time": None,
                                          "last": {"end": "2026-10-01 10:00:00 +0200"}}))
        self.assertIsNone(backup_time({"time": "1970-01-01 00:00:00 +0000"}))
        self.assertIsNone(backup_time({"time": "never"}))


class _OxBase(_Base):
    def setUp(self):
        super().setUp()
        self.ios = Platform.objects.create(tenant=self.tenant, name="IOS", slug="ios")
        self.device.platform = self.ios
        self.device.save()

    def version(self, obj=None):
        obj = obj or self.device
        obj.refresh_from_db()
        return obj.software_version, obj.software_version_source

    def fetches(self):
        return sum(1 for m, p in FAKE["requests"] if p.startswith("/node/fetch/"))


class PrecedenceTests(_OxBase):
    def stamp(self, version, source):
        Device.objects.filter(pk=self.device.pk).update(
            software_version=version, software_version_source=source,
            software_version_seen_at=timezone.now() - timedelta(hours=1),
        )
        self.device.refresh_from_db()

    def test_a_config_does_not_downgrade_a_more_specific_snmp_value(self):
        self.stamp("17.9.4a", "snmp")
        self.assertEqual(record(self.device, "17.9", "oxidized"), [])
        self.assertEqual(self.device.software_version, "17.9.4a")

    def test_a_different_version_from_the_config_wins(self):
        self.stamp("17.9.4a", "snmp")
        self.assertTrue(record(self.device, "17.12", "oxidized"))
        self.assertEqual((self.device.software_version, self.device.software_version_source),
                         ("17.12", "oxidized"))

    def test_snmp_refines_a_config_value(self):
        self.stamp("17.9", "oxidized")
        self.assertTrue(record(self.device, "17.9.4a", "snmp"))
        self.assertEqual(self.device.software_version_source, "snmp")

    def test_the_same_version_from_another_source_writes_nothing(self):
        self.stamp("17.9.4a", "snmp")
        self.assertEqual(record(self.device, "17.9.4a", "oxidized"), [])
        self.assertEqual(self.device.software_version_source, "snmp")

    def test_manual_and_import_are_never_overwritten(self):
        for source in ("manual", "import"):
            Device.objects.filter(pk=self.device.pk).update(
                software_version="15.0", software_version_source=source,
                software_version_seen_at=None,
            )
            self.device.refresh_from_db()
            self.assertEqual(record(self.device, "15.2(7)E8", "oxidized"), [])


class ConfigReadTests(_OxBase):
    def test_reading_the_config_records_the_version(self):
        self.link()
        FAKE["configs"]["sw1"] = IOS_CFG
        self.login()
        self.assertEqual(self.cfg().status_code, 200)
        self.assertEqual(self.version(), ("15.2(7)E8", "oxidized"))
        self.assertIsNotNone(self.device.software_version_seen_at)

    def test_a_manual_value_is_kept(self):
        self.device.software_version, self.device.software_version_source = "15.0", "manual"
        self.device.save()
        self.link()
        FAKE["configs"]["sw1"] = IOS_CFG
        self.login()
        self.assertEqual(self.cfg().status_code, 200)
        self.assertEqual(self.version(), ("15.0", "manual"))

    def test_the_platform_pattern_is_used(self):
        self.ios.version_pattern = r"Chassis type: (?P<version>\S+)"
        self.ios.save()
        self.link()
        FAKE["configs"]["sw1"] = IOS_CFG
        self.login()
        self.cfg()
        self.assertEqual(self.version()[0], "WS-C2960X-48TS-L")


class ReadVersionsTests(_OxBase):
    def setUp(self):
        super().setUp()
        self.link()
        FAKE["configs"]["sw1"] = IOS_CFG
        FAKE["nodes"] = [node("sw1", ip="10.9.0.10")]

    def test_a_new_backup_is_read_once(self):
        self.assertEqual(read_versions(self.conn), 1)
        self.assertEqual(self.version(), ("15.2(7)E8", "oxidized"))
        self.assertEqual(self.fetches(), 1)
        # The same backup again: not fetched.
        self.assertEqual(read_versions(self.conn), 0)
        self.assertEqual(self.fetches(), 1)
        # A newer backup with an upgrade: fetched and recorded.
        FAKE["nodes"][0]["time"] = "2026-10-02 10:00:00 +0000"
        FAKE["configs"]["sw1"] = IOS_CFG.replace("15.2(7)E8", "15.2(7)E10")
        self.assertEqual(read_versions(self.conn), 1)
        self.assertEqual(self.version()[0], "15.2(7)E10")

    def test_a_node_gone_from_oxidized_is_skipped(self):
        FAKE["nodes"] = []
        self.assertEqual(read_versions(self.conn), 0)
        self.assertEqual(self.fetches(), 0)

    def test_a_proposed_link_is_never_read(self):
        OxidizedNodeLink.objects.update(proposed=True)
        self.assertEqual(read_versions(self.conn, force=True), 0)
        self.assertEqual(self.fetches(), 0)

    def test_a_manual_value_is_not_even_fetched(self):
        Device.objects.filter(pk=self.device.pk).update(
            software_version="15.0", software_version_source="manual")
        self.assertEqual(read_versions(self.conn, force=True), 0)
        self.assertEqual(self.fetches(), 0)

    def test_a_manual_sync_queues_the_read(self):
        from unittest import mock

        queued = []
        q = mock.Mock(enqueue=lambda fn, *a, **k: queued.append((fn, a)))
        self.login()
        with mock.patch("oxidized.schedule._queue", return_value=q), \
                self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(f"/api/oxidized/connections/{self.conn.id}/sync/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([fn for fn, _ in queued], [run_read_versions])
        fn, args = queued[0]
        self.assertEqual(fn(*args), 1)
        self.assertEqual(self.version()[0], "15.2(7)E8")

    def test_the_job_rechecks_the_switch(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(oxidized_enabled=False)
        self.assertEqual(run_read_versions(str(self.conn.id), str(self.tenant.id)), 0)
        self.assertEqual(run_read_versions(str(self.conn.id), str(self.other_tenant.id)), 0)
        self.assertEqual(self.fetches(), 0)


class CommandTests(_OxBase):
    def setUp(self):
        super().setUp()
        self.link()
        FAKE["configs"]["sw1"] = IOS_CFG
        # The other tenant: its own connection to the same server and a
        # device whose node also exists there.
        IntegrationSettings.objects.update_or_create(
            tenant=self.other_tenant, defaults={"oxidized_enabled": True}
        )
        self.other_conn = OxidizedConnection.objects.create(
            tenant=self.other_tenant, name="ox", url=self.conn.url,
        )
        self.other_dev = Device.objects.create(tenant=self.other_tenant, name="sw9")
        OxidizedNodeLink.objects.create(
            tenant=self.other_tenant, connection=self.other_conn, device=self.other_dev,
            full_name="sw9", node_name="sw9", matched_by=OxidizedNodeLink.HOW_NAME,
        )
        FAKE["configs"]["sw9"] = JUNOS_CFG

    def run_cmd(self, **kw):
        out = StringIO()
        call_command("extract_software_versions", stdout=out, **kw)
        return out.getvalue()

    def test_the_command_reads_one_tenant(self):
        out = self.run_cmd(tenant=str(self.tenant.id), source="oxidized")
        self.assertIn("1 version updated", out)
        self.assertEqual(self.version(), ("15.2(7)E8", "oxidized"))
        self.assertEqual(self.version(self.other_dev), ("", ""))

    def test_the_command_rereads_after_a_pattern_change(self):
        self.run_cmd(source="oxidized")
        self.assertEqual(self.version(self.other_dev), ("22.4R3-S2.11", "oxidized"))
        Platform.objects.filter(pk=self.ios.pk).update(
            version_pattern=r"(?m)^version (\d+\.\d+)$")
        out = self.run_cmd(tenant=str(self.tenant.id), platform=str(self.ios.id))
        self.assertIn("1 version updated", out)
        self.assertEqual(self.version()[0], "15.2")

    def test_snmp_only_fetches_nothing(self):
        self.run_cmd(source="snmp")
        self.assertEqual(self.fetches(), 0)

    def test_a_link_to_another_tenants_device_is_ignored(self):
        # A row that should never exist: this tenant's link to the other
        # tenant's device.
        OxidizedNodeLink.objects.filter(connection=self.conn).update(device=self.other_dev)
        self.run_cmd(tenant=str(self.tenant.id), source="oxidized")
        self.assertEqual(self.version(self.other_dev), ("", ""))
        self.assertEqual(self.fetches(), 0)


class ScheduledSyncTests(_SchedBase):
    def test_a_scheduled_sync_queues_the_read(self):
        Device.objects.filter(pk=self.device.pk).update(name="sw1")
        FAKE["nodes"] = [node("sw1", ip="10.9.0.10")]
        FAKE["configs"]["sw1"] = EOS_CFG
        schedule.dispatch()
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.run_jobs(), ["synced"])
        self.assertEqual(self.run_jobs(), [1])
        self.device.refresh_from_db()
        self.assertEqual((self.device.software_version, self.device.software_version_source),
                         ("4.31.2F", "oxidized"))
