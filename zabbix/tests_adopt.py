"""Zabbix as a discovery source (#162 phase 6).

A host Danbyte has no device for becomes a proposal; applying it makes the
device. "Has no device for" is judged against every device of the tenant, so a
host that is plainly some existing device - by address, serial or name - is
never offered as a second one.
"""
from __future__ import annotations

from unittest import mock

from django.test import TestCase
from django.utils import timezone

from api.models import (
    Device,
    DeviceRole,
    DeviceType,
    IPAddress,
    Manufacturer,
    Prefix,
    Site,
)
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings
from monitoring.models import CheckState, CheckTemplate, MonitoringEngine

from . import provision
from .adopt import apply_adoption, is_known, proposal
from .client import ZabbixClient
from .models import ZabbixChange, ZabbixConnection, ZabbixHostLink

TOKEN = "a" * 64


def host(hostid, name, ip=None, *, serial="", model="", groups=(), iface_type="2"):
    return {
        "hostid": hostid,
        "host": name,
        "name": name,
        "status": "0",
        "interfaces": (
            [{"interfaceid": "9", "ip": ip, "type": iface_type}] if ip else []
        ),
        "inventory": {"serialno_a": serial, "model": model, "vendor": "", "os": ""},
        "parentTemplates": [],
        "hostgroups": [{"groupid": str(i), "name": g} for i, g in enumerate(groups, 1)],
    }


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"zabbix_enabled": True}
        )
        seed_builtin_statuses(self.tenant)
        self.site = Site.objects.create(tenant=self.tenant, name="Aarhus")
        vendor = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=vendor, name="C9300-24T", model="C9300-24T"
        )
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Switch", slug="switch")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.7.0.0/24")
        self.conn = ZabbixConnection.objects.create(
            tenant=self.tenant, name="zbx", url="https://z.example.com",
            credentials={"token": TOKEN}, version="7.0.30",
            provision_mode=ZabbixConnection.REVIEW, adopt_hosts=True,
            adopt_site=self.site, adopt_role=self.role, adopt_device_type=self.dtype,
        )
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="zbx", slug="zbx", kind="zabbix"
        )
        self.conn.engines.add(self.engine)
        self.check = CheckTemplate.objects.create(
            tenant=self.tenant, name="Zabbix", kind="zabbix", interval_seconds=300
        )

    def device(self, name="sw1", octet=10, serial=""):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"10.7.0.{octet}/24", prefix=self.prefix
        )
        dev = Device.objects.create(
            tenant=self.tenant, name=name, device_type=self.dtype, role=self.role,
            site=self.site, serial_number=serial,
        )
        ip.assigned_device = dev
        ip.save(update_fields=["assigned_device"])
        dev.primary_ip = ip
        dev.save(update_fields=["primary_ip"])
        return dev

    def plan(self, hosts):
        with mock.patch.object(ZabbixClient, "all_hosts", return_value=hosts):
            return provision.plan(self.conn)

    def adoptions(self):
        return list(
            ZabbixChange.objects.filter(connection=self.conn, kind=ZabbixChange.ADOPT)
        )


