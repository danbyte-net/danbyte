"""RPKI: caches a BGP instance validates against, ``match rpki`` on a route
map rule, and locally kept ROAs exported as an RFC 8416 SLURM file. The
SSH key of a cache never leaves the secret store on a read; the SLURM file
is the tenant's, behind ``roa.view``.
"""
from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import RIR, Aggregate, Device, DeviceType, Manufacturer, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tag, Tenant

from .models import ROA, BGPInstance, RPKICache
from .render import routing_context

User = get_user_model()

SLURM_10_16 = {
    "slurmVersion": 1,
    "validationOutputFilters": {"prefixFilters": [], "bgpsecFilters": []},
    "locallyAddedAssertions": {
        "prefixAssertions": [
            {"prefix": "10.16.0.0/12", "maxPrefixLength": 24, "asn": 65050,
             "comment": "NSP1 space"},
        ],
        "bgpsecAssertions": [],
    },
}


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.asn = self.tenant.asns.create(asn=65050)
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, url, body):
        return self.client.post(url, body, format="json")

    def _store(self, provider):
        ds = DeploymentSettings.load()
        ds.secrets_provider = provider
        ds.save(update_fields=["secrets_provider"])


class SlurmTests(_Base):
    def _roa(self, **kw):
        body = {"prefix": "10.16.0.0/12", "max_length": 24,
                "origin_asn_id": str(self.asn.id), "description": "NSP1 space", **kw}
        return self._post("/api/routing/roas/", body)

    def test_the_acceptance_roa_gives_the_exact_slurm(self):
        r = self._roa()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["origin_asn"]["asn"], 65050)
        r = self.client.get("/api/routing/roas/slurm/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("attachment", r["Content-Disposition"])
        self.assertIn(".json", r["Content-Disposition"])
        self.assertEqual(json.loads(r.content), SLURM_10_16)

    def test_filters_by_aggregate_and_tag(self):
        rir = RIR.objects.create(tenant=self.tenant, name="Private", slug="private")
        agg = Aggregate.objects.create(tenant=self.tenant, prefix="10.0.0.0/8", rir=rir)
        self.assertEqual(self._roa(aggregate_id=str(agg.id)).status_code, 201)
        tag = Tag.objects.create(tenant=self.tenant, name="nsp2", slug="nsp2")
        r = self._roa(prefix="2001:db8::/32", max_length=48, description="")
        self.assertEqual(r.status_code, 201, r.content)
        v6 = ROA.objects.get(pk=r.json()["id"])
        v6.tags.add(tag)
        doc = self.client.get(f"/api/routing/roas/slurm/?aggregate={agg.id}").json()
        self.assertEqual(doc, SLURM_10_16)
        doc = self.client.get("/api/routing/roas/slurm/?tag=nsp2").json()
        self.assertEqual(
            doc["locallyAddedAssertions"]["prefixAssertions"],
            [{"prefix": "2001:db8::/32", "maxPrefixLength": 48, "asn": 65050}],
        )
        # All of them, IPv4 first; no comment key when there is no description.
        rows = self.client.get("/api/routing/roas/slurm/").json()[
            "locallyAddedAssertions"]["prefixAssertions"]
        self.assertEqual([x["prefix"] for x in rows], ["10.16.0.0/12", "2001:db8::/32"])
        self.assertEqual(
            self.client.get("/api/routing/roas/slurm/?aggregate=nope").status_code, 400
        )

    def test_max_length_and_aggregate_are_validated(self):
        for prefix, ml in (("10.16.0.0/12", 8), ("10.16.0.0/12", 33),
                           ("2001:db8::/32", 129)):
            with self.subTest(prefix=prefix, ml=ml):
                r = self._roa(prefix=prefix, max_length=ml)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("max_length", r.json())
        r = self._roa(prefix="10.16.0.1/12")
        self.assertEqual(r.status_code, 400)
        rir = RIR.objects.create(tenant=self.tenant, name="Private", slug="private")
        agg = Aggregate.objects.create(tenant=self.tenant, prefix="192.168.0.0/16", rir=rir)
        r = self._roa(aggregate_id=str(agg.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("aggregate_id", r.json())
        # Exactly the boundaries are fine.
        self.assertEqual(self._roa(max_length=12).status_code, 201)
        self.assertEqual(self._roa(max_length=32).status_code, 201)

    def test_slurm_is_the_tenants_and_needs_roa_view(self):
        self.assertEqual(self._roa().status_code, 201)
        their_asn = self.other.asns.create(asn=65099)
        ROA.objects.create(tenant=self.other, prefix="172.16.0.0/12", max_length=24,
                           origin_asn=their_asn)
        doc = self.client.get("/api/routing/roas/slurm/").json()
        self.assertEqual(doc, SLURM_10_16)
        # Another tenant's ASN is refused on write.
        r = self._post("/api/routing/roas/", {
            "prefix": "10.32.0.0/12", "max_length": 24, "origin_asn_id": str(their_asn.id),
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("origin_asn_id", r.json())

        user = User.objects.create_user("viewer")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        self._login(user)
        self.assertEqual(self.client.get("/api/routing/roas/slurm/").status_code, 403)
        perm = ObjectPermission.objects.create(
            name="roa view", object_types=["roa"], actions=["view"],
        )
        perm.users.add(user)
        r = self.client.get("/api/routing/roas/slurm/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(json.loads(r.content), SLURM_10_16)
        # View is not write.
        self.assertEqual(self._roa(prefix="10.48.0.0/12").status_code, 403)


class RPKICacheTests(_Base):
    def test_cache_assigned_to_an_instance_and_a_rule_matching_invalid(self):
        r = self._post("/api/routing/rpki-caches/", {
            "name": "routinator", "address": "10.0.0.65", "port": 3323,
            "transport": "tcp", "preference": 1,
        })
        self.assertEqual(r.status_code, 201, r.content)
        cache = r.json()
        self.assertFalse(cache["ssh_private_key_set"])
        self.assertNotIn("ssh_private_key", cache)

        site = Site.objects.create(tenant=self.tenant, name="S")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        dev = Device.objects.create(tenant=self.tenant, name="edge1", device_type=dt, site=site)
        inst = BGPInstance.objects.create(tenant=self.tenant, device=dev, asn=self.asn)
        r = self.client.patch(f"/api/routing/bgp-instances/{inst.id}/", {
            "rpki_cache_ids": [cache["id"]],
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            [(c["name"], c["address"], c["port"], c["transport"], c["preference"])
             for c in r.json()["rpki_caches"]],
            [("routinator", "10.0.0.65", 3323, "tcp", 1)],
        )
        r = self.client.get(f"/api/routing/rpki-caches/{cache['id']}/")
        self.assertEqual(r.json()["bgp_instance_count"], 1)

        r = self._post("/api/routing/policies/", {
            "name": "NSP1-IN",
            "rules": [{"sequence": 5, "action": "deny", "match_rpki": "invalid"},
                      {"sequence": 10, "action": "permit"}],
        })
        self.assertEqual(r.status_code, 201, r.content)
        pid = r.json()["id"]
        rules = self.client.get(f"/api/routing/policies/{pid}/").json()["rules"]
        self.assertEqual([(x["sequence"], x["match_rpki"]) for x in rules],
                         [(5, "invalid"), (10, "")])
        r = self.client.get(f"/api/routing/policy-rules/?policy={pid}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("invalid", [x["match_rpki"] for x in r.json()["results"]])
        r = self._post("/api/routing/policies/", {
            "name": "BAD", "rules": [{"sequence": 5, "match_rpki": "unknown"}],
        })
        self.assertEqual(r.status_code, 400)

        # The render block: the cache in full at the top, by name on the
        # instance, and the rule's match.
        from .models import BGPAddressFamily

        BGPAddressFamily.objects.create(instance=inst, afi_safi="ipv4-unicast",
                                        import_policy_id=pid)
        dev.refresh_from_db()
        block = routing_context(dev)
        self.assertEqual(block["bgp"][0]["rpki_caches"], ["routinator"])
        self.assertEqual(
            {k: block["rpki_caches"][0][k] for k in ("address", "port", "transport",
                                                     "preference")},
            {"address": "10.0.0.65", "port": 3323, "transport": "tcp", "preference": 1},
        )
        self.assertEqual(block["policies"]["NSP1-IN"]["rules"][0]["match"]["rpki"], "invalid")

    def test_ssh_key_is_write_only_and_tcp_refuses_ssh_fields(self):
        self._store("local")
        r = self._post("/api/routing/rpki-caches/", {
            "name": "ssh-cache", "address": "rpki.example.net", "port": 22,
            "transport": "ssh", "preference": 2, "ssh_username": "rpki",
            "ssh_host_key": "ssh-ed25519 AAAA", "ssh_private_key": "-----BEGIN KEY-----",
        })
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(body["ssh_private_key_set"])
        self.assertNotIn("BEGIN", json.dumps(body))
        cid = body["id"]
        self.assertNotIn("BEGIN", json.dumps(self.client.get(
            f"/api/routing/rpki-caches/{cid}/").json()))
        self.assertNotIn("BEGIN", json.dumps(self.client.get(
            "/api/routing/rpki-caches/").json()))
        row = RPKICache.objects.get(pk=cid)
        self.assertNotIn("BEGIN", str(row.__dict__))
        # SSH without a username is refused.
        r = self._post("/api/routing/rpki-caches/", {
            "name": "x", "address": "10.0.0.66", "transport": "ssh",
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("ssh_username", r.json())
        # TCP with a key or a username is refused.
        r = self._post("/api/routing/rpki-caches/", {
            "name": "y", "address": "10.0.0.67", "ssh_private_key": "k",
        })
        self.assertEqual(r.status_code, 400)
        # Switching to TCP drops the key.
        r = self.client.patch(f"/api/routing/rpki-caches/{cid}/", {
            "transport": "tcp", "ssh_username": "", "ssh_host_key": "",
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["ssh_private_key_set"])

    def test_address_preference_and_tenant(self):
        for body, field in (({"address": "not a host!"}, "address"),
                            ({"address": "10.0.0.1", "preference": 0}, "preference"),
                            ({"address": "10.0.0.1", "preference": 256}, "preference"),
                            ({"address": "10.0.0.1", "port": 70000}, "port")):
            with self.subTest(body=body):
                r = self._post("/api/routing/rpki-caches/", {"name": "c", **body})
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn(field, r.json())
        theirs = RPKICache.objects.create(tenant=self.other, name="t", address="10.9.9.9")
        site = Site.objects.create(tenant=self.tenant, name="S")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        dev = Device.objects.create(tenant=self.tenant, name="edge1", device_type=dt, site=site)
        inst = BGPInstance.objects.create(tenant=self.tenant, device=dev, asn=self.asn)
        r = self.client.patch(f"/api/routing/bgp-instances/{inst.id}/", {
            "rpki_cache_ids": [str(theirs.id)],
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("rpki_cache_ids", r.json())

    def test_registries(self):
        from audit.apps import AUDITED_MODELS
        from auth_api.object_types import CAPABILITY_VERBS, is_registered

        for label in ("routing.RPKICache", "routing.ROA"):
            self.assertIn(label, AUDITED_MODELS)
        for slug in ("rpkicache", "roa"):
            self.assertTrue(is_registered(slug), slug)
        self.assertEqual(CAPABILITY_VERBS["rpkicache"], ["reveal"])
