"""#504: the renumber preview shows only rows the caller may view.

The plan is collected per tenant; every row in ``changes``, ``unchanged``
and ``linked`` passes the visibility rule of that object's own API. A row
the caller can't view is only counted in ``hidden_total``; a row the
renumber would write that they can't view refuses the renumber.
"""
from __future__ import annotations

import json

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import ASN, RIR, VRF, Aggregate, Device, IPAddress, Prefix, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant
from integrations.models import DhcpLease, DhcpScope, DnsDrift, DnsRecord, DnsZone
from monitoring.models import (
    ArpSighting,
    MonitoringDenySubnet,
    MonitoringEngine,
    RedfishEndpoint,
    SnmpProfile,
    SnmpProfileBinding,
    WatchedEndpoint,
)
from oxidized.models import OxidizedConnection, OxidizedNodeLink
from prtg.models import PrtgConnection, PrtgDeviceLink
from routing.models import ROA, PolicyRule


class _Base(APITestCase):
    separation = False

    def setUp(self):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = self.separation
        dep.save(update_fields=["enhanced_site_separation", "updated_at"])
        org = Organization.objects.create(name="Acme", slug="acme")
        self.t = t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.a = Site.objects.create(tenant=t, name="A")
        self.b = Site.objects.create(tenant=t, name="B")
        self.dev_a = Device.objects.create(tenant=t, name="a-web", site=self.a)
        self.dev_b = Device.objects.create(tenant=t, name="b-payroll-srv", site=self.b)
        self.corp = VRF.objects.create(tenant=t, name="CORP")
        self.p1 = Prefix.objects.create(tenant=t, cidr="10.52.0.0/24", site=self.a)
        self.p2 = Prefix.objects.create(tenant=t, cidr="10.53.0.0/24", site=self.a,
                                        vrf=self.corp)
        self.u = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=self.u).tenants.add(t)
        self.grant(["prefix"], ["view", "change"])
        self.root = User.objects.create_superuser("root", "r@a.c", "pw")
        self.login(self.u)

    def grant(self, types, actions=("view",), sites=("a",)):
        perm = ObjectPermission.objects.create(
            name=f"g{ObjectPermission.objects.count()}", object_types=list(types),
            actions=list(actions))
        perm.users.add(self.u)
        perm.tenants.add(self.t)
        for s in sites:
            perm.sites.add(getattr(self, s))
        return perm

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.t.id)
        s.save()

    def post(self, prefix, new, dry_run=True):
        return self.client.post(f"/api/prefixes/{prefix.id}/renumber/",
                                {"new_prefix": new, "dry_run": dry_run}, format="json")

    def preview(self, prefix):
        new = "10.62.0.0/24" if prefix == self.p1 else "10.63.0.0/24"
        r = self.post(prefix, new)
        self.assertEqual(r.status_code, 200, r.content)
        return r

    def arp(self, dev, ip, mac):
        now = timezone.now()
        return ArpSighting.objects.create(tenant=self.t, device=dev, ip=ip, mac=mac,
                                          first_seen=now, last_seen=now)


class _IssueSteps:
    def test_issue_steps(self):
        """The issue's reproduction: prefix-only grant on site A."""
        self.arp(self.dev_b, "10.52.0.33", "aa:bb:cc:00:00:77")
        RedfishEndpoint.objects.create(tenant=self.t, device=self.dev_b, host="10.53.0.44")
        self.assertIn(self.client.get(f"/api/devices/{self.dev_b.id}/").status_code,
                      (403, 404))

        r = self.preview(self.p1)
        body = r.json()
        self.assertEqual(body["unchanged"], [])
        self.assertEqual(body["unchanged_counts"], [])
        self.assertEqual(body["hidden_total"], 1)
        for leak in (b"10.52.0.33", b"aa:bb:cc:00:00:77", b"arpsighting", b"ARP"):
            self.assertNotIn(leak, r.content)

        r = self.preview(self.p2)
        body = r.json()
        self.assertEqual(body["unchanged"], [])
        self.assertEqual(body["hidden_total"], 1)
        for leak in (b"10.53.0.44", str(self.dev_b.id).encode(), b"redfish", b"Redfish"):
            self.assertNotIn(leak, r.content)

        # The superuser still gets the whole list.
        self.login(self.root)
        kinds = {u["kind"] for u in self.preview(self.p1).json()["unchanged"]}
        self.assertEqual(kinds, {"arpsighting"})

    def test_redfish_change_in_the_global_table_names_no_kind(self):
        """A row the renumber writes and the caller can't view refuses it,
        without naming the kind or counting it per kind."""
        RedfishEndpoint.objects.create(tenant=self.t, device=self.dev_b, host="10.52.0.44")
        for dry_run in (True, False):
            r = self.post(self.p1, "10.62.0.0/24", dry_run=dry_run)
            self.assertEqual(r.status_code, 403)
            detail = r.json()["detail"]
            self.assertIn("1 object you can't view", detail)
            self.assertNotIn("bmc", detail.lower())
            self.assertNotIn("redfish", detail.lower())