class PlanTests(_Base):
    def test_a_host_nothing_answers_to_is_proposed(self):
        counts = self.plan([host("50", "edge-9", "10.7.0.90", serial="FOC123")])
        self.assertEqual(counts["adopt"], 1)
        [change] = self.adoptions()
        d = change.detail
        self.assertEqual(d["name"], "edge-9")
        self.assertEqual(d["address"], "10.7.0.90")
        self.assertEqual(d["serial"], "FOC123")
        self.assertEqual(d["site_id"], str(self.site.id))
        self.assertNotIn("reason", d)

    def test_it_runs_with_nothing_in_scope(self):
        """An empty provisioning scope is exactly the Zabbix-shop-trying-Danbyte
        case: no device has a check yet, and the host list is the way in."""
        counts = self.plan([host("50", "edge-9", "10.7.0.90")])
        self.assertEqual(counts["scoped"], 0)
        self.assertEqual(counts["adopt"], 1)

    def test_a_host_that_is_an_existing_device_is_not_offered_twice(self):
        self.device("sw1", octet=10, serial="FOC1")
        self.device("sw2", octet=11)
        self.device("sw3", octet=12)
        hosts = [
            host("51", "other-name", "10.7.0.10"),          # by address
            host("52", "other-name-2", "10.9.9.9", serial="foc1"),  # by serial
            host("53", "SW3", "10.9.9.10"),                  # by name
            host("54", "brand-new", "10.9.9.11"),
        ]
        self.plan(hosts)
        self.assertEqual([c.detail["hostid"] for c in self.adoptions()], ["54"])

    def test_a_linked_host_is_not_offered(self):
        dev = self.device()
        ZabbixHostLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=dev, hostid="60"
        )
        self.plan([host("60", "renamed-in-zabbix", "10.9.9.9")])
        self.assertEqual(self.adoptions(), [])

    def test_the_site_comes_from_a_host_group_that_names_one(self):
        other = Site.objects.create(tenant=self.tenant, name="Odense")
        self.plan([host("50", "edge-9", "10.7.0.90", groups=["Linux servers", "odense"])])
        self.assertEqual(self.adoptions()[0].detail["site_id"], str(other.id))
        self.assertEqual(self.adoptions()[0].detail["site"], "odense")

    def test_the_type_comes_from_the_inventory_model_when_known(self):
        other = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.dtype.manufacturer,
            name="C9500-48Y4C", model="C9500-48Y4C",
        )
        self.plan([host("50", "core-1", "10.7.0.90", model="c9500-48y4c")])
        self.assertEqual(self.adoptions()[0].detail["device_type_id"], str(other.id))

    def test_without_defaults_the_proposal_waits_and_says_why(self):
        self.conn.adopt_site = None
        self.conn.adopt_role = None
        self.conn.save(update_fields=["adopt_site", "adopt_role"])
        self.plan([host("50", "edge-9", "10.7.0.90")])
        [change] = self.adoptions()
        self.assertIn("No site, role", change.detail["reason"])
        from .serializers import ZabbixChangeSerializer

        self.assertFalse(ZabbixChangeSerializer(change).data["applicable"])

    def test_the_switch_off_proposes_nothing(self):
        self.conn.adopt_hosts = False
        self.conn.save(update_fields=["adopt_hosts"])
        counts = self.plan([host("50", "edge-9", "10.7.0.90")])
        self.assertEqual(counts["adopt"], 0)
        self.assertEqual(self.adoptions(), [])

    def test_a_second_pass_updates_rather_than_duplicates(self):
        self.plan([host("50", "edge-9", "10.7.0.90")])
        self.plan([host("50", "edge-9-renamed", "10.7.0.90")])
        [change] = self.adoptions()
        self.assertEqual(change.detail["name"], "edge-9-renamed")

    def test_a_proposal_for_a_host_that_gained_a_device_is_dropped(self):
        self.plan([host("50", "edge-9", "10.7.0.90")])
        self.device("edge-9", octet=90)
        self.plan([host("50", "edge-9", "10.7.0.90")])
        self.assertEqual(self.adoptions(), [])

    def test_a_dismissed_proposal_stays_dismissed(self):
        self.plan([host("50", "edge-9", "10.7.0.90")])
        ZabbixChange.objects.filter(connection=self.conn).update(ignored=True)
        self.plan([host("50", "edge-9", "10.7.0.90")])
        [change] = self.adoptions()
        self.assertTrue(change.ignored)

    def test_the_snmp_interface_address_wins_over_the_agents(self):
        h = host("50", "edge-9", "10.7.0.90", iface_type="1")
        h["interfaces"].append({"interfaceid": "10", "ip": "10.7.0.91", "type": "2"})
        self.assertEqual(proposal(self.conn, h, sites={}, types={})["address"], "10.7.0.91")

    def test_is_known_reads_both_zabbix_names(self):
        self.device("sw1")
        index = {"addresses": set(), "serials": set(), "names": {"sw1"}}
        self.assertTrue(is_known({"host": "sw1", "name": "Switch one"}, index))
        self.assertTrue(is_known({"host": "zbx-1", "name": "SW1"}, index))
        self.assertFalse(is_known({"host": "zbx-1", "name": "other"}, index))


