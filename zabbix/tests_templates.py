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
        from .models import ZabbixProvisionRule

        return ZabbixProvisionRule.objects.create(
            tenant=self.tenant, connection=self.conn, scope=scope,
            object_id=object_id, templates=names, **kw
        )

    def plan(self, hosts):
        with mock.patch.object(ZabbixClient, "all_hosts", return_value=hosts):
            return provision.plan(self.conn)


class ResolutionTests(_Base):
    def test_rules_stack_rather_than_override(self):
        """"Everything gets ICMP", "switches also get SNMP" is two rules."""
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, ["ICMP Ping"])
        self.rule(ZabbixProvisionRule.SCOPE_ROLE, self.role.id, ["Generic by SNMP"])
        self.rule(ZabbixProvisionRule.SCOPE_MANUFACTURER, self.vendor.id,
                  ["Cisco IOS by SNMP"])
        device = self.make_device()
        got = templates.templates_for(device, templates.rules_for(self.conn))
        self.assertEqual(
            sorted(got), ["Cisco IOS by SNMP", "Generic by SNMP", "ICMP Ping"]
        )

    def test_a_rule_for_another_role_does_not_match(self):
        from .models import ZabbixProvisionRule

        other = DeviceRole.objects.create(
            tenant=self.tenant, name="Router", slug="router"
        )
        self.rule(ZabbixProvisionRule.SCOPE_ROLE, other.id, ["Router by SNMP"])
        self.assertEqual(
            templates.templates_for(self.make_device(), templates.rules_for(self.conn)),
            [],
        )

    def test_a_disabled_rule_contributes_nothing(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, ["ICMP Ping"],
                  enabled=False)
        self.assertEqual(templates.rules_for(self.conn), [])

    def test_platform_matches(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_PLATFORM, self.platform.id, ["IOS"])
        device = self.make_device(platform=self.platform)
        self.assertEqual(
            templates.templates_for(device, templates.rules_for(self.conn)), ["IOS"]
        )

    def test_duplicates_collapse(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, ["ICMP Ping"])
        self.rule(ZabbixProvisionRule.SCOPE_ROLE, self.role.id,
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
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None,
                  ["ICMP Ping", "Generic by SNMP"])
        device = self.make_device()
        self.scope(device)
        counts = self.plan([host("1", "sw1", "10.7.0.10", parents=["ICMP Ping"])])
        self.assertEqual(counts["template"], 1)
        change = ZabbixChange.objects.get(kind=ZabbixChange.TEMPLATE)
        self.assertEqual(change.detail["add"], ["Generic by SNMP"])

    def test_a_host_that_already_has_them_is_left_alone(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, ["ICMP Ping"])
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
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_ROLE, self.role.id, ["Generic by SNMP"])
        self.scope(self.make_device())
        self.plan([])
        change = ZabbixChange.objects.get(kind=ZabbixChange.CREATE)
        self.assertEqual(change.detail["templates"], ["Generic by SNMP"])


class ApplyTests(_Base):
    def test_creating_links_the_templates_it_found(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, ["ICMP Ping"])
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.CREATE, detail={"name": device.name},
        )
        with mock.patch.object(ZabbixClient, "group_ids", return_value=["4"]), \
                mock.patch.object(ZabbixClient, "template_ids",
                                  return_value={"ICMP Ping": "77"}), \
                mock.patch.object(ZabbixClient, "create_host",
                                  return_value="100") as create:
            provision.apply_change(change)
        payload = create.call_args[0][0]
        self.assertEqual(payload["templates"], [{"templateid": "77"}])

    def test_a_template_zabbix_does_not_have_is_reported(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, ["Nonesuch"])
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.CREATE, detail={"name": device.name},
        )
        with mock.patch.object(ZabbixClient, "group_ids", return_value=["4"]), \
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
        with mock.patch.object(ZabbixClient, "group_ids", return_value=["4"]), \
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
        with mock.patch.object(ZabbixClient, "group_ids", return_value=["4"]), \
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