class _Sources:
    """Every reference the renumber lists, one by one: no grant shows none
    of it; a view grant on site A shows site A's row and still not site B's."""

    def _cases(self):
        t = self.t
        ip_rw = (["ipaddress"], ["view", "change"])

        def oxi():
            conn = OxidizedConnection.objects.create(tenant=t, name="ox", url="http://ox")
            mk = lambda dev, ip: OxidizedNodeLink.objects.create(  # noqa: E731
                tenant=t, connection=conn, device=dev, full_name=dev.name,
                node_name=dev.name, matched_by="name", node_ip=ip)
            return [(mk(self.dev_b, "10.52.0.40"), "10.52.0.40", False),
                    (mk(self.dev_a, "10.52.0.41"), "10.52.0.41", True)], [conn]

        def prtg():
            conn = PrtgConnection.objects.create(tenant=t, name="pr", url="http://pr")
            mk = lambda dev, ip, n: PrtgDeviceLink.objects.create(  # noqa: E731
                tenant=t, connection=conn, device=dev, objid=n, host=ip)
            return [(mk(self.dev_b, "10.52.0.42", "1"), "10.52.0.42", False),
                    (mk(self.dev_a, "10.52.0.43", "2"), "10.52.0.43", True)], [conn]

        def unlinked_dns():
            zone = DnsZone.objects.create(tenant=t, name="corp.example")
            rec = DnsRecord.objects.create(zone=zone, name="old", record_type="A",
                                           data="10.52.0.45", ip="10.52.0.45")
            return [(rec, "10.52.0.45", True)], [zone]

        def leases():
            ip = IPAddress.objects.create(tenant=t, prefix=self.p1, ip_address="10.52.0.10")
            out = []
            for site, cidr in ((self.b, "10.99.0.0/24"), (self.a, "10.98.0.0/24")):
                p = Prefix.objects.create(tenant=t, cidr=cidr, site=site)
                scope = DhcpScope.objects.create(tenant=t, scope_id=cidr[:-3], prefix=p)
                lease = DhcpLease.objects.create(scope=scope, ip="10.52.0.10", ip_address=ip)
                out.append((lease, None, site == self.a))
            return out, [ip]

        def drift():
            ip = IPAddress.objects.create(tenant=t, prefix=self.p1, ip_address="10.52.0.11")
            zone = DnsZone.objects.create(tenant=t, name="drift.example")
            d = DnsDrift.objects.create(zone=zone, kind="mismatch", ip="10.52.0.11",
                                        ip_address=ip)
            return [(d, None, True)], [d, ip, zone]

        def roa():
            asn = ASN.objects.create(tenant=t, asn=64500)
            r = ROA.objects.create(tenant=t, prefix="10.52.0.0/24", max_length=24,
                                   origin_asn=asn)
            return [(r, None, True)], [r, asn]

        def aggregate():
            rir = RIR.objects.create(tenant=t, name="RIPE", slug="ripe")
            agg = Aggregate.objects.create(tenant=t, prefix="10.52.0.0/16", rir=rir)
            return [(agg, "10.52.0.0/16", True)], [agg, rir]

        def engine():
            eng = MonitoringEngine.objects.create(tenant=t, name="op1", slug="op1",
                                                  agent_ip="10.52.0.44")
            return [(eng, "10.52.0.44", True)], []

        def arp():
            return [(self.arp(self.dev_b, "10.52.0.33", "aa:bb:cc:00:00:77"),
                     "10.52.0.33", False),
                    (self.arp(self.dev_a, "10.52.0.34", "aa:bb:cc:00:00:78"),
                     "10.52.0.34", True)], []

        def redfish():
            return [(RedfishEndpoint.objects.create(tenant=t, device=self.dev_b,
                                                    host="10.53.0.44"), "10.53.0.44", False),
                    (RedfishEndpoint.objects.create(tenant=t, device=self.dev_a,
                                                    host="10.53.0.45"), "10.53.0.45", True)], []

        def watched():
            return [(WatchedEndpoint.objects.create(tenant=t, host="10.53.0.46"),
                     "10.53.0.46", True)], []

        def snmp():
            prof = SnmpProfile.objects.create(tenant=t, name="ro", slug="ro")
            mk = lambda dev, ip: SnmpProfileBinding.objects.create(  # noqa: E731
                tenant=t, profile=prof, scope="device", object_id=dev.id, target=ip)
            return [(mk(self.dev_b, "10.53.0.47"), "10.53.0.47", False),
                    (mk(self.dev_a, "10.53.0.48"), "10.53.0.48", True)], [prof]

        def policy():
            mk = lambda dev, net, prio: PolicyRule.objects.create(  # noqa: E731
                tenant=t, device=dev, priority=prio, from_prefix=net, table=100)
            return [(mk(self.dev_b, "10.53.0.0/26", 10), "10.53.0.0/26", False),
                    (mk(self.dev_a, "10.53.0.64/26", 20), "10.53.0.64/26", True)], []

        # kind, prefix, rows, grants (types, actions), visible without a grant
        return [
            ("arpsighting", self.p1, arp, [(["macaddress", "device"], ["view"])], False),
            ("oxidizednodelink", self.p1, oxi, [(["oxidizednodelink"], ["view"])], False),
            ("prtgdevicelink", self.p1, prtg, [(["prtgdevicelink"], ["view"])], False),
            ("monitoringengine", self.p1, engine, [], True),
            ("dnsrecord", self.p1, unlinked_dns, [(["dnsrecord"], ["view"])], False),
            ("dhcplease", self.p1, leases, [ip_rw, (["dhcplease"], ["view"])], False),
            ("dnsdrift", self.p1, drift, [ip_rw, (["dnsdrift"], ["view"])], False),
            ("roa", self.p1, roa, [(["roa"], ["view"])], False),
            ("aggregate", self.p1, aggregate, [(["aggregate"], ["view"])], False),
            ("redfishendpoint", self.p2, redfish, [(["device"], ["view"])], False),
            ("watchedendpoint", self.p2, watched, [(["watchedendpoint"], ["view"])], False),
            ("snmpprofilebinding", self.p2, snmp, [(["device"], ["view"])], False),
            ("policyrule", self.p2, policy, [(["policyrule"], ["view"])], False),
        ]

    def test_every_source_follows_its_own_view_rule(self):
        for kind, prefix, make, grants, open_to_all in self._cases():
            with self.subTest(kind=kind):
                rows, extra = make()
                # The IP grant a lease or drift case needs to move its address.
                setup = [self.grant(*g) for g in grants if g[0] == ["ipaddress"]]
                r = self.preview(prefix)
                body = r.json()
                ids = {u["id"] for u in body["unchanged"]}
                for obj, addr, _ in rows:
                    if open_to_all:
                        self.assertIn(str(obj.pk), ids)
                        continue
                    self.assertNotIn(str(obj.pk).encode(), r.content)
                    if addr:
                        self.assertNotIn(addr.encode(), r.content)
                if not open_to_all:
                    self.assertNotIn(kind, {c["kind"] for c in body["unchanged_counts"]})
                    self.assertGreaterEqual(body["hidden_total"], len(rows))

                perms = setup + [self.grant(*g) for g in grants if g[0] != ["ipaddress"]]
                r = self.preview(prefix)
                body = r.json()
                ids = {u["id"] for u in body["unchanged"]}
                for obj, addr, shown in rows:
                    if shown:
                        self.assertIn(str(obj.pk), ids)
                    else:
                        self.assertNotIn(str(obj.pk).encode(), r.content)
                        if addr:
                            self.assertNotIn(addr.encode(), r.content)
                hidden = sum(1 for *_, shown in rows if not shown)
                self.assertEqual(body["hidden_total"], hidden, json.dumps(body))

                for p in perms:
                    p.delete()
                for obj, *_ in rows:
                    type(obj).objects.filter(pk=obj.pk).delete()
                for obj in extra:
                    type(obj).objects.filter(pk=obj.pk).delete()