class ApplyTests(_Base):
    def change(self, **over):
        detail = {
            "hostid": "50", "host": "edge-9", "name": "edge-9", "address": "10.7.0.90",
            "serial": "FOC123", "site_id": str(self.site.id), "role_id": str(self.role.id),
            "device_type_id": str(self.dtype.id),
        }
        detail.update(over)
        return ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, kind=ZabbixChange.ADOPT, detail=detail
        )

    def test_applying_makes_the_device_its_address_and_the_link(self):
        change = self.change()
        result = provision.apply_change(change)
        self.assertIn("Adopted edge-9", result)
        dev = Device.objects.get(tenant=self.tenant, name="edge-9")
        self.assertEqual(dev.serial_number, "FOC123")
        self.assertEqual(dev.site, self.site)
        self.assertEqual(dev.device_type, self.dtype)
        self.assertIsNotNone(dev.status)
        self.assertEqual(str(dev.primary_ip.ip_address).split("/")[0], "10.7.0.90")
        self.assertEqual(dev.primary_ip.prefix, self.prefix)
        link = ZabbixHostLink.objects.get(connection=self.conn, hostid="50")
        self.assertEqual(link.device, dev)
        self.assertEqual(link.matched_by, "adopted")
        self.assertFalse(link.created_here)
        self.assertFalse(ZabbixChange.objects.filter(pk=change.pk).exists())

    def test_an_address_in_no_prefix_is_left_out_and_said(self):
        change = self.change(address="192.0.2.9")
        result = provision.apply_change(change)
        self.assertIn("192.0.2.9 is in no prefix", result)
        dev = Device.objects.get(name="edge-9")
        self.assertIsNone(dev.primary_ip)
        self.assertFalse(IPAddress.objects.filter(ip_address="192.0.2.9").exists())

    def test_an_unassigned_address_danbyte_already_has_is_taken(self):
        row = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.7.0.90", prefix=self.prefix
        )
        provision.apply_change(self.change())
        row.refresh_from_db()
        self.assertEqual(row.assigned_device.name, "edge-9")
        self.assertEqual(IPAddress.objects.filter(tenant=self.tenant).count(), 1)

    def test_a_proposal_missing_a_default_cannot_be_applied(self):
        change = self.change(role_id=None, reason="No role to adopt into.")
        with self.assertRaises(ValueError):
            apply_adoption(change)
        self.assertFalse(Device.objects.filter(name="edge-9").exists())

    def test_auto_mode_adopts_on_the_pass(self):
        self.conn.provision_mode = ZabbixConnection.AUTO
        self.conn.save(update_fields=["provision_mode"])
        with mock.patch.object(
            ZabbixClient, "all_hosts", return_value=[host("50", "edge-9", "10.7.0.90")]
        ):
            counts = provision.sync(self.conn)
        self.assertEqual(counts["adopt"], 1)
        self.assertEqual(counts["applied"], 1)
        self.assertTrue(Device.objects.filter(name="edge-9").exists())

    def test_an_adopted_device_is_never_pruned(self):
        provision.apply_change(self.change())
        dev = Device.objects.get(name="edge-9")
        # In scope, then out of it: the link was not created_here, so the prune
        # pass has no business with it.
        CheckState.objects.create(
            tenant=self.tenant, target_ip=dev.primary_ip, template=self.check,
            engine=self.engine, kind="zabbix", interval_seconds=300, next_run=timezone.now(),
        )
        self.conn.prune_hosts = True
        self.conn.prune_after_days = 0
        self.conn.save(update_fields=["prune_hosts", "prune_after_days"])
        CheckState.objects.all().delete()
        with mock.patch.object(ZabbixClient, "all_hosts", return_value=[host("50", "edge-9", "10.7.0.90")]):
            counts = provision.plan(self.conn)
        self.assertEqual(counts["prune"], 0)


