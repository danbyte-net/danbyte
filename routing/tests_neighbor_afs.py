"""BGP neighbour policy per address family.

Rows for sessions and peer groups, the v0.16 ``address_families`` list kept
in step both ways, the resolution order (session row, session field, group
row, group field), the backfill that leaves every render byte-identical, and
the two acceptance renders: a CE's address-family block and a PE that sends
one neighbour different policies in ipv4 unicast and ipv4 vpn.
"""
from __future__ import annotations

import importlib

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    ASN,
    RIR,
    Device,
    DeviceType,
    ExportTemplate,
    Manufacturer,
    Site,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    BGPAddressFamily,
    BGPInstance,
    BGPNeighborAF,
    BGPPeerGroup,
    BGPSession,
    PrefixList,
    RoutingPolicy,
    effective_afs,
)
from .render import routing_context

User = get_user_model()

# The FRR block from the routing-templates page, written against the v0.16
# keys only: what an existing template prints.
LEGACY_TEMPLATE = """{% for b in routing.bgp %}router bgp {{ b.asn }}
{% for s in b.sessions %} neighbor {{ s.remote_address }} remote-as {{ s.remote_asn }}
{% endfor %}{% for af in b.address_families %} address-family {{ af.afi_safi.replace('-', ' ') }}
{% for s in b.sessions if af.afi_safi in s.address_families %}  neighbor {{ s.remote_address }} activate
{% if s.next_hop_self %}  neighbor {{ s.remote_address }} next-hop-self
{% endif %}{% if s.export_policy %}  neighbor {{ s.remote_address }} route-map {{ s.export_policy }} out
{% endif %}{% if s.import_policy %}  neighbor {{ s.remote_address }} route-map {{ s.import_policy }} in
{% endif %}{% if s.soft_reconfiguration %}  neighbor {{ s.remote_address }} soft-reconfiguration inbound
{% endif %}{% endfor %} exit-address-family
{% endfor %}{% endfor %}{% for name, p in routing.policies.items() %}route-map {{ name }}
{% endfor %}"""

