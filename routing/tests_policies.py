"""Routing policy objects: prefix lists, communities and community lists,
AS-path lists, routing policies, keychains. A list writes its rules as a
whole (upsert by sequence, drop the rest), the rule rows validate the way
the box would (a /8 with ge 4 is nonsense), names are unique per tenant,
and none of it leaks across tenants.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import DeploymentSettings, Organization, Tenant

from .models import Community, PrefixList, RoutingKeychain, RoutingPolicy

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, url, body):
        return self.client.post(url, body, format="json")


class PrefixListTests(_Base):
    def test_rules_write_as_a_whole(self):
        r = self._post("/api/routing/prefix-lists/", {
            "name": "CUSTOMERS", "family": "ipv4",
            "rules": [
                {"sequence": 10, "action": "permit", "prefix": "10.0.0.0/8", "ge": 24, "le": 32},
                {"sequence": 20, "action": "deny", "prefix": "0.0.0.0/0", "le": 32},
            ],
        })
        self.assertEqual(r.status_code, 201, r.content)
        pid = r.json()["id"]
        self.assertEqual(r.json()["rule_count"], 2)
        # Replace: 10 edited, 20 gone, 30 new.
        r = self.client.patch(f"/api/routing/prefix-lists/{pid}/", {
            "rules": [
                {"sequence": 10, "action": "permit", "prefix": "10.0.0.0/8", "ge": 16},
                {"sequence": 30, "action": "permit", "prefix": "192.168.0.0/16"},
            ],
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        rules = r.json()["rules"]
        self.assertEqual([x["sequence"] for x in rules], [10, 30])
        self.assertEqual(rules[0]["ge"], 16)
        self.assertIsNone(rules[0]["le"])
        # A PATCH without rules leaves them alone.
        r = self.client.patch(f"/api/routing/prefix-lists/{pid}/", {"description": "x"}, format="json")
        self.assertEqual(len(r.json()["rules"]), 2)
        # The list page does not carry rules, only the count.
        row = self.client.get("/api/routing/prefix-lists/").json()["results"][0]
        self.assertEqual(row["rules"], [])
        self.assertEqual(row["rule_count"], 2)

    def test_rule_arithmetic_and_family(self):
        r = self._post("/api/routing/prefix-lists/", {
            "name": "BAD", "rules": [{"sequence": 10, "prefix": "10.0.0.0/8", "ge": 4}],
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("ge", str(r.json()["rules"]))
        r = self._post("/api/routing/prefix-lists/", {
            "name": "BAD", "rules": [{"sequence": 10, "prefix": "10.0.0.1/8"}],
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("host bits", str(r.json()["rules"]).lower())
        r = self._post("/api/routing/prefix-lists/", {
            "name": "BAD", "family": "ipv4",
            "rules": [{"sequence": 10, "prefix": "2001:db8::/32"}],
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("ipv6", str(r.json()["rules"]))
        r = self._post("/api/routing/prefix-lists/", {
            "name": "BAD", "rules": [
                {"sequence": 10, "prefix": "10.0.0.0/8"},
                {"sequence": 10, "prefix": "10.0.0.0/8"},
            ],
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("Duplicate", str(r.json()["rules"]))
        self.assertFalse(PrefixList.objects.filter(name="BAD").exists())

    def test_names_are_unique_per_tenant_and_tenants_do_not_leak(self):
        PrefixList.objects.create(tenant=self.other, name="CUSTOMERS")
        r = self._post("/api/routing/prefix-lists/", {"name": "CUSTOMERS"})
        self.assertEqual(r.status_code, 201, r.content)
        r = self._post("/api/routing/prefix-lists/", {"name": "CUSTOMERS"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(self.client.get("/api/routing/prefix-lists/").json()["count"], 1)
        # The other tenant's list is not a valid match target either.
        foreign = PrefixList.objects.get(tenant=self.other)
        r = self._post("/api/routing/policies/", {
            "name": "P", "rules": [{"sequence": 10, "match_prefix_list_ids": [str(foreign.id)]}],
        })
        self.assertEqual(r.status_code, 400)

    def test_standalone_rule_endpoint(self):
        pl = PrefixList.objects.create(tenant=self.tenant, name="X")
        r = self._post("/api/routing/prefix-list-rules/", {
            "prefix_list_id": str(pl.id), "sequence": 5, "prefix": "10.0.0.0/24",
        })
        self.assertEqual(r.status_code, 201, r.content)
        rows = self.client.get(f"/api/routing/prefix-list-rules/?prefix_list={pl.id}").json()
        self.assertEqual(rows["count"], 1)
        foreign = PrefixList.objects.create(tenant=self.other, name="X")
        r = self._post("/api/routing/prefix-list-rules/", {
            "prefix_list_id": str(foreign.id), "sequence": 5, "prefix": "10.0.0.0/24",
        })
        self.assertEqual(r.status_code, 400)

    def test_picker_rows(self):
        PrefixList.objects.create(tenant=self.tenant, name="A", family="ipv6")
        row = self.client.get("/api/routing/prefix-lists/?picker=1").json()["results"][0]
        self.assertEqual(set(row), {"id", "numid", "name", "family"})


class PolicyTests(_Base):
    def test_policy_rules_match_and_set(self):
        pl = PrefixList.objects.create(tenant=self.tenant, name="CUST")
        c1 = Community.objects.create(tenant=self.tenant, name="CUSTOMER", value="65000:100")
        r = self._post("/api/routing/policies/", {
            "name": "IMPORT-CUSTOMERS",
            "rules": [
                {"sequence": 10, "action": "permit",
                 "match_prefix_list_ids": [str(pl.id)],
                 "set_local_pref": 200, "set_community_ids": [str(c1.id)],
                 "set_communities_additive": True, "set_next_hop": "10.0.0.1",
                 "set_as_path_prepend": "65001 65001"},
                {"sequence": 20, "action": "deny"},
            ],
        })
        self.assertEqual(r.status_code, 201, r.content)
        rule = r.json()["rules"][0]
        self.assertEqual(rule["match_prefix_lists"][0]["name"], "CUST")
        self.assertEqual(rule["set_communities"][0]["value"], "65000:100")
        self.assertEqual(rule["set_local_pref"], 200)
        # The render shape walks the same data.
        from .render import policy_dict

        d = policy_dict(RoutingPolicy.objects.get(name="IMPORT-CUSTOMERS"))
        self.assertEqual(d["rules"][0]["match"]["prefix_lists"], ["CUST"])
        self.assertEqual(d["rules"][0]["set"]["communities"], ["65000:100"])
        self.assertEqual(d["rules"][0]["set"]["as_path_prepend"], "65001 65001")
        self.assertEqual(d["rules"][1]["action"], "deny")

    def test_bad_next_hop_is_refused(self):
        r = self._post("/api/routing/policies/", {
            "name": "P", "rules": [{"sequence": 10, "set_next_hop": "nope"}],
        })
        self.assertEqual(r.status_code, 400)

    def test_community_value_is_unique_and_searchable(self):
        r = self._post("/api/routing/communities/", {"name": "CUSTOMER", "value": "65000:100"})
        self.assertEqual(r.status_code, 201, r.content)
        r = self._post("/api/routing/communities/", {"name": "AGAIN", "value": "65000:100"})
        self.assertEqual(r.status_code, 409)
        hits = self.client.get("/api/search/?q=65000:100").json()["hits"]
        self.assertIn("community", [h["type"] for h in hits])

    def test_community_list_rules_carry_named_communities(self):
        c1 = Community.objects.create(tenant=self.tenant, name="A", value="65000:1")
        r = self._post("/api/routing/community-lists/", {
            "name": "CL", "kind": "standard",
            "rules": [{"sequence": 10, "community_ids": [str(c1.id)]}],
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["rules"][0]["communities"][0]["value"], "65000:1")
        r = self._post("/api/routing/as-path-lists/", {
            "name": "AS", "rules": [{"sequence": 10, "regex": "^65010_"}],
        })
        self.assertEqual(r.status_code, 201, r.content)

    def test_registries(self):
        from audit.apps import AUDITED_MODELS
        from auth_api.object_types import is_registered

        for label in ("routing.RoutingPolicy", "routing.RoutingPolicyRule",
                      "routing.PrefixList", "routing.StaticRoute", "routing.RoutingKeychain"):
            self.assertIn(label, AUDITED_MODELS)
        for slug in ("routingpolicy", "prefixlist", "community", "staticroute",
                     "routingkeychain"):
            self.assertTrue(is_registered(slug), slug)


class KeychainTests(_Base):
    def _store(self, provider):
        ds = DeploymentSettings.load()
        ds.secrets_provider = provider
        ds.save(update_fields=["secrets_provider"])

    def test_key_lives_in_the_store_and_reveals_under_audit(self):
        from audit.models import ChangeAction, ChangeLogEntry

        self._store("local")
        r = self._post("/api/routing/keychains/", {
            "name": "ISIS-KEY", "algorithm": "md5", "psk": "s3cret",
        })
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(body["psk_set"])
        self.assertNotIn("psk", body)
        k = RoutingKeychain.objects.get(pk=body["id"])
        self.assertNotIn("s3cret", str(k.__dict__))
        r = self.client.post(f"/api/routing/keychains/{k.id}/reveal-psk/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["psk"], "s3cret")
        self.assertTrue(ChangeLogEntry.objects.filter(
            action=ChangeAction.REVEAL, object_id=str(k.id)
        ).exists())
        # The render shape says only that a key exists.
        from .render import keychain_dict

        self.assertEqual(keychain_dict(k)["key_set"], True)
        self.assertNotIn("s3cret", str(keychain_dict(k)))

    def test_without_a_store_the_key_is_refused_not_stored(self):
        self._store("")
        r = self._post("/api/routing/keychains/", {"name": "K", "psk": "s3cret"})
        self.assertEqual(r.status_code, 400)
        r = self._post("/api/routing/keychains/", {"name": "K"})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertFalse(r.json()["psk_set"])
