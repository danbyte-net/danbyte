"""``include=card`` on /api/topology/: each device node's resolved card lines
and their values, ``meta.card``, the cost (flat in the node count), the
loopback IP scope and tenant isolation. Also: trace-map device nodes carry
``status_mini``."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api import topology_enrich as te
from api.models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    IPAddress,
    IPRole,
    Manufacturer,
    Platform,
    Prefix,
    Rack,
    Site,
)
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.deployment import TOPOLOGY_CARD_FIELD_DEFAULTS
from core.models import (
    DeploymentSettings,
    Organization,
    Tag,
    Tenant,
    TenantSettings,
)
from customization.models import CustomField


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        # Created up front so a first load's insert never lands in a count.
        self.dep = DeploymentSettings.load()
        self.site = Site.objects.create(tenant=self.tenant, name="dc-1")
        self.mfr = Manufacturer.objects.create(
            tenant=self.tenant, name="Acme", slug="acme"
        )
        self.type_os = Platform.objects.create(
            tenant=self.tenant, name="AcmeOS", slug="acmeos"
        )
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, name="X1", model="X1",
            platform=self.type_os,
        )
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Core switch", slug="core_sw"
        )
        self.active = status_for(self.tenant)
        self.loop_role = IPRole.objects.create(
            tenant=self.tenant, name="Loopback", slug="loopback"
        )
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", site=self.site
        )
        self.loop_prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.255.0.0/24", site=self.site
        )
        self._n = 0

    def _device(self, name, **kw):
        kw.setdefault("device_type", self.dtype)
        kw.setdefault("role", self.role)
        kw.setdefault("site", self.site)
        kw.setdefault("status", self.active)
        return Device.objects.create(tenant=self.tenant, name=name, **kw)

    def _ip(self, device=None, prefix=None, role=None, **kw):
        prefix = prefix or self.prefix
        self._n += 1
        net = prefix.cidr.rsplit(".", 1)[0]
        kw.setdefault("ip_address", f"{net}.{self._n}")
        return IPAddress.objects.create(
            tenant=prefix.tenant, prefix=prefix, assigned_device=device,
            role=role, site=prefix.site, **kw,
        )

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _superuser(self):
        u = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        return u

    def _graph(self, **body):
        body.setdefault("include", ["card"])
        r = self.client.post("/api/topology/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _cards(self, **body):
        g = self._graph(**body)
        return {n["data"]["name"]: n["data"]["card"] for n in g["nodes"]}, g


class CardPayloadTests(_Base):
    def setUp(self):
        super().setUp()
        self._login(self._superuser())

    def test_default_payload_has_no_card(self):
        self._device("sw-1")
        g = self.client.get("/api/topology/").json()
        self.assertNotIn("meta", g)
        self.assertNotIn("card", g["nodes"][0]["data"])

    def test_built_in_default_and_meta(self):
        d = self._device("sw-1")
        d.primary_ip = self._ip(d)
        d.serial_number = "SN-1"
        d.save()
        cards, g = self._cards()
        card = cards["sw-1"]
        self.assertEqual(card["fields"], TOPOLOGY_CARD_FIELD_DEFAULTS)
        self.assertEqual(card["source"], "default")
        # `monitor` is a pill the page fills; it has no value here.
        self.assertEqual(set(card["values"]), {"primary_ip", "loopback", "serial"})
        self.assertEqual(card["values"]["serial"], "SN-1")
        self.assertEqual(card["values"]["primary_ip"], {
            "id": str(d.primary_ip_id), "address": "10.0.0.1",
            "cidr": "10.0.0.1/24",
        })
        self.assertEqual(card["values"]["loopback"], [])
        self.assertEqual(g["meta"]["card"], {
            "fields": TOPOLOGY_CARD_FIELD_DEFAULTS, "source": "default",
            "uses_monitor": True,
        })

    def test_resolution_order(self):
        """device → the query's card_fields → role (a slug with "_") →
        tenant → deployment → default."""
        self.dep.topology_card_fields = ["serial"]
        self.dep.topology_card_role_overrides = {"role:core_sw": ["asset_tag"]}
        self.dep.save()
        self._device("roled")
        self._device("plain", role=None)
        self._device("own", topology_card=["platform"])

        cards, g = self._cards()
        self.assertEqual(
            {n: (c["fields"], c["source"]) for n, c in cards.items()},
            {
                "roled": (["asset_tag"], "role"),
                "plain": (["serial"], "deployment"),
                "own": (["platform"], "device"),
            },
        )
        self.assertEqual(
            g["meta"]["card"],
            {"fields": ["serial"], "source": "deployment", "uses_monitor": False},
        )

        cards, g = self._cards(card_fields=["rack", "tags"])
        self.assertEqual(cards["roled"]["source"], "view")
        self.assertEqual(cards["plain"]["fields"], ["rack", "tags"])
        self.assertEqual(cards["own"]["source"], "device")
        # meta carries the effective global list, not the view's.
        self.assertEqual(g["meta"]["card"]["fields"], ["serial"])

        ts = TenantSettings.for_tenant(self.tenant)
        ts.override_topology_card = True
        ts.topology_card_fields = ["oob_ip"]
        ts.save()
        cards, g = self._cards()
        # A tenant override replaces the deployment's role lists too.
        self.assertEqual(cards["roled"]["fields"], ["oob_ip"])
        self.assertEqual(cards["roled"]["source"], "tenant")
        self.assertEqual(g["meta"]["card"]["source"], "tenant")

        ts.topology_card_fields = None
        ts.save()
        cards, _ = self._cards()
        self.assertEqual(
            (cards["plain"]["fields"], cards["plain"]["source"]),
            (TOPOLOGY_CARD_FIELD_DEFAULTS, "default"),
        )

    def test_empty_list_is_name_only(self):
        self._device("own", topology_card=[])
        self._device("other")
        cards, _ = self._cards()
        self.assertEqual(cards["own"], {"fields": [], "source": "device", "values": {}})
        cards, g = self._cards(card_fields=[])
        self.assertEqual(cards["other"], {"fields": [], "source": "view", "values": {}})
        self.assertFalse(g["meta"]["card"]["uses_monitor"])

    def test_node_keys_carry_no_value(self):
        self._device("sw-1")
        cards, _ = self._cards(
            card_fields=["status", "device_type", "role", "site", "location"]
        )
        self.assertEqual(cards["sw-1"]["values"], {})
        self.assertEqual(len(cards["sw-1"]["fields"]), 5)

    def test_ips_serial_asset_tag(self):
        d = self._device("sw-1", serial_number="SN-9", asset_tag="")
        d.primary_ip = self._ip(d)
        d.oob_ip = self._ip(d, mask_length=31)
        d.save()
        cards, _ = self._cards(
            card_fields=["primary_ip", "secondary_ip", "oob_ip", "serial", "asset_tag"]
        )
        v = cards["sw-1"]["values"]
        self.assertEqual(v["primary_ip"]["cidr"], "10.0.0.1/24")
        self.assertIsNone(v["secondary_ip"])
        # mask_length wins over the containing prefix's length.
        self.assertEqual(v["oob_ip"]["cidr"], "10.0.0.2/31")
        self.assertEqual((v["serial"], v["asset_tag"]), ("SN-9", ""))

    def test_loopback_comes_from_the_ip_role(self):
        d = self._device("sw-1")
        other = self._device("sw-2")
        lo = self._ip(d, prefix=self.loop_prefix, role=self.loop_role, mask_length=32)
        self._ip(d)  # an ordinary address on the device
        self._ip(other, prefix=self.loop_prefix, role=self.loop_role)
        not_loop = IPRole.objects.create(tenant=self.tenant, name="VIP", slug="vip")
        self._ip(d, prefix=self.loop_prefix, role=not_loop)
        cards, _ = self._cards(card_fields=["loopback"])
        self.assertEqual(cards["sw-1"]["values"]["loopback"], [
            {"id": str(lo.id), "address": lo.ip_address, "cidr": f"{lo.ip_address}/32"},
        ])
        self.assertEqual(len(cards["sw-2"]["values"]["loopback"]), 1)

    def test_platform_falls_back_to_the_type(self):
        own = Platform.objects.create(tenant=self.tenant, name="Own", slug="own")
        self._device("inherits")
        self._device("own", platform=own)
        bare = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, name="X2", model="X2"
        )
        self._device("none", device_type=bare)
        self._device("typeless", device_type=None)
        cards, _ = self._cards(card_fields=["platform", "manufacturer"])
        plat = {n: c["values"]["platform"] for n, c in cards.items()}
        self.assertEqual(plat["inherits"], {"id": str(self.type_os.id), "name": "AcmeOS"})
        self.assertEqual(plat["own"], {"id": str(own.id), "name": "Own"})
        self.assertIsNone(plat["none"])
        self.assertIsNone(plat["typeless"])
        self.assertEqual(
            cards["own"]["values"]["manufacturer"],
            {"id": str(self.mfr.id), "name": "Acme"},
        )
        self.assertIsNone(cards["typeless"]["values"]["manufacturer"])

    def test_rack_and_tags(self):
        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R1")
        d = self._device("racked", rack=rack, position=12)
        self._device("loose")
        d.tags.add(
            Tag.objects.create(tenant=self.tenant, name="prod", slug="prod", color="#10b981")
        )
        cards, _ = self._cards(card_fields=["rack", "tags"])
        self.assertEqual(
            cards["racked"]["values"],
            {"rack": {"id": str(rack.id), "name": "R1", "position": 12},
             "tags": [{"name": "prod", "slug": "prod", "color": "#10b981"}]},
        )
        self.assertEqual(cards["loose"]["values"], {"rack": None, "tags": []})

    def test_hidden_and_undefined_custom_fields_are_dropped(self):
        CustomField.objects.create(
            tenant=self.tenant, key="owner", label="Owner", applies_to=["device"]
        )
        CustomField.objects.create(
            tenant=self.tenant, key="netbox_id", label="NetBox id",
            applies_to=["device"], hidden=True,
        )
        CustomField.objects.create(
            tenant=self.tenant, key="vlan_note", label="Note", applies_to=["vlan"]
        )
        self._device("sw-1", custom_fields={
            "owner": "netops", "netbox_id": 57, "vlan_note": "x", "stray": "y",
        })
        self._device("sw-2")
        cards, _ = self._cards(card_fields=[
            "serial", "cf_owner", "cf_netbox_id", "cf_vlan_note", "cf_stray",
        ])
        self.assertEqual(cards["sw-1"]["fields"], ["serial", "cf_owner"])
        self.assertEqual(cards["sw-1"]["values"], {"serial": "", "cf_owner": "netops"})
        self.assertEqual(cards["sw-2"]["values"], {"serial": "", "cf_owner": None})

    def test_cost_is_flat_in_the_node_count(self):
        CustomField.objects.create(
            tenant=self.tenant, key="owner", label="Owner", applies_to=["device"]
        )
        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R1")
        tag = Tag.objects.create(tenant=self.tenant, name="prod", slug="prod")
        fields = [
            "primary_ip", "loopback", "platform", "manufacturer", "rack", "tags",
            "cf_owner", "serial",
        ]

        def add(count, start):
            for i in range(start, start + count):
                own = Platform.objects.create(
                    tenant=self.tenant, name=f"P{i}", slug=f"p{i}"
                )
                d = self._device(
                    f"d{i}", rack=rack, platform=own if i % 2 else None,
                    custom_fields={"owner": f"o{i}"},
                )
                d.primary_ip = self._ip(d)
                d.save()
                self._ip(d, prefix=self.loop_prefix, role=self.loop_role)
                d.tags.add(tag)

        def measure():
            counted = []
            real = te.enrich_card

            def spy(ctx):
                with CaptureQueriesContext(connection) as q:
                    real(ctx)
                counted.append(len(q.captured_queries))

            with mock.patch.object(te, "enrich_card", side_effect=spy):
                g = self._graph(card_fields=fields)
            self.assertEqual(len(counted), 1)
            return counted[0], g

        add(3, 0)
        small, g = measure()
        self.assertEqual(len(g["nodes"]), 3)
        add(27, 3)
        large, g = measure()
        self.assertEqual(len(g["nodes"]), 30)
        self.assertEqual(small, large)
        self.assertLessEqual(large, 10)
        self.assertTrue(all(
            n["data"]["card"]["values"]["loopback"] for n in g["nodes"]
        ))


class LoopbackScopeTests(_Base):
    """Primary/secondary/OOB are device attributes; loopbacks are IP rows
    and pass the caller's ipaddress.view scope."""

    def setUp(self):
        super().setUp()
        self.site_b = Site.objects.create(tenant=self.tenant, name="dc-2")
        self.prefix_b = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/24", site=self.site_b
        )
        self.dev = self._device("sw-1")
        self.lo_a = self._ip(self.dev, prefix=self.loop_prefix, role=self.loop_role)
        self.lo_b = self._ip(self.dev, prefix=self.prefix_b, role=self.loop_role)
        # The primary address is also a loopback, outside the IP scope.
        self.dev.primary_ip = self.lo_b
        self.dev.save()
        self.user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=self.user, role="custom").tenants.add(
            self.tenant
        )
        self._grant("device")

    def _grant(self, obj_type, site=None):
        perm = ObjectPermission.objects.create(
            name=f"{obj_type}-view", object_types=[obj_type], actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        if site is not None:
            perm.sites.add(site)

    def _values(self):
        self._login(self.user)
        cards, _ = self._cards(card_fields=["primary_ip", "loopback"])
        return cards["sw-1"]["values"]

    def test_no_ip_grant_hides_loopbacks_not_the_primary(self):
        v = self._values()
        self.assertEqual(v["primary_ip"]["id"], str(self.lo_b.id))
        self.assertEqual(v["loopback"], [])

    def test_site_scoped_ip_grant(self):
        self._grant("ipaddress", site=self.site)
        v = self._values()
        self.assertEqual(v["primary_ip"]["id"], str(self.lo_b.id))
        self.assertEqual([ip["id"] for ip in v["loopback"]], [str(self.lo_a.id)])

    def test_unscoped_ip_grant(self):
        self._grant("ipaddress")
        v = self._values()
        self.assertEqual(
            {ip["id"] for ip in v["loopback"]}, {str(self.lo_a.id), str(self.lo_b.id)}
        )


class TenantIsolationTests(_Base):
    def test_another_tenants_rows_never_apply(self):
        other = Tenant.objects.create(org=self.org, name="B", slug="b")
        ts = TenantSettings.for_tenant(other)
        ts.override_topology_card = True
        ts.topology_card_fields = ["asset_tag"]
        ts.topology_card_role_overrides = {"role:core_sw": ["rack"]}
        ts.save()
        # Visible in B, hidden in A: A's value stays off the card.
        CustomField.objects.create(
            tenant=other, key="owner", label="Owner", applies_to=["device"]
        )
        CustomField.objects.create(
            tenant=self.tenant, key="owner", label="Owner", applies_to=["device"],
            hidden=True,
        )
        d = self._device("sw-1", custom_fields={"owner": "a-team"})
        # A B-tenant loopback pointing at A's device (bad data) stays out.
        b_role = IPRole.objects.create(tenant=other, name="Loopback", slug="loopback")
        b_prefix = Prefix.objects.create(tenant=other, cidr="10.255.0.0/24")
        self._ip(d, prefix=b_prefix, role=b_role)

        self._login(self._superuser())
        cards, g = self._cards()
        self.assertEqual(cards["sw-1"]["source"], "default")
        self.assertEqual(cards["sw-1"]["values"]["loopback"], [])
        self.assertEqual(g["meta"]["card"]["source"], "default")
        cards, _ = self._cards(card_fields=["cf_owner", "loopback"])
        self.assertEqual(cards["sw-1"]["fields"], ["loopback"])
        self.assertEqual(cards["sw-1"]["values"], {"loopback": []})


class TraceStatusTests(_Base):
    def test_trace_device_nodes_carry_status_mini(self):
        a = self._device("sw-a")
        b = self._device("sw-b", status=None)
        ia = Interface.objects.create(device=a, name="e1")
        ib = Interface.objects.create(device=b, name="e1")
        cab = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cab, end="A", interface=ia)
        CableTermination.objects.create(cable=cab, end="B", interface=ib)
        self._login(self._superuser())
        r = self.client.get(f"/api/interfaces/{ia.id}/trace/")
        self.assertEqual(r.status_code, 200, r.content)
        devs = {
            n["data"]["name"]: n["data"]
            for n in r.json()["nodes"] if n["type"] == "device"
        }
        self.assertEqual(devs["sw-a"]["status_mini"], {
            "id": str(self.active.id), "name": self.active.name,
            "slug": "active", "color": self.active.color,
            "text_color": self.active.text_color, "is_default": True,
        })
        self.assertIsNone(devs["sw-b"]["status_mini"])