class GroupRuleTests(_Base):
    """Host groups get the same rule engine templates got.

    Groups are how Zabbix scopes permissions, dashboards and actions, so which
    groups a host is in is the same kind of question as which templates it
    carries - and it was the one thing here still hard-coded.
    """

    def test_rules_stack_groups_too(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [], groups=["Danbyte"])
        self.rule(ZabbixProvisionRule.SCOPE_ROLE, self.role.id, [],
                  groups=["Switches"])
        got = templates.groups_for(self.make_device(), templates.rules_for(self.conn))
        self.assertEqual(sorted(got), ["Danbyte", "Switches"])

    def test_without_a_rule_the_site_is_still_the_group(self):
        """What every host got before rules existed, and the right default."""
        device = self.make_device()
        self.assertEqual(
            provision.group_names(device, templates.rules_for(self.conn)), ["HQ"]
        )

    def test_a_rule_replaces_the_site_default(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [], groups=["Estate"])
        device = self.make_device()
        self.assertEqual(
            provision.group_names(device, templates.rules_for(self.conn)),
            ["Estate"],
        )

    def test_a_device_with_no_site_still_gets_a_group(self):
        """Zabbix refuses a host with no group at all, so there is always one."""
        from api.models import Device

        device = Device.objects.create(
            tenant=self.tenant, name="loose", device_type=self.dtype,
            role=self.role,
        )
        self.assertEqual(
            provision.group_names(device, []), [provision.FALLBACK_GROUP]
        )

    def test_a_group_the_host_is_already_in_is_not_proposed(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [],
                  groups=["Estate", "Switches"])
        device = self.make_device()
        self.scope(device)
        counts = self.plan([{
            "hostid": "1", "host": "sw1", "name": "sw1", "status": "0",
            "interfaces": [{"interfaceid": "9", "ip": "10.7.0.10", "type": "1"}],
            "inventory": {}, "parentTemplates": [],
            "hostgroups": [{"groupid": "3", "name": "Estate"}],
        }])
        self.assertEqual(counts["template"], 1)
        change = ZabbixChange.objects.get(kind=ZabbixChange.TEMPLATE)
        self.assertEqual(change.detail["add_groups"], ["Switches"])

    def test_the_site_default_is_never_imposed_on_an_existing_host(self):
        """That default is for hosts Danbyte creates, not an opinion to push
        onto one somebody else already grouped."""
        device = self.make_device()
        self.scope(device)
        counts = self.plan([{
            "hostid": "1", "host": "sw1", "name": "sw1", "status": "0",
            "interfaces": [{"interfaceid": "9", "ip": "10.7.0.10", "type": "1"}],
            "inventory": {}, "parentTemplates": [], "hostgroups": [],
        }])
        self.assertEqual(counts["template"], 0)

    def test_creating_uses_the_rules_groups(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [],
                  groups=["Estate", "Switches"])
        device = self.make_device()
        change = ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.CREATE, detail={"name": device.name},
        )
        with mock.patch.object(ZabbixClient, "group_ids",
                               return_value=["7", "8"]) as gids, \
                mock.patch.object(ZabbixClient, "template_ids", return_value={}), \
                mock.patch.object(ZabbixClient, "create_host",
                                  return_value="100") as create:
            provision.apply_change(change)
        self.assertEqual(gids.call_args[0][0], ["Estate", "Switches"])
        self.assertEqual(
            create.call_args[0][0]["groups"],
            [{"groupid": "7"}, {"groupid": "8"}],
        )


class ScopeReportTests(_Base):
    """Scope is derived from the checks, so this is the only place it shows."""

    def test_a_device_in_scope_is_listed_with_what_it_would_get(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, ["ICMP Ping"],
                  groups=["Estate"])
        device = self.make_device()
        self.scope(device)
        rows = provision.scope_report(self.conn)
        self.assertEqual([r["device"]["name"] for r in rows], ["sw1"])
        self.assertEqual(rows[0]["templates"], ["ICMP Ping"])
        self.assertEqual(rows[0]["groups"], ["Estate"])
        self.assertEqual(rows[0]["address"], "10.7.0.10")
        self.assertEqual(rows[0]["hostid"], "")

    def test_a_device_with_no_zabbix_check_is_not_listed(self):
        self.make_device()
        self.assertEqual(provision.scope_report(self.conn), [])

    def test_a_pending_proposal_is_named(self):
        device = self.make_device()
        self.scope(device)
        self.plan([])
        rows = provision.scope_report(self.conn)
        self.assertEqual(rows[0]["pending"], ["create_host"])

    def test_a_linked_device_carries_its_host(self):
        device = self.make_device()
        self.scope(device)
        ZabbixHostLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            hostid="42", host_name="sw1", matched_by="address",
        )
        rows = provision.scope_report(self.conn)
        self.assertEqual(rows[0]["hostid"], "42")
        self.assertEqual(rows[0]["matched_by"], "address")


class ProxyRuleTests(_Base):
    """A host has exactly one proxy, so this is the rule field that does not
    stack: the most specific rule that names one wins, a site first."""

    def test_the_site_rule_beats_the_tenant_rule(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [], proxy="central")
        self.rule(ZabbixProvisionRule.SCOPE_SITE, self.site.id, [], proxy="hq-proxy")
        device = self.make_device()
        self.assertEqual(templates.proxy_for(device, templates.rules_for(self.conn)),
                         "hq-proxy")

    def test_a_rule_with_no_proxy_has_no_opinion(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_SITE, self.site.id, ["ICMP Ping"])
        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [], proxy="central")
        device = self.make_device()
        self.assertEqual(templates.proxy_for(device, templates.rules_for(self.conn)),
                         "central")

    def test_no_rule_means_the_server_polls(self):
        self.assertEqual(templates.proxy_for(self.make_device(), []), "")

    def test_a_site_rule_also_gives_templates(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_SITE, self.site.id, ["ICMP Ping"])
        device = self.make_device()
        self.assertEqual(
            templates.templates_for(device, templates.rules_for(self.conn)),
            ["ICMP Ping"],
        )


