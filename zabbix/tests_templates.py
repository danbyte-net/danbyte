"""Templates, SNMP interfaces and macros on a provisioned host (#162 phase 3).

Phase 2 produced correct hosts that monitored nothing. These assert the two
halves of fixing that - the right templates get linked, and an SNMP host gets
an interface its templates can actually poll through - and, as everywhere else
in this integration, that Danbyte does not overstep: it adds templates, never
removes them, and hands over a credential only when explicitly told to.
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
    Platform,
    Prefix,
    Site,
)
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings
from monitoring.models import (
    CheckState,
    CheckTemplate,
    MonitoringEngine,
    SnmpProfile,
)

from . import provision, templates
from .client import ZabbixClient
from .models import ZabbixChange, ZabbixConnection, ZabbixHostLink

TOKEN = "t" * 64


def host(hostid, name, ip=None, parents=()):
    return {
        "hostid": hostid,
        "host": name,
        "name": name,
        "status": "0",
        "interfaces": [{"interfaceid": "9", "ip": ip, "type": "1"}] if ip else [],
        "inventory": {},
        "parentTemplates": [{"templateid": str(i), "host": t}
                            for i, t in enumerate(parents, start=1)],
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
        self.vendor = Manufacturer.objects.create(
            tenant=self.tenant, name="Cisco", slug="cisco"
        )
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.vendor, model="C9300"
        )
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Switch", slug="switch"
        )
        self.platform = Platform.objects.create(
            tenant=self.tenant, name="IOS-XE", slug="ios-xe"
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.7.0.0/24")
        self.check = CheckTemplate.objects.create(
            tenant=self.tenant, name="Zabbix", kind="zabbix", interval_seconds=300
        )

    def make_device(self, name="sw1", last_octet=10, platform=None):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"10.7.0.{last_octet}/24",
            prefix=self.prefix,
        )
        device = Device.objects.create(
            tenant=self.tenant, name=name, device_type=self.dtype,
            role=self.role, site=self.site, platform=platform,
        )
        ip.assigned_device = device
        ip.save(update_fields=["assigned_device"])
        device.primary_ip = ip
        device.save(update_fields=["primary_ip"])
        return device

    def scope(self, device):
        CheckState.objects.create(
            tenant=self.tenant, target_ip=device.primary_ip, template=self.check,
            engine=self.engine, kind="zabbix", interval_seconds=300,
            next_run=timezone.now(),
        )

    def rule(self, scope, object_id, names, **kw):
        from .models import ZabbixTemplateRule

        return ZabbixTemplateRule.objects.create(
            tenant=self.tenant, connection=self.conn, scope=scope,
            object_id=object_id, templates=names, **kw
        )


class ResolutionTests(_Base):
    def test_rules_stack_rather_than_override(self):
        """"Everything gets ICMP", "switches also get SNMP" is two rules."""
        from .models import ZabbixTemplateRule

        self.rule(ZabbixTemplateRule.SCOPE_TENANT, None, ["ICMP Ping"])
        self.rule(ZabbixTemplateRule.SCOPE_ROLE, self.role.id, ["Generic by SNMP"])
        self.rule(ZabbixTemplateRule.SCOPE_MANUFACTURER, self.vendor.id,
                  ["Cisco IOS by SNMP"])
        device = self.make_device()
        got = templates.templates_for(device, templates.rules_for(self.conn))
        self.assertEqual(
            sorted(got), ["Cisco IOS by SNMP", "Generic by SNMP", "ICMP Ping"]
        )

    def test_a_rule_for_another_role_does_not_match(self):
        from .models import ZabbixTemplateRule

        other = DeviceRole.objects.create(
            tenant=self.tenant, name="Router", slug="router"
        )
        self.rule(ZabbixTemplateRule.SCOPE_ROLE, other.id, ["Router by SNMP"])
        self.assertEqual(
            templates.templates_for(self.make_device(), templates.rules_for(self.conn)),
            [],
        )

    def test_a_disabled_rule_contributes_nothing(self):
        from .models import ZabbixTemplateRule

        self.rule(ZabbixTemplateRule.SCOPE_TENANT, None, ["ICMP Ping"],
                  enabled=False)
        self.assertEqual(templates.rules_for(self.conn), [])

    def test_platform_matches(self):
        from .models import ZabbixTemplateRule

        self.rule(ZabbixTemplateRule.SCOPE_PLATFORM, self.platform.id, ["IOS"])
        device = self.make_device(platform=self.platform)
        self.assertEqual(
            templates.templates_for(device, templates.rules_for(self.conn)), ["IOS"]
        )

    def test_duplicates_collapse(self):
        from .models import ZabbixTemplateRule

        self.rule(ZabbixTemplateRule.SCOPE_TENANT, None, ["ICMP Ping"])
        self.rule(ZabbixTemplateRule.SCOPE_ROLE, self.role.id,
                  ["ICMP Ping", "Generic by SNMP"])
        got = templates.templates_for(self.make_device(), templates.rules_for(self.conn))
        self.assertEqual(got, ["ICMP Ping", "Generic by SNMP"])


class SnmpInterfaceTests(_Base):
    def test_no_profile_means_no_snmp_interface(self):
        self.assertIsNone(
            templates.snmp_interface(self.make_device(), None, "10.7.0.10")
        )

    def test_v2c_names_the_macro_not_the_community(self):
        profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="ro", slug="ro", version="v2c",
            secret_params={"community": "s3cret"},
        )
        iface = templates.snmp_interface(self.make_device(), profile, "10.7.0.10")
        self.assertEqual(iface["type"], templates.IFACE_SNMP)
        self.assertEqual(iface["details"]["version"], 2)
        # The interface is readable by anyone with Zabbix access; the secret
        # lives in the macro, which is not.
        self.assertEqual(iface["details"]["community"], templates.MACRO_COMMUNITY)
        self.assertNotIn("s3cret", str(iface))

    def test_v3_security_level_follows_what_the_profile_carries(self):
        profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="v3", slug="v3", version="v3",
            params={"username": "danbyte", "auth_proto": "sha256",
                    "priv_proto": "aes256"},
            secret_params={"auth_key": "a", "priv_key": "p"},
        )
        d = templates.snmp_interface(self.make_device(), profile, "10.7.0.10")["details"]
        self.assertEqual(d["version"], 3)
        self.assertEqual(d["securityname"], "danbyte")
        self.assertEqual(d["securitylevel"], 2)  # authPriv
        self.assertEqual(d["authprotocol"], 3)   # SHA256
        self.assertEqual(d["privprotocol"], 3)   # AES256
        self.assertEqual(d["authpassphrase"], templates.MACRO_AUTH)

    def test_v3_without_priv_is_auth_no_priv(self):
        profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="v3", slug="v3", version="v3",
            params={"username": "danbyte"}, secret_params={"auth_key": "a"},
        )
        d = templates.snmp_interface(self.make_device(), profile, "10.7.0.10")["details"]
        self.assertEqual(d["securitylevel"], 1)
        self.assertNotIn("privpassphrase", d)


class MacroTests(_Base):
    def test_the_community_becomes_a_secret_macro(self):
        profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="ro", slug="ro", version="v2c",
            secret_params={"community": "public"},
        )
        macros = templates.snmp_macros(profile)
        self.assertEqual(macros, [{
            "macro": templates.MACRO_COMMUNITY, "value": "public",
            "type": templates.MACRO_SECRET,
        }])

    def test_an_empty_community_writes_nothing(self):
        """A host that looks configured and still cannot poll is worse than
        one that plainly has no credentials."""
        profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="ro", slug="ro", version="v2c",
            secret_params={},
        )
        self.assertEqual(templates.snmp_macros(profile), [])


class PlanTests(_Base):
    def plan(self, hosts):
        with mock.patch.object(ZabbixClient, "all_hosts", return_value=hosts):
            return provision.plan(self.conn)

    def test_a_linked_host_missing_a_template_is_proposed(self):
        from .models import ZabbixTemplateRule

        self.rule(ZabbixTemplateRule.SCOPE_TENANT, None,
                  ["ICMP Ping", "Generic by SNMP"])
        device = self.make_device()
        self.scope(device)
        counts = self.plan([host("1", "sw1", "10.7.0.10", parents=["ICMP Ping"])])
        self.assertEqual(counts["template"], 1)
        change = ZabbixChange.objects.get(kind=ZabbixChange.TEMPLATE)
        self.assertEqual(change.detail["add"], ["Generic by SNMP"])

    def test_a_host_that_already_has_them_is_left_alone(self):
        from .models import ZabbixTemplateRule

        self.rule(ZabbixTemplateRule.SCOPE_TENANT, None, ["ICMP Ping"])
        device = self.make_device()
        self.scope(device)
        counts = self.plan([host("1", "sw1", "10.7.0.10", parents=["ICMP Ping"])])
        self.assertEqual(counts["template"], 0)
        self.assertFalse(
            ZabbixChange.objects.filter(kind=ZabbixChange.TEMPLATE).exists()
        )

    def test_no_rules_means_no_template_proposals(self):
        device = self.make_device()
        self.scope(device)
        counts = self.plan([host("1", "sw1", "10.7.0.10")])
        self.assertEqual(counts["template"], 0)

    def test_a_create_says_which_templates_it_would_link(self):
        from .models import ZabbixTemplateRule

        self.rule(ZabbixTemplateRule.SCOPE_ROLE, self.role.id, ["Generic by SNMP"])
        self.scope(self.make_device())
        self.plan([])
        change = ZabbixChange.objects.get(kind=ZabbixChange.CREATE)
        self.assertEqual(change.detail["templates"], ["Generic by SNMP"])


class ApplyTests(_Base):
    def test_creating_links_the_templates_it_found(self):
        from .models import ZabbixTemplateRule

        self.rule(ZabbixTemplateRule.SCOPE_TENANT, None, ["ICMP Ping"])
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.CREATE, detail={"name": device.name},
        )
        with mock.patch.object(ZabbixClient, "group_id", return_value="4"), \
                mock.patch.object(ZabbixClient, "template_ids",
                                  return_value={"ICMP Ping": "77"}), \
                mock.patch.object(ZabbixClient, "create_host",
                                  return_value="100") as create:
            provision.apply_change(change)
        payload = create.call_args[0][0]
        self.assertEqual(payload["templates"], [{"templateid": "77"}])

    def test_a_template_zabbix_does_not_have_is_reported(self):
        from .models import ZabbixTemplateRule

        self.rule(ZabbixTemplateRule.SCOPE_TENANT, None, ["Nonesuch"])
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.CREATE, detail={"name": device.name},
        )
        with mock.patch.object(ZabbixClient, "group_id", return_value="4"), \
                mock.patch.object(ZabbixClient, "template_ids", return_value={}), \
                mock.patch.object(ZabbixClient, "create_host", return_value="100"):
            result = provision.apply_change(change)
        self.assertIn("Nonesuch", result)

    def test_credentials_are_withheld_unless_the_switch_is_on(self):
        SnmpProfile.objects.create(
            tenant=self.tenant, name="ro", slug="ro", version="v2c",
            secret_params={"community": "public"}, is_default=True,
        )
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.CREATE, detail={"name": device.name},
        )
        with mock.patch.object(ZabbixClient, "group_id", return_value="4"), \
                mock.patch.object(ZabbixClient, "template_ids", return_value={}), \
                mock.patch.object(ZabbixClient, "create_host",
                                  return_value="100") as create:
            provision.apply_change(change)
        payload = create.call_args[0][0]
        self.assertNotIn("macros", payload)
        # …but the interface is still built, because that is inventory, not a
        # credential: it names the macro an operator can fill in by hand.
        types = [i["type"] for i in payload["interfaces"]]
        self.assertIn(templates.IFACE_SNMP, types)

    def test_the_switch_hands_over_the_community_as_a_secret_macro(self):
        SnmpProfile.objects.create(
            tenant=self.tenant, name="ro", slug="ro", version="v2c",
            secret_params={"community": "public"}, is_default=True,
        )
        self.conn.send_snmp_credentials = True
        self.conn.save(update_fields=["send_snmp_credentials"])
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.CREATE, detail={"name": device.name},
        )
        with mock.patch.object(ZabbixClient, "group_id", return_value="4"), \
                mock.patch.object(ZabbixClient, "template_ids", return_value={}), \
                mock.patch.object(ZabbixClient, "create_host",
                                  return_value="100") as create:
            provision.apply_change(change)
        macros = create.call_args[0][0]["macros"]
        self.assertEqual(macros[0]["macro"], templates.MACRO_COMMUNITY)
        self.assertEqual(macros[0]["type"], templates.MACRO_SECRET)

    def test_linking_only_adds_what_is_missing(self):
        device = self.make_device()
        ZabbixHostLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            hostid="1", host_name="sw1",
        )
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.TEMPLATE,
            detail={"hostid": "1", "add": ["ICMP Ping", "Generic by SNMP"]},
        )
        with mock.patch.object(ZabbixClient, "host_templates",
                               return_value={"ICMP Ping"}), \
                mock.patch.object(ZabbixClient, "template_ids",
                                  return_value={"Generic by SNMP": "88"}) as ids, \
                mock.patch.object(ZabbixClient, "link_templates") as link:
            provision.apply_change(change)
        # Re-read at apply time: one linked by hand since the plan is not
        # linked again.
        self.assertEqual(ids.call_args[0][0], ["Generic by SNMP"])
        self.assertEqual(link.call_args[0][1], ["88"])

    def test_an_snmp_host_grows_the_interface_its_template_needs(self):
        """Zabbix refuses an SNMP template on a host with nowhere to poll -
        which is every host Danbyte made before it wrote SNMP interfaces."""
        SnmpProfile.objects.create(
            tenant=self.tenant, name="ro", slug="ro", version="v2c",
            secret_params={"community": "public"}, is_default=True,
        )
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.TEMPLATE,
            detail={"hostid": "1", "add": ["Generic by SNMP"]},
        )
        with mock.patch.object(ZabbixClient, "host_interfaces",
                               return_value=[{"interfaceid": "9", "type": "1"}]), \
                mock.patch.object(ZabbixClient, "create_interface",
                                  return_value="12") as create, \
                mock.patch.object(ZabbixClient, "host_templates", return_value=set()), \
                mock.patch.object(ZabbixClient, "template_ids",
                                  return_value={"Generic by SNMP": "88"}), \
                mock.patch.object(ZabbixClient, "link_templates"):
            provision.apply_change(change)
        self.assertEqual(create.call_args[0][1]["type"], templates.IFACE_SNMP)

    def test_an_snmp_interface_that_exists_is_left_alone(self):
        SnmpProfile.objects.create(
            tenant=self.tenant, name="ro", slug="ro", version="v2c",
            secret_params={"community": "public"}, is_default=True,
        )
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.TEMPLATE,
            detail={"hostid": "1", "add": ["Generic by SNMP"]},
        )
        with mock.patch.object(
            ZabbixClient, "host_interfaces",
            return_value=[{"interfaceid": "9", "type": "2", "port": "1161"}],
        ), mock.patch.object(ZabbixClient, "create_interface") as create, \
                mock.patch.object(ZabbixClient, "host_templates", return_value=set()), \
                mock.patch.object(ZabbixClient, "template_ids", return_value={}), \
                mock.patch.object(ZabbixClient, "link_templates"):
            provision.apply_change(change)
        create.assert_not_called()

    def test_a_missing_macro_is_topped_up_when_the_switch_is_on(self):
        SnmpProfile.objects.create(
            tenant=self.tenant, name="ro", slug="ro", version="v2c",
            secret_params={"community": "public"}, is_default=True,
        )
        self.conn.send_snmp_credentials = True
        self.conn.save(update_fields=["send_snmp_credentials"])
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.TEMPLATE,
            detail={"hostid": "1", "add": ["Generic by SNMP"]},
        )
        with mock.patch.object(
            ZabbixClient, "host_interfaces",
            return_value=[{"interfaceid": "9", "type": "2"}],
        ), mock.patch.object(ZabbixClient, "host_macro_names", return_value=set()), \
                mock.patch.object(ZabbixClient, "add_macros") as add, \
                mock.patch.object(ZabbixClient, "host_templates", return_value=set()), \
                mock.patch.object(ZabbixClient, "template_ids", return_value={}), \
                mock.patch.object(ZabbixClient, "link_templates"):
            provision.apply_change(change)
        self.assertEqual(add.call_args[0][1][0]["macro"], templates.MACRO_COMMUNITY)

    def test_a_macro_that_is_already_there_is_never_rewritten(self):
        """Its value may have been changed on purpose, and a secret macro's
        value never comes back - so presence is the only honest question."""
        SnmpProfile.objects.create(
            tenant=self.tenant, name="ro", slug="ro", version="v2c",
            secret_params={"community": "public"}, is_default=True,
        )
        self.conn.send_snmp_credentials = True
        self.conn.save(update_fields=["send_snmp_credentials"])
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.TEMPLATE,
            detail={"hostid": "1", "add": ["Generic by SNMP"]},
        )
        with mock.patch.object(
            ZabbixClient, "host_interfaces",
            return_value=[{"interfaceid": "9", "type": "2"}],
        ), mock.patch.object(ZabbixClient, "host_macro_names",
                             return_value={templates.MACRO_COMMUNITY}), \
                mock.patch.object(ZabbixClient, "add_macros") as add, \
                mock.patch.object(ZabbixClient, "host_templates", return_value=set()), \
                mock.patch.object(ZabbixClient, "template_ids", return_value={}), \
                mock.patch.object(ZabbixClient, "link_templates"):
            provision.apply_change(change)
        add.assert_not_called()

    def test_a_refusal_comes_back_in_zabbixs_own_words(self):
        """A count alone leaves the operator nothing to act on - and Zabbix's
        refusals are usually the answer."""
        from .client import ZabbixError

        device = self.make_device()
        ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.TEMPLATE, detail={"hostid": "1", "add": ["X"]},
        )
        with mock.patch.object(
            provision, "apply_change",
            side_effect=ZabbixError("both templates define icmpping"),
        ):
            done = provision.apply_pending(self.conn)
        self.assertEqual(done["failed"], 1)
        self.assertEqual(done["errors"][0]["device"], "sw1")
        self.assertIn("icmpping", done["errors"][0]["detail"])

    def test_an_address_change_reaches_the_interface(self):
        """`host.update` cannot move an address - without this the operator was
        told "Updated" and nothing happened."""
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.UPDATE,
            detail={"hostid": "1", "changes": {
                "_address": "10.7.0.10", "_interfaceid": "9"}},
        )
        with mock.patch.object(ZabbixClient, "update_host") as update, \
                mock.patch.object(ZabbixClient, "update_interface") as iface:
            provision.apply_change(change)
        update.assert_not_called()
        self.assertEqual(iface.call_args[0][0], "9")
        self.assertEqual(iface.call_args[0][1]["ip"], "10.7.0.10")