class ApiTests(_Base):
    def setUp(self):
        super().setUp()
        from django.contrib.auth import get_user_model

        self.user = get_user_model().objects.create_superuser("root", "r@x.io", "pw")
        self.client.force_login(self.user)

    def test_the_defaults_have_to_be_the_tenants_own(self):
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        foreign = Site.objects.create(tenant=other, name="Elsewhere")
        r = self.client.patch(
            f"/api/zabbix/connections/{self.conn.id}/",
            {"adopt_site": str(foreign.id)}, content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("adopt_site", r.json())

    def test_the_connection_names_its_defaults(self):
        r = self.client.get(f"/api/zabbix/connections/{self.conn.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            r.json()["adopt_names"],
            {"site": "Aarhus", "role": "Switch", "device_type": "C9300-24T"},
        )
        self.assertTrue(r.json()["adopt_hosts"])


class PlacementRuleTests(_Base):
    """Where an adopted host lands, by what it looks like.

    A rule beats what the host says about itself, which beats the connection's
    defaults - and a rule sets only what it names.
    """

    def setUp(self):
        super().setUp()
        from .models import ZabbixAdoptionRule

        self.Rule = ZabbixAdoptionRule
        self.kbh = Site.objects.create(tenant=self.tenant, name="København")
        self.odense = Site.objects.create(tenant=self.tenant, name="Odense")

    def rule(self, pattern, site, scope="name", **kw):
        return self.Rule.objects.create(
            tenant=self.tenant, connection=self.conn, scope=scope,
            pattern=pattern, site=site, **kw,
        )

    def detail(self, hostid="50"):
        [change] = self.adoptions()
        return change.detail

    def test_a_name_glob_places_the_host(self):
        self.rule("kbh-*", self.kbh)
        self.plan([host("50", "kbh-asw1", "10.7.0.90")])
        d = self.detail()
        self.assertEqual(d["site_id"], str(self.kbh.id))
        self.assertEqual(d["rule"], "kbh-*")

    def test_a_rule_beats_a_group_that_names_a_site(self):
        self.rule("kbh-*", self.kbh)
        self.plan([host("50", "kbh-asw1", "10.7.0.90", groups=["Odense"])])
        self.assertEqual(self.detail()["site_id"], str(self.kbh.id))

    def test_a_group_naming_a_site_still_beats_the_default(self):
        self.rule("nomatch-*", self.kbh)
        self.plan([host("50", "edge-9", "10.7.0.90", groups=["Odense"])])
        self.assertEqual(self.detail()["site_id"], str(self.odense.id))

    def test_a_regex_rule(self):
        self.rule("regex:^(kbh|cph)-", self.kbh)
        self.plan([host("50", "CPH-core1", "10.7.0.90")])
        self.assertEqual(self.detail()["site_id"], str(self.kbh.id))

    def test_a_group_rule(self):
        self.rule("Linux*", self.odense, scope="group")
        self.plan([host("50", "edge-9", "10.7.0.90", groups=["Linux servers"])])
        self.assertEqual(self.detail()["site_id"], str(self.odense.id))

    def test_an_address_rule_takes_a_cidr(self):
        self.rule("10.7.0.0/24", self.odense, scope="ip")
        self.plan([host("50", "edge-9", "10.7.0.90")])
        self.assertEqual(self.detail()["site_id"], str(self.odense.id))

    def test_lowest_weight_wins(self):
        self.rule("*", self.odense, weight=200)
        self.rule("kbh-*", self.kbh, weight=10)
        self.plan([host("50", "kbh-asw1", "10.7.0.90")])
        self.assertEqual(self.detail()["site_id"], str(self.kbh.id))

    def test_a_rule_sets_only_what_it_names(self):
        """Site from the rule, type from the inventory model, role from the
        connection - each field decided on its own."""
        other = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.dtype.manufacturer,
            name="C9500-48Y4C", model="C9500-48Y4C",
        )
        self.rule("kbh-*", self.kbh)
        self.plan([host("50", "kbh-core1", "10.7.0.90", model="c9500-48y4c")])
        d = self.detail()
        self.assertEqual(d["site_id"], str(self.kbh.id))
        self.assertEqual(d["device_type_id"], str(other.id))
        self.assertEqual(d["role_id"], str(self.role.id))

    def test_a_rule_can_also_name_the_role_and_type(self):
        ap = DeviceRole.objects.create(tenant=self.tenant, name="AP", slug="ap")
        self.rule("*-ap?", self.kbh, role=ap)
        self.plan([host("50", "kbh-ap1", "10.7.0.90")])
        self.assertEqual(self.detail()["role_id"], str(ap.id))

    def test_a_disabled_rule_does_nothing(self):
        self.rule("kbh-*", self.kbh, enabled=False)
        self.plan([host("50", "kbh-asw1", "10.7.0.90")])
        self.assertEqual(self.detail()["site_id"], str(self.site.id))

    def test_a_broken_regex_matches_nothing(self):
        self.rule("regex:(", self.kbh)
        self.plan([host("50", "kbh-asw1", "10.7.0.90")])
        self.assertEqual(self.detail()["site_id"], str(self.site.id))


class PlacementRuleApiTests(_Base):
    def setUp(self):
        super().setUp()
        from django.contrib.auth import get_user_model

        self.user = get_user_model().objects.create_superuser("root", "r@x.io", "pw")
        self.client.force_login(self.user)

    def test_a_broken_regex_is_refused_on_save(self):
        r = self.client.post(
            "/api/zabbix/adoption-rules/",
            {"connection": str(self.conn.id), "scope": "name", "pattern": "regex:(",
             "site": str(self.site.id)},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("pattern", r.json())

    def test_another_tenants_site_is_refused(self):
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        foreign = Site.objects.create(tenant=other, name="Elsewhere")
        r = self.client.post(
            "/api/zabbix/adoption-rules/",
            {"connection": str(self.conn.id), "scope": "name", "pattern": "x*",
             "site": str(foreign.id)},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_another_tenants_connection_is_refused_for_both_rule_kinds(self):
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        foreign = ZabbixConnection.objects.create(
            tenant=other, name="theirs", url="https://z2.example.com",
            credentials={"token": TOKEN}, version="7.0.30",
        )
        r = self.client.post(
            "/api/zabbix/adoption-rules/",
            {"connection": str(foreign.id), "scope": "name", "pattern": "x*",
             "site": str(self.site.id)},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        r = self.client.post(
            "/api/zabbix/template-rules/",
            {"connection": str(foreign.id), "scope": "tenant", "templates": ["ICMP Ping"]},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_the_list_says_the_names(self):
        from .models import ZabbixAdoptionRule

        ZabbixAdoptionRule.objects.create(
            tenant=self.tenant, connection=self.conn, pattern="kbh-*", site=self.site,
        )
        r = self.client.get(f"/api/zabbix/adoption-rules/?connection={self.conn.id}")
        self.assertEqual(r.status_code, 200, r.content)
        [row] = r.json()["results"]
        self.assertEqual(row["site_name"], "Aarhus")
        self.assertEqual(row["scope_display"], "Host name")