class ProxyProvisionTests(_Base):
    def _create_change(self):
        device = self.make_device()
        return device, ZabbixChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=device,
            kind=ZabbixChange.CREATE, detail={"name": device.name},
        )

    def test_creating_on_7_uses_proxyid_and_monitored_by(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [], proxy="p1")
        _device, change = self._create_change()
        with mock.patch.object(ZabbixClient, "group_ids", return_value=["4"]), \
                mock.patch.object(ZabbixClient, "template_ids", return_value={}), \
                mock.patch.object(ZabbixClient, "proxy_id", return_value="55"), \
                mock.patch.object(ZabbixClient, "create_host",
                                  return_value="100") as create:
            provision.apply_change(change)
        payload = create.call_args[0][0]
        self.assertEqual(payload["proxyid"], "55")
        self.assertEqual(payload["monitored_by"], 1)
        self.assertNotIn("proxy_hostid", payload)

    def test_creating_on_6_uses_proxy_hostid(self):
        """The field was renamed in 7.0, and a write with the wrong name is
        refused - so the version decides the write shape."""
        from .models import ZabbixProvisionRule

        self.conn.version = "6.4.10"
        self.conn.save(update_fields=["version"])
        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [], proxy="p1")
        _device, change = self._create_change()
        with mock.patch.object(ZabbixClient, "group_ids", return_value=["4"]), \
                mock.patch.object(ZabbixClient, "template_ids", return_value={}), \
                mock.patch.object(ZabbixClient, "proxy_id", return_value="55"), \
                mock.patch.object(ZabbixClient, "create_host",
                                  return_value="100") as create:
            provision.apply_change(change)
        payload = create.call_args[0][0]
        self.assertEqual(payload["proxy_hostid"], "55")
        self.assertNotIn("proxyid", payload)

    def test_an_unknown_proxy_is_reported_and_the_server_polls(self):
        """A proxy is a process somebody installed; inventing a record would
        park the host on one that will never poll it."""
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [], proxy="nonesuch")
        _device, change = self._create_change()
        with mock.patch.object(ZabbixClient, "group_ids", return_value=["4"]), \
                mock.patch.object(ZabbixClient, "template_ids", return_value={}), \
                mock.patch.object(ZabbixClient, "proxy_id", return_value=None), \
                mock.patch.object(ZabbixClient, "create_host",
                                  return_value="100") as create:
            result = provision.apply_change(change)
        self.assertNotIn("proxyid", create.call_args[0][0])
        self.assertIn("nonesuch", result)

    def test_a_server_polled_host_is_proposed_the_rules_proxy(self):
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [], proxy="p1")
        device = self.make_device()
        self.scope(device)
        self.plan([{
            "hostid": "1", "host": "sw1", "name": "sw1", "status": "0",
            "proxyid": "0", "monitored_by": "0",
            "interfaces": [{"interfaceid": "9", "ip": "10.7.0.10", "type": "1"}],
            "inventory": {}, "parentTemplates": [],
        }])
        change = ZabbixChange.objects.get(kind=ZabbixChange.UPDATE)
        self.assertEqual(change.detail["changes"]["_proxy"], "p1")

    def test_a_host_already_on_a_proxy_is_left_there(self):
        """Moving a host between proxies is somebody's decision, not a rule's."""
        from .models import ZabbixProvisionRule

        self.rule(ZabbixProvisionRule.SCOPE_TENANT, None, [], proxy="p1")
        device = self.make_device()
        self.scope(device)
        counts = self.plan([{
            "hostid": "1", "host": "sw1", "name": "sw1", "status": "0",
            "proxyid": "77", "monitored_by": "1",
            "interfaces": [{"interfaceid": "9", "ip": "10.7.0.10", "type": "1"}],
            "inventory": {}, "parentTemplates": [],
        }])
        self.assertEqual(counts["update"], 0)

    def test_a_6x_host_reports_its_proxy_too(self):
        self.assertEqual(provision.host_proxy_id({"proxy_hostid": "9"}), "9")
        self.assertEqual(provision.host_proxy_id({"proxyid": "0"}), "")
        self.assertEqual(provision.host_proxy_id({}), "")



class PlanReadTests(_Base):
    """What the planning read asks for. A fake host in a test can carry any
    key; only the real request proves the planner will see it."""

    def test_the_host_read_asks_for_groups_templates_and_proxy(self):
        with mock.patch.object(ZabbixClient, "call", return_value=[]) as call:
            ZabbixClient("http://z/api_jsonrpc.php", "t").all_hosts()
        params = call.call_args[0][1]
        self.assertIn("selectHostGroups", params)
        self.assertIn("selectParentTemplates", params)
        self.assertIn("proxyid", params["output"])
