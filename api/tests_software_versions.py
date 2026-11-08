"""Running software versions (#451): the extractors, the platform pattern,
the source column and its ownership rule across the SNMP, virtualization,
API and import writers, the list filters and the Lifecycle → Versions
summary."""
from __future__ import annotations

import importlib

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    Platform,
    Site,
    VirtualMachine,
)
from api.software_versions import (
    extract,
    reextract,
    record,
    validate_version_pattern,
    version_sort_key,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

User = get_user_model()

IOSXE_CODENAME = (
    "Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), "
    "Version 17.9.4a, RELEASE SOFTWARE (fc3)"
)
IOSXE_PLAIN = "Cisco IOS XE Software, Version 17.09.04a"
IOS = (
    "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E8, "
    "RELEASE SOFTWARE (fc3)"
)
NXOS = "Cisco NX-OS(tm) n9000, Software (n9000-dk9), Version 9.3(10), RELEASE SOFTWARE"
JUNOS = (
    "Juniper Networks, Inc. ex4300-48t Ethernet Switch, kernel JUNOS 21.4R3-S5.4, "
    "Build date: 2023-06-01 10:00:00 UTC Copyright (c) 1996-2023 Juniper Networks, Inc."
)
EOS = "Arista Networks EOS version 4.28.3M running on an Arista Networks DCS-7050SX3-48YC8"
LINUX = "Linux host 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC x86_64"


class ExtractorTests(SimpleTestCase):
    def test_each_platform_family(self):
        cases = [
            (IOSXE_CODENAME, ("17.9.4a", "cisco_iosxe")),
            # Zero padding is kept as the device says it.
            (IOSXE_PLAIN, ("17.09.04a", "cisco_iosxe")),
            (IOS, ("15.2(7)E8", "cisco_ios")),
            (NXOS, ("9.3(10)", "cisco_nxos")),
            (JUNOS, ("21.4R3-S5.4", "junos")),
            (EOS, ("4.28.3M", "arista_eos")),
        ]
        for text, want in cases:
            with self.subTest(text=text[:30]):
                self.assertEqual(extract(text), want)

    def test_a_linux_kernel_is_not_a_platform_version(self):
        self.assertIsNone(extract(LINUX))

    def test_blank_and_unknown_text(self):
        self.assertIsNone(extract(""))
        self.assertIsNone(extract(None))
        self.assertIsNone(extract("HP ProCurve J9145A Switch 2910al-24G"))

    def test_the_platform_pattern_wins(self):
        self.assertEqual(
            extract(IOS, r"\(fc(?P<version>\d+)\)"), ("3", "custom")
        )
        self.assertEqual(extract("FortiGate-60F v7.2.5", r"v(\d+\.\d+\.\d+)"),
                         ("7.2.5", "custom"))

    def test_a_pattern_that_does_not_match_falls_back(self):
        self.assertEqual(extract(EOS, r"nothing-(\d+)"), ("4.28.3M", "arista_eos"))

    def test_input_is_capped(self):
        self.assertIsNone(extract("x" * 600 + " Arista Networks EOS version 4.1"))

    def test_pattern_validation(self):
        validate_version_pattern("")
        validate_version_pattern(r"v(\d+)")
        validate_version_pattern(r"(a)(?P<version>\d+)")
        for bad in (r"v(\d+", r"no groups", r"(a)(b)"):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                validate_version_pattern(bad)

    def test_natural_version_order(self):
        versions = ["17.10.1", "", "17.9.4a", "17.9.4", "15.2(7)E10", "15.2(7)E8"]
        self.assertEqual(
            sorted(versions, key=version_sort_key),
            ["15.2(7)E8", "15.2(7)E10", "17.9.4", "17.9.4a", "17.10.1", ""],
        )


class _Fleet(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.ios = Platform.objects.create(tenant=self.tenant, name="IOS-XE", slug="ios-xe")

    def device(self, name, **kw):
        return Device.objects.create(tenant=self.tenant, name=name, platform=self.ios, **kw)


class RecordTests(_Fleet):
    def test_blank_is_filled_and_marked(self):
        d = self.device("sw1")
        changed = record(d, "17.9.4a", "snmp")
        self.assertEqual(set(changed), {"software_version", "software_version_seen_at",
                                        "software_version_source"})
        self.assertEqual((d.software_version, d.software_version_source),
                         ("17.9.4a", "snmp"))
        self.assertIsNotNone(d.software_version_seen_at)

    def test_manual_is_never_overwritten(self):
        d = self.device("sw1", software_version="17.6.1", software_version_source="manual")
        self.assertEqual(record(d, "17.9.4a", "snmp"), [])
        self.assertEqual(record(d, "17.9.4a", "virtualization"), [])
        self.assertEqual(d.software_version, "17.6.1")

    def test_an_unstamped_value_counts_as_typed(self):
        d = self.device("sw1", software_version="17.6.1")
        self.assertEqual(record(d, "17.9.4a", "snmp"), [])

    def test_imported_is_never_overwritten(self):
        d = self.device("sw1", software_version="17.6.1", software_version_source="import")
        self.assertEqual(record(d, "17.9.4a", "snmp"), [])

    def test_an_automatic_value_follows_and_takes_the_new_source(self):
        d = self.device("sw1", software_version="17.6.1", software_version_source="virtualization",
                        software_version_seen_at=timezone.now())
        self.assertTrue(record(d, "17.9.4a", "snmp"))
        self.assertEqual((d.software_version, d.software_version_source), ("17.9.4a", "snmp"))

    def test_unchanged_writes_nothing(self):
        d = self.device("sw1")
        record(d, "17.9.4a", "snmp")
        self.assertEqual(record(d, "17.9.4a", "snmp"), [])

    def test_an_unknown_source_is_refused(self):
        with self.assertRaises(ValueError):
            record(self.device("sw1"), "1", "manual")


class SnmpWriterTests(_Fleet):
    def setUp(self):
        super().setUp()
        from monitoring.models import SnmpProfile

        self.profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="P", slug="p", version="v2c",
            secret_params={"community": "public"},
        )

    def poll(self, reachable=True, sys_descr=IOSXE_CODENAME, **target):
        from monitoring.snmp_poll import persist_snmp_result

        return persist_snmp_result(
            self.tenant, self.profile,
            {"reachable": reachable, "data": {"sys_descr": sys_descr} if reachable else {}},
            **target,
        )

    def test_a_poll_records_the_version(self):
        d = self.device("sw1")
        self.poll(device=d)
        d.refresh_from_db()
        self.assertEqual((d.software_version, d.software_version_source), ("17.9.4a", "snmp"))
        self.assertIsNotNone(d.software_version_seen_at)

    def test_a_failed_poll_writes_nothing(self):
        d = self.device("sw1")
        self.poll(device=d, reachable=False)
        d.refresh_from_db()
        self.assertEqual((d.software_version, d.software_version_source), ("", ""))

    def test_a_manual_value_survives_a_poll(self):
        d = self.device("sw1", software_version="17.6.1", software_version_source="manual")
        self.poll(device=d)
        d.refresh_from_db()
        self.assertEqual((d.software_version, d.software_version_source), ("17.6.1", "manual"))

    def test_a_value_typed_after_loading_is_seen(self):
        d = self.device("sw1")
        Device.objects.filter(pk=d.pk).update(software_version="16.12.1",
                                              software_version_source="manual")
        self.poll(device=d)  # d still reads blank in memory
        d.refresh_from_db()
        self.assertEqual(d.software_version, "16.12.1")

    def test_the_platform_pattern_is_used(self):
        self.ios.version_pattern = r"\(fc(?P<version>\d+)\)"
        self.ios.save()
        d = self.device("sw1")
        self.poll(device=d)
        d.refresh_from_db()
        self.assertEqual(d.software_version, "3")

    def test_a_vm_target(self):
        ct = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        cl = Cluster.objects.create(tenant=self.tenant, name="C", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="csr", cluster=cl,
                                           platform=self.ios)
        self.poll(vm=vm, sys_descr=IOSXE_PLAIN)
        vm.refresh_from_db()
        self.assertEqual((vm.software_version, vm.software_version_source),
                         ("17.09.04a", "snmp"))

    def test_reextract_reads_stored_facts_again(self):
        d = self.device("sw1")
        self.poll(device=d)
        self.ios.version_pattern = r"\(fc(\d+)\)"
        self.ios.save()
        self.assertEqual(reextract(tenant_id=self.tenant.id, platform_id=self.ios.id), 1)
        d.refresh_from_db()
        self.assertEqual(d.software_version, "3")
        # Nothing new to read the second time.
        self.assertEqual(reextract(tenant_id=self.tenant.id), 0)

    def test_the_command_runs(self):
        from io import StringIO

        from django.core.management import call_command

        d = self.device("sw1")
        self.poll(device=d)
        out = StringIO()
        call_command("extract_software_versions", tenant=str(self.tenant.id), stdout=out)
        self.assertIn("0 versions updated", out.getvalue())


class BackfillTests(TestCase):
    """The 0220 backfill names the source of versions already recorded."""

    def test_rules(self):
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        stamped = Device.objects.create(tenant=tenant, name="a", software_version="8.0.3",
                                        software_version_seen_at=timezone.now())
        typed = Device.objects.create(tenant=tenant, name="b", software_version="17.9.4a")
        blank = Device.objects.create(tenant=tenant, name="c")
        ct = ClusterType.objects.create(tenant=tenant, name="CT", slug="ct")
        cl = Cluster.objects.create(tenant=tenant, name="C", type=ct)
        vm = VirtualMachine.objects.create(tenant=tenant, name="v", cluster=cl,
                                           software_version="22.04")
        migration = importlib.import_module("api.migrations.0220_software_version_source")
        migration.backfill(django_apps, None)
        got = {o.name: o.software_version_source for o in (stamped, typed, blank)}
        for o in (stamped, typed, blank):
            o.refresh_from_db()
            got[o.name] = o.software_version_source
        self.assertEqual(got, {"a": "virtualization", "b": "manual", "c": ""})
        vm.refresh_from_db()
        self.assertEqual(vm.software_version_source, "manual")


class _Api(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.core = DeviceRole.objects.create(tenant=self.tenant, name="Core", slug="core")
        self.edge = DeviceRole.objects.create(tenant=self.tenant, name="Edge", slug="edge")
        self.ios = Platform.objects.create(tenant=self.tenant, name="IOS-XE", slug="ios-xe",
                                           target_version="17.9.5")
        self.eos = Platform.objects.create(tenant=self.tenant, name="EOS", slug="eos")
        ct = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="C", type=ct)
        self.admin = User.objects.create_superuser("sv-root", password="x")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def device(self, name, version="", source="", platform=None, site=None, role=None,
               tenant=None):
        return Device.objects.create(
            tenant=tenant or self.tenant, name=name, software_version=version,
            software_version_source=source, platform=platform,
            site=site, role=role,
        )


class WriteRuleTests(_Api):
    def test_a_typed_version_is_manual(self):
        r = self.client.post("/api/devices/", {"name": "sw1", "software_version": "17.9.4a"},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["software_version_source"], "manual")

    def test_editing_takes_ownership_and_clearing_clears_the_source(self):
        d = self.device("sw1", "17.9.4a", "snmp")
        Device.objects.filter(pk=d.pk).update(software_version_seen_at=timezone.now())
        r = self.client.patch(f"/api/devices/{d.id}/", {"software_version": "17.9.5"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["software_version_source"], body["software_version_seen_at"]),
                         ("manual", None))
        r = self.client.patch(f"/api/devices/{d.id}/", {"software_version": ""}, format="json")
        self.assertEqual(r.json()["software_version_source"], "")

    def test_the_source_is_read_only(self):
        d = self.device("sw1", "17.9.4a", "snmp")
        r = self.client.patch(f"/api/devices/{d.id}/", {"software_version_source": "manual"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        d.refresh_from_db()
        self.assertEqual(d.software_version_source, "snmp")

    def test_an_unchanged_version_keeps_its_source(self):
        d = self.device("sw1", "17.9.4a", "snmp")
        r = self.client.patch(f"/api/devices/{d.id}/",
                              {"software_version": "17.9.4a", "description": "x"},
                              format="json")
        self.assertEqual(r.json()["software_version_source"], "snmp")

    def test_vm_version_is_manual(self):
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="v", cluster=self.cluster)
        r = self.client.patch(f"/api/virtual-machines/{vm.id}/",
                              {"software_version": "22.04"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["software_version_source"], "manual")

    def test_an_import_marks_its_versions(self):
        d = self.device("sw1", "17.9.4a", "snmp")
        Device.objects.filter(pk=d.pk).update(software_version_seen_at=timezone.now())
        r = self.client.post(
            "/api/io/device/import/",
            {"rows": [{"id": str(d.id), "name": "sw1", "software_version": "17.9.5"},
                      {"name": "sw2", "software_version": "17.6.1"}]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        d.refresh_from_db()
        self.assertEqual((d.software_version, d.software_version_source), ("17.9.5", "import"))
        self.assertIsNone(d.software_version_seen_at)
        self.assertEqual(Device.objects.get(name="sw2").software_version_source, "import")

    def test_platform_pattern_is_validated(self):
        r = self.client.patch(f"/api/platforms/{self.eos.id}/",
                              {"version_pattern": "v(\\d+"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("version_pattern", r.json())
        r = self.client.patch(f"/api/platforms/{self.eos.id}/",
                              {"version_pattern": "(a)(b)"}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/platforms/{self.eos.id}/",
                              {"version_pattern": "EOS version (?P<version>\\S+)"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["version_pattern"], "EOS version (?P<version>\\S+)")


class ListFilterTests(_Api):
    def names(self, url, **params):
        r = self.client.get(url, params)
        self.assertEqual(r.status_code, 200, r.content)
        return sorted(row["name"] for row in r.json()["results"])

    def test_device_filters(self):
        self.device("a", "17.9.4a", "snmp")
        self.device("b", "17.9.4a", "manual")
        self.device("c", "17.9.5", "snmp")
        self.device("d")
        self.device("foreign", "17.9.4a", "snmp", tenant=self.other)
        self.assertEqual(self.names("/api/devices/", software_version="17.9.4a"), ["a", "b"])
        self.assertEqual(self.names("/api/devices/", software_version_source="snmp"),
                         ["a", "c"])
        self.assertEqual(self.names("/api/devices/", software_version_source="none"), ["d"])
        self.assertEqual(self.client.get("/api/devices/",
                                         {"software_version_source": "x"}).status_code, 400)

    def test_vm_filters(self):
        VirtualMachine.objects.create(tenant=self.tenant, name="v1", cluster=self.cluster,
                                      software_version="22.04", software_version_source="manual")
        VirtualMachine.objects.create(tenant=self.tenant, name="v2", cluster=self.cluster)
        self.assertEqual(self.names("/api/virtual-machines/", software_version="22.04"), ["v1"])
        self.assertEqual(
            self.names("/api/virtual-machines/", software_version_source="none"), ["v2"])


URL = "/api/lifecycle/versions/"


class SummaryTests(_Api):
    def setUp(self):
        super().setUp()
        self.device("a1", "17.9.4a", "snmp", self.ios, self.site_a, self.core)
        self.device("a2", "17.9.4a", "manual", self.ios, self.site_a, self.edge)
        self.device("b1", "17.9.5", "snmp", self.ios, self.site_b, self.core)
        self.device("b2", "", "", self.ios, self.site_b, self.core)
        self.device("e1", "4.28.3M", "snmp", self.eos, self.site_a, self.core)
        self.device("np", "1.0", "manual", None, self.site_a)
        VirtualMachine.objects.create(
            tenant=self.tenant, name="csr", cluster=self.cluster, platform=self.ios,
            site=self.site_b, software_version="17.9.4a", software_version_source="snmp")
        theirs = Platform.objects.create(tenant=self.other, name="IOS-XE", slug="ios-xe")
        self.theirs = theirs
        self.device("foreign", "17.9.4a", "snmp", theirs, tenant=self.other)
        self.user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def get(self, **params):
        r = self.client.get(URL, params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def rows(self, **params):
        return [
            ((r["platform"] or {}).get("name"), r["version"], r["devices"],
             r["virtual_machines"])
            for r in self.get(**params)["results"]
        ]

    def test_counts_per_platform_and_version(self):
        self.assertEqual(self.rows(), [
            ("EOS", "4.28.3M", 1, 0),
            ("IOS-XE", "17.9.4a", 2, 1),
            ("IOS-XE", "17.9.5", 1, 0),
            ("IOS-XE", "", 1, 0),
            (None, "1.0", 1, 0),
        ])
        row = self.get()["results"][1]
        self.assertEqual(row["sources"], {"snmp": 2, "manual": 1})
        self.assertIs(row["on_target"], False)
        self.assertIs(self.get()["results"][2]["on_target"], True)
        self.assertIsNone(self.get()["results"][0]["on_target"])

    def test_filters(self):
        self.assertEqual(self.rows(site=str(self.site_a.id)), [
            ("EOS", "4.28.3M", 1, 0), ("IOS-XE", "17.9.4a", 2, 0), (None, "1.0", 1, 0)])
        self.assertEqual(self.rows(platform=str(self.eos.id)), [("EOS", "4.28.3M", 1, 0)])
        self.assertEqual(self.rows(role=str(self.edge.id)), [("IOS-XE", "17.9.4a", 1, 0)])
        self.assertEqual(
            self.rows(platform=f"{self.eos.id},{self.ios.id}", site=str(self.site_b.id)),
            [("IOS-XE", "17.9.4a", 0, 1), ("IOS-XE", "17.9.5", 1, 0), ("IOS-XE", "", 1, 0)])
        self.assertEqual(self.rows(platform="none"), [(None, "1.0", 1, 0)])
        self.assertEqual(self.rows(role=f"none,{self.edge.id}"),
                         [("IOS-XE", "17.9.4a", 1, 1), (None, "1.0", 1, 0)])
        self.assertEqual(self.client.get(URL, {"site": "nope"}).status_code, 400)

    def test_another_tenants_platform_is_empty(self):
        self.assertEqual(self.rows(platform=str(self.theirs.id)), [])
        names = {p["name"] for p in self.get()["facets"]["platform"]}
        self.assertEqual(names, {"EOS", "IOS-XE", ""})

    def test_facets(self):
        facets = self.get()["facets"]
        self.assertEqual([(s["name"], s["count"]) for s in facets["site"]],
                         [("A", 4), ("B", 3)])
        self.assertEqual([(r["name"], r["count"]) for r in facets["role"]],
                         [("Core", 4), ("Edge", 1), ("", 2)])

    def grant(self, types, sites=()):
        p = ObjectPermission.objects.create(
            name="-".join(types), object_types=list(types), actions=["view"])
        p.users.add(self.user)
        p.tenants.add(self.tenant)
        if sites:
            p.sites.set(sites)

    def test_follows_the_grants_and_site_scope(self):
        self.login(self.user)
        self.assertEqual(self.rows(), [])
        self.grant(["device"], sites=[self.site_b])
        self.assertEqual(self.rows(), [("IOS-XE", "17.9.5", 1, 0), ("IOS-XE", "", 1, 0)])
        self.assertEqual([s["name"] for s in self.get()["facets"]["site"]], ["B"])

    def test_query_count_is_constant(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.get()
            return len(ctx.captured_queries)

        before = count()
        for i in range(10):
            self.device(f"x{i}", f"17.{i}", "snmp", self.ios, self.site_a, self.core)
        self.assertEqual(count(), before)