# The same block against the per-family keys.
AF_TEMPLATE = """{% for b in routing.bgp %}{% for af in b.address_families %}address-family {{ af.afi_safi|replace("-"," ") }}
{% for s in b.sessions if af.afi_safi in s.af_by_name %}{% set a = s.af_by_name[af.afi_safi] %}  neighbor {{ s.remote_address }} activate
{% if a.soft_reconfiguration %}  neighbor {{ s.remote_address }} soft-reconfiguration inbound
{% endif %}{% if a.import_policy %}  neighbor {{ s.remote_address }} route-map {{ a.import_policy }} in
{% endif %}{% if a.export_policy %}  neighbor {{ s.remote_address }} route-map {{ a.export_policy }} out
{% endif %}{% if a.prefix_list_out %}  neighbor {{ s.remote_address }} prefix-list {{ a.prefix_list_out }} out
{% endif %}{% endfor %}{% for n in af.networks %}  network {{ n }}
{% endfor %}exit-address-family
{% endfor %}{% endfor %}"""


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.ce = Device.objects.create(tenant=self.tenant, name="dc02-ce", device_type=dt,
                                        site=self.ams)
        self.pe = Device.objects.create(tenant=self.tenant, name="pe1", device_type=dt,
                                        site=self.lon)
        rir = RIR.objects.create(tenant=self.tenant, name="P", slug="p")
        self.asn = ASN.objects.create(tenant=self.tenant, asn=65062, rir=rir)
        self.pe_asn = ASN.objects.create(tenant=self.tenant, asn=65000, rir=rir)
        self.site_out = RoutingPolicy.objects.create(tenant=self.tenant, name="SITE-OUT")
        self.vpn_out = RoutingPolicy.objects.create(tenant=self.tenant, name="VPN-OUT")
        self.v4_in = RoutingPolicy.objects.create(tenant=self.tenant, name="V4-IN")
        self.pl = PrefixList.objects.create(tenant=self.tenant, name="SITE-NETS")
        self.inst = BGPInstance.objects.create(tenant=self.tenant, device=self.ce, asn=self.asn)
        self.pe_inst = BGPInstance.objects.create(tenant=self.tenant, device=self.pe,
                                                  asn=self.pe_asn)
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _session(self, inst=None, **kw):
        return BGPSession.objects.create(
            tenant=self.tenant, instance=inst or self.inst, remote_asn=kw.pop("remote_asn", 65000),
            **kw,
        )

    def _render(self, dev, code):
        tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name=f"t{ExportTemplate.objects.count()}",
            object_type="device", template_code=code,
        )
        r = self.client.get(f"/api/devices/{dev.id}/render/?template={tmpl.id}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["output"]


class MirrorTests(_Base):
    def test_the_list_makes_rows_and_rows_rewrite_the_list(self):
        s = self._session(remote_address="10.0.0.1",
                          address_families=["ipv4-unicast", "ipv6-unicast"])
        self.assertEqual(sorted(s.afs.values_list("afi_safi", flat=True)),
                         ["ipv4-unicast", "ipv6-unicast"])
        # A row turned off leaves the list.
        row = s.afs.get(afi_safi="ipv6-unicast")
        r = self.client.patch(f"/api/routing/bgp-neighbor-afs/{row.id}/",
                              {"activate": False}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        s.refresh_from_db()
        self.assertEqual(s.address_families, ["ipv4-unicast"])
        # A row added through the endpoint joins it.
        r = self.client.post("/api/routing/bgp-neighbor-afs/", {
            "session_id": str(s.id), "afi_safi": "vpnv4-unicast",
            "export_policy_id": str(self.vpn_out.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        s.refresh_from_db()
        self.assertEqual(s.address_families, ["ipv4-unicast", "vpnv4-unicast"])

    def test_a_legacy_write_keeps_a_row_with_policy(self):
        s = self._session(remote_address="10.0.0.1",
                          address_families=["ipv4-unicast", "vpnv4-unicast"])
        s.afs.filter(afi_safi="vpnv4-unicast").update(export_policy=self.vpn_out)
        r = self.client.patch(f"/api/routing/bgp-sessions/{s.id}/",
                              {"address_families": ["ipv4-unicast"]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["address_families"], ["ipv4-unicast"])
        kept = s.afs.get(afi_safi="vpnv4-unicast")
        self.assertFalse(kept.activate)
        self.assertEqual(kept.export_policy, self.vpn_out)
        # A bare row is simply dropped; listing it again brings it back on.
        r = self.client.patch(f"/api/routing/bgp-sessions/{s.id}/",
                              {"address_families": ["vpnv4-unicast"]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            {(x.afi_safi, x.activate) for x in s.afs.all()}, {("vpnv4-unicast", True)}
        )

    def test_the_mirror_always_equals_the_rows(self):
        g = BGPPeerGroup.objects.create(tenant=self.tenant, name="CE",
                                        address_families=["ipv4-unicast"])
        s = self._session(remote_address="10.0.0.2", peer_group=g)
        for parent in (g, s):
            parent.address_families = ["ipv6-unicast", "ipv4-unicast"]
            parent.save()
            parent.refresh_from_db()
            active = sorted(r.afi_safi for r in parent.afs.all() if r.activate)
            self.assertEqual(sorted(parent.address_families), active)

    def test_nested_read_on_session_and_group(self):
        g = BGPPeerGroup.objects.create(tenant=self.tenant, name="CE",
                                        address_families=["ipv4-unicast"],
                                        export_policy=self.site_out)
        s = self._session(remote_address="10.0.0.3", peer_group=g)
        body = self.client.get(f"/api/routing/bgp-sessions/{s.id}/").json()
        self.assertEqual(body["afs"], [])  # the session names none of its own
        self.assertEqual(body["effective_afs"][0]["afi_safi"], "ipv4-unicast")
        self.assertEqual(body["effective_afs"][0]["export_policy"]["name"], "SITE-OUT")
        body = self.client.get(f"/api/routing/bgp-peer-groups/{g.id}/").json()
        self.assertEqual(body["afs"][0]["effective"]["export_policy"]["name"], "SITE-OUT")


class ResolutionTests(_Base):
    def test_most_specific_wins(self):
        g = BGPPeerGroup.objects.create(tenant=self.tenant, name="G",
                                        address_families=["ipv4-unicast", "vpnv4-unicast"],
                                        export_policy=self.site_out, next_hop_self=True)
        g.afs.filter(afi_safi="vpnv4-unicast").update(export_policy=self.vpn_out,
                                                      next_hop_self=False)
        s = self._session(remote_address="10.0.0.1", peer_group=g)
        eff = {e["afi_safi"]: e for e in effective_afs(s)}
        # Group field, then group row.
        self.assertEqual(eff["ipv4-unicast"]["export_policy"], self.site_out)
        self.assertEqual(eff["vpnv4-unicast"]["export_policy"], self.vpn_out)
        self.assertIs(eff["vpnv4-unicast"]["next_hop_self"], False)
        # The session's own field beats the group's row ...
        s.export_policy = self.v4_in
        s.save()
        eff = {e["afi_safi"]: e for e in effective_afs(s)}
        self.assertEqual(eff["vpnv4-unicast"]["export_policy"], self.v4_in)
        # ... and the session's row beats its field.
        s.address_families = ["ipv4-unicast", "vpnv4-unicast"]
        s.save()
        s.afs.filter(afi_safi="vpnv4-unicast").update(export_policy=self.vpn_out)
        eff = {e["afi_safi"]: e for e in effective_afs(s)}
        self.assertEqual(eff["vpnv4-unicast"]["export_policy"], self.vpn_out)
        self.assertEqual(eff["ipv4-unicast"]["export_policy"], self.v4_in)

    def test_a_policy_of_another_tenant_is_refused(self):
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="O", slug="o")
        theirs = RoutingPolicy.objects.create(tenant=other, name="THEIRS")
        s = self._session(remote_address="10.0.0.1")
        r = self.client.post("/api/routing/bgp-neighbor-afs/", {
            "session_id": str(s.id), "afi_safi": "ipv4-unicast",
            "export_policy_id": str(theirs.id),
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("export_policy_id", r.json())

    def test_a_site_limited_user_writes_only_on_their_site(self):
        ce_s = self._session(remote_address="10.0.0.1")
        pe_s = self._session(inst=self.pe_inst, remote_address="10.0.0.2")
        user = User.objects.create_user("u")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="ams", object_types=["bgpneighboraf", "bgpsession", "routingpolicy"],
            actions=["view", "add", "change"],
        )
        p.users.add(user)
        p.sites.set([self.ams])
        self._login(user)
        ok = self.client.post("/api/routing/bgp-neighbor-afs/", {
            "session_id": str(ce_s.id), "afi_safi": "ipv4-unicast"}, format="json")
        self.assertEqual(ok.status_code, 201, ok.content)
        no = self.client.post("/api/routing/bgp-neighbor-afs/", {
            "session_id": str(pe_s.id), "afi_safi": "ipv4-unicast"}, format="json")
        self.assertIn(no.status_code, (400, 403), no.content)
        self.assertFalse(BGPNeighborAF.objects.filter(session=pe_s).exists())


class BackfillTests(_Base):
    """The 0018 backfill on neighbours that only have the list: every render
    is byte-identical before and after."""

    def _fabric(self):
        g = BGPPeerGroup.objects.create(
            tenant=self.tenant, name="SPINES", address_families=["ipv4-unicast", "l2vpn-evpn"],
            next_hop_self=True, export_policy=self.site_out,
        )
        self._session(remote_address="10.0.0.1", peer_group=g)
        self._session(remote_address="10.0.0.2", address_families=["ipv6-unicast"],
                      import_policy=self.v4_in, soft_reconfiguration=True)
        self._session(remote_address="10.0.0.3",
                      address_families=["ipv4-unicast", "vpnv4-unicast"])
        for afi in ("ipv4-unicast", "ipv6-unicast", "vpnv4-unicast", "l2vpn-evpn"):
            BGPAddressFamily.objects.create(instance=self.inst, afi_safi=afi)
        # The pre-0.19 state: the lists, no rows (a raw delete, so the
        # mirror does not empty the lists).
        qs = BGPNeighborAF.objects.all()
        qs._raw_delete(qs.db)
        self.assertTrue(BGPSession.objects.exclude(address_families=[]).exists())

    def test_renders_are_byte_identical(self):
        self._fabric()
        from api.export_templates import render_device_config

        templates = [
            ExportTemplate(tenant=self.tenant, name="legacy", object_type="device",
                           template_code=LEGACY_TEMPLATE),
            ExportTemplate(tenant=self.tenant, name="af", object_type="device",
                           template_code=AF_TEMPLATE),
        ]
        before = [render_device_config(t, self.ce, self.tenant) for t in templates]
        ctx_before = routing_context(self.ce)
        mod = importlib.import_module("routing.migrations.0018_backfill_neighbor_afs")
        mod.backfill(django_apps, None)
        mod.backfill(django_apps, None)  # idempotent
        self.assertEqual(BGPNeighborAF.objects.count(), 5)
        after = [render_device_config(t, self.ce, self.tenant) for t in templates]
        self.assertEqual(before, after)
        self.assertIn("route-map SITE-OUT out", after[0])
        self.assertEqual(ctx_before, routing_context(self.ce))
        # The lists were left as they were.
        self.assertEqual(
            BGPSession.objects.get(remote_address="10.0.0.3").address_families,
            ["ipv4-unicast", "vpnv4-unicast"],
        )


class AcceptanceRenderTests(_Base):
    def test_the_ce_address_family_block(self):
        s = self._session(remote_address="10.62.0.1", address_families=["ipv4-unicast",
                                                                          "ipv6-unicast"])
        BGPNeighborAF.objects.filter(session=s, afi_safi="ipv4-unicast").update(
            export_policy=self.site_out, soft_reconfiguration=True,
        )
        BGPNeighborAF.objects.filter(session=s, afi_safi="ipv6-unicast").update(
            soft_reconfiguration=True,
        )
        BGPAddressFamily.objects.create(instance=self.inst, afi_safi="ipv4-unicast",
                                        networks=["10.62.0.0/24"])
        BGPAddressFamily.objects.create(instance=self.inst, afi_safi="ipv6-unicast")
        self.assertEqual(self._render(self.ce, AF_TEMPLATE), (
            "address-family ipv4 unicast\n"
            "  neighbor 10.62.0.1 activate\n"
            "  neighbor 10.62.0.1 soft-reconfiguration inbound\n"
            "  neighbor 10.62.0.1 route-map SITE-OUT out\n"
            "  network 10.62.0.0/24\n"
            "exit-address-family\n"
            "address-family ipv6 unicast\n"
            "  neighbor 10.62.0.1 activate\n"
            "  neighbor 10.62.0.1 soft-reconfiguration inbound\n"
            "exit-address-family\n"
        ))

    def test_a_pe_with_two_policies_to_one_neighbour(self):
        s = self._session(inst=self.pe_inst, remote_address="10.255.0.9",
                          address_families=["ipv4-unicast", "vpnv4-unicast"],
                          export_policy=self.site_out)
        BGPNeighborAF.objects.filter(session=s, afi_safi="ipv4-unicast").update(
            import_policy=self.v4_in, prefix_list_out=self.pl,
        )
        BGPNeighborAF.objects.filter(session=s, afi_safi="vpnv4-unicast").update(
            export_policy=self.vpn_out,
        )
        BGPAddressFamily.objects.create(instance=self.pe_inst, afi_safi="ipv4-unicast")
        BGPAddressFamily.objects.create(instance=self.pe_inst, afi_safi="vpnv4-unicast")
        self.assertEqual(self._render(self.pe, AF_TEMPLATE), (
            "address-family ipv4 unicast\n"
            "  neighbor 10.255.0.9 activate\n"
            "  neighbor 10.255.0.9 route-map V4-IN in\n"
            "  neighbor 10.255.0.9 route-map SITE-OUT out\n"
            "  neighbor 10.255.0.9 prefix-list SITE-NETS out\n"
            "exit-address-family\n"
            "address-family vpnv4 unicast\n"
            "  neighbor 10.255.0.9 activate\n"
            "  neighbor 10.255.0.9 route-map VPN-OUT out\n"
            "exit-address-family\n"
        ))
        block = routing_context(self.pe)
        # Every name a family uses is in the closure.
        self.assertEqual(set(block["policies"]), {"SITE-OUT", "V4-IN", "VPN-OUT"})
        self.assertEqual(set(block["prefix_lists"]), {"SITE-NETS"})