class _Apply:
    def test_apply_leaves_hidden_rows_and_says_how_many(self):
        sighting = self.arp(self.dev_b, "10.52.0.33", "aa:bb:cc:00:00:77")
        r = self.post(self.p1, "10.62.0.0/24", dry_run=False)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["applied"])
        self.assertEqual(body["hidden_total"], 1)
        self.assertNotIn(b"10.52.0.33", r.content)
        self.p1.refresh_from_db()
        self.assertEqual(self.p1.cidr, "10.62.0.0/24")
        sighting.refresh_from_db()
        self.assertEqual(sighting.ip, "10.52.0.33")

    def test_apply_refuses_a_write_the_caller_cannot_view(self):
        """Change rights on every BMC endpoint, view only on site A's devices:
        site B's endpoint must move with the tree, so nothing moves."""
        ep = RedfishEndpoint.objects.create(tenant=self.t, device=self.dev_b,
                                            host="10.52.0.50")
        self.grant(["redfishendpoint"], ["view", "change"], sites=())
        self.grant(["device"], ["view"])
        r = self.post(self.p1, "10.62.0.0/24", dry_run=False)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertIn("1 object you can't view", r.json()["detail"])
        self.assertNotIn(b"10.52.0.50", r.content)
        ep.refresh_from_db()
        self.p1.refresh_from_db()
        self.assertEqual((ep.host, self.p1.cidr), ("10.52.0.50", "10.52.0.0/24"))
        # It is a real reference: the superuser's renumber moves it.
        self.login(self.root)
        self.assertEqual(self.post(self.p1, "10.62.0.0/24", dry_run=False).status_code, 200)
        ep.refresh_from_db()
        self.assertEqual(ep.host, "10.62.0.50")

    def test_change_without_view_is_refused(self):
        deny = MonitoringDenySubnet.objects.create(tenant=self.t, cidr="10.52.0.128/25")
        self.grant(["monitoringdenysubnet"], ["change"], sites=())
        r = self.post(self.p1, "10.62.0.0/24", dry_run=False)
        self.assertEqual(r.status_code, 403, r.content)
        detail = r.json()["detail"]
        self.assertIn("1 object you can't view", detail)
        self.assertNotIn("deny", detail.lower())
        deny.refresh_from_db()
        self.assertEqual(deny.cidr, "10.52.0.128/25")
        # With view as well it is named, counted and moved.
        self.grant(["monitoringdenysubnet"], ["view"], sites=())
        r = self.post(self.p1, "10.62.0.0/24")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["hidden_total"], 0)
        self.assertIn("monitoringdenysubnet", {c["kind"] for c in r.json()["counts"]})

    def test_conflicts_and_overlaps_do_not_name_unviewable_prefixes(self):
        other = Prefix.objects.create(tenant=self.t, cidr="10.62.0.0/25", site=self.b)
        r = self.post(self.p1, "10.62.0.0/24")
        self.assertEqual(r.status_code, 400)
        self.assertNotIn(b"10.62.0.0/25", r.content)
        self.assertIn("can't view", r.json()["new_prefix"][0])
        other.delete()
        Prefix.objects.create(tenant=self.t, cidr="10.62.0.0/16", site=self.b)
        r = self.post(self.p1, "10.62.0.0/24")
        self.assertEqual(r.status_code, 403)
        self.assertNotIn(b"10.62.0.0/16", r.content)
        self.assertIn("overlaps 1 prefix you can't view", r.json()["detail"])

    def test_linked_counts_only_what_the_caller_may_view(self):
        """A site B device using a moved address as its primary IP is a
        linked row the caller can't see: counted as hidden, not as devices."""
        self.grant(["ipaddress"], ["view", "change"])
        ip = IPAddress.objects.create(tenant=self.t, prefix=self.p1,
                                      ip_address="10.52.0.20")
        Device.objects.filter(pk=self.dev_b.pk).update(primary_ip=ip)
        body = self.preview(self.p1).json()
        self.assertNotIn("device", {x["kind"] for x in body["linked"]})
        self.assertEqual(body["hidden_total"], 1)
        self.login(self.root)
        body = self.preview(self.p1).json()
        self.assertIn("device", {x["kind"] for x in body["linked"]})
        self.assertEqual(body["hidden_total"], 0)


class DeleteImpactTests(_Base):
    def test_landing_prefix_is_named_only_when_viewable(self):
        """The same pattern on the delete preview: the container that takes
        the addresses belongs to site B."""
        Prefix.objects.create(tenant=self.t, cidr="10.52.0.0/16", site=self.b)
        self.grant(["ipaddress"], ["view"])
        IPAddress.objects.create(tenant=self.t, prefix=self.p1, ip_address="10.52.0.9")
        url = f"/api/prefixes/{self.p1.id}/delete-impact/"
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"moved": 1, "removed": 0, "parent": None})
        self.login(self.root)
        self.assertEqual(self.client.get(url).json()["parent"], "10.52.0.0/16")


class SeparationOffTests(_IssueSteps, _Sources, _Apply, _Base):
    separation = False


class SeparationOnTests(_IssueSteps, _Sources, _Apply, _Base):
    separation = True
