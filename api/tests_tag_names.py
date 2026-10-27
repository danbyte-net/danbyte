"""Tag names unique among what a tenant sees, the duplicates list, and the
merge action that folds one tag into another."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from rest_framework.test import APITestCase

from api.models import VLAN, Site
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, TaggedItem, Tenant
from core.tags import find_visible_tag


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="ON", slug="on")
        self.t1 = Tenant.objects.create(org=org, name="T1", slug="t1")
        self.t2 = Tenant.objects.create(org=org, name="T2", slug="t2")
        self.site = Site.objects.create(tenant=self.t1, name="S1")
        self.other_site = Site.objects.create(tenant=self.t1, name="S2")
        self.glob = Tag.objects.create(name="prod", slug="prod")  # NULL tenant
        self.mine = Tag.objects.create(name="core", slug="core", tenant=self.t1)
        self.theirs = Tag.objects.create(name="edge", slug="edge", tenant=self.t2)
        self.admin = User.objects.create_superuser("root", password="x")
        self.user = self._user("u1", self.t1, ["view", "add", "change", "delete"])

    def _user(self, name, tenant, actions):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u).tenants.add(tenant)
        p = ObjectPermission.objects.create(
            name=f"tags-{name}", object_types=["tag"], actions=actions
        )
        p.users.add(u)
        return u

    def _login(self, user, tenant):
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{tenant.id}/switch/")


class TagNameRuleTests(_Base):
    def test_create_clashing_with_global_refused(self):
        self._login(self.user, self.t1)
        res = self.client.post("/api/tags/", {"name": " PROD "}, format="json")
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("global", res.json()["name"][0])
        self.assertIn('"prod"', res.json()["name"][0])

    def test_create_clashing_with_own_tag_case_insensitive(self):
        self._login(self.user, self.t1)
        res = self.client.post("/api/tags/", {"name": "Core"}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("tenant T1", res.json()["name"][0])

    def test_other_tenants_names_do_not_clash(self):
        self._login(self.user, self.t1)
        res = self.client.post("/api/tags/", {"name": "Edge"}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["name"], "Edge")

    def test_name_is_trimmed(self):
        self._login(self.user, self.t1)
        res = self.client.post("/api/tags/", {"name": "  lab  "}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["name"], "lab")

    def test_rename_into_clash_refused_but_same_name_kept(self):
        self._login(self.user, self.t1)
        url = f"/api/tags/{self.mine.id}/"
        self.assertEqual(
            self.client.patch(url, {"name": "Prod"}, format="json").status_code, 400
        )
        # Renaming to its own name (case change) is not a clash with itself.
        res = self.client.patch(url, {"name": "CORE"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)

    def test_site_local_tag_clashes_with_tenant_tag(self):
        Tag.objects.create(name="wifi", slug="wifi", tenant=self.t1, owning_site=self.site)
        self._login(self.user, self.t1)
        res = self.client.post("/api/tags/", {"name": "WiFi"}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("local to site S1", res.json()["name"][0])

    def test_global_rename_checks_every_tenant(self):
        self._login(self.admin, self.t1)
        res = self.client.patch(
            f"/api/tags/{self.glob.id}/", {"name": "edge"}, format="json"
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("tenant T2", res.json()["name"][0])

    def test_model_clean(self):
        with self.assertRaises(ValidationError):
            Tag(name="Prod", slug="prod-2", tenant=self.t2).full_clean()
        Tag(name="fresh", slug="fresh", tenant=self.t2).full_clean()

    def test_import_lookup_reuses_visible_tag(self):
        self.assertEqual(find_visible_tag(" PROD", self.t1), self.glob)
        self.assertEqual(find_visible_tag("core", self.t1), self.mine)
        self.assertIsNone(find_visible_tag("edge", self.t1))

    def test_is_global_flag(self):
        self._login(self.user, self.t1)
        rows = {r["name"]: r for r in self.client.get("/api/tags/").json()["results"]}
        self.assertTrue(rows["prod"]["is_global"])
        self.assertFalse(rows["core"]["is_global"])
        picker = self.client.get("/api/tags/?picker=1").json()["results"]
        self.assertTrue(next(r for r in picker if r["name"] == "prod")["is_global"])


class TagDuplicatesTests(_Base):
    def test_lists_visible_pairs_only(self):
        dup = Tag.objects.create(name="Prod", slug="prod", tenant=self.t1)  # legacy pair
        Tag.objects.create(name="Prod", slug="prod", tenant=self.t2)
        self._login(self.user, self.t1)
        body = self.client.get("/api/tags/duplicates/").json()
        self.assertEqual(body["count"], 1)
        self.assertEqual(set(body["results"][0]["ids"]), {self.glob.id, dup.id})


class TagMergeTests(_Base):
    def setUp(self):
        super().setUp()
        self.dup = Tag.objects.create(name="Prod", slug="prod", tenant=self.t1)
        self.v1 = VLAN.objects.create(tenant=self.t1, vlan_id=10, name="a")
        self.v2 = VLAN.objects.create(tenant=self.t1, vlan_id=20, name="b")
        self.v1.tags.add(self.dup)
        self.v2.tags.add(self.dup, self.glob)
        self.site.tags.add(self.dup)

    def _merge(self, source, into):
        return self.client.post(
            f"/api/tags/{source.id}/merge/", {"into": into.id}, format="json"
        )

    def test_merge_moves_items_without_duplicates(self):
        self._login(self.user, self.t1)
        res = self._merge(self.dup, self.glob)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["moved"], 2)
        self.assertEqual(res.json()["already_tagged"], 1)
        self.assertFalse(Tag.objects.filter(pk=self.dup.pk).exists())
        for obj in (self.v1, self.v2, self.site):
            self.assertEqual(
                list(obj.tags.values_list("pk", flat=True)), [self.glob.pk]
            )
        self.assertEqual(TaggedItem.objects.filter(tag=self.glob).count(), 3)
        logged = ChangeLogEntry.objects.filter(
            object_id__in=[str(self.v1.pk), str(self.v2.pk), str(self.site.pk)],
            changes__tags__isnull=False,
        )
        self.assertEqual(logged.count(), 3)
        v2 = logged.get(object_id=str(self.v2.pk))
        self.assertEqual(v2.changes["tags"], {"old": ["Prod"], "new": None})
        self.assertTrue(
            ChangeLogEntry.objects.filter(
                object_type="core.tag", object_id=str(self.dup.pk)
            ).exists()
        )

    def test_into_tenant_tag(self):
        self._login(self.user, self.t1)
        res = self._merge(self.dup, self.mine)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["into"]["id"], self.mine.id)

    def test_refuses_other_tenant_target(self):
        self._login(self.user, self.t1)
        res = self._merge(self.dup, self.theirs)
        self.assertEqual(res.status_code, 400)
        self.assertTrue(Tag.objects.filter(pk=self.dup.pk).exists())

    def test_refuses_into_itself(self):
        self._login(self.user, self.t1)
        self.assertEqual(self._merge(self.dup, self.dup).status_code, 400)

    def test_global_source_needs_superuser_and_global_target(self):
        self._login(self.user, self.t1)
        self.assertEqual(self._merge(self.glob, self.dup).status_code, 403)
        self._login(self.admin, self.t1)
        res = self._merge(self.glob, self.dup)
        self.assertEqual(res.status_code, 400)
        self.assertIn("global", str(res.json()["into"]))

    def test_refuses_target_local_to_another_site(self):
        local = Tag.objects.create(
            name="lan", slug="lan", tenant=self.t1, owning_site=self.other_site
        )
        self._login(self.user, self.t1)
        self.assertEqual(self._merge(self.dup, local).status_code, 400)

    def test_needs_delete(self):
        viewer = self._user("u2", self.t1, ["view", "change"])
        self._login(viewer, self.t1)
        self.assertEqual(self._merge(self.dup, self.glob).status_code, 403)
        self.assertTrue(Tag.objects.filter(pk=self.dup.pk).exists())

    def test_needs_change(self):
        deleter = self._user("u3", self.t1, ["view", "delete"])
        self._login(deleter, self.t1)
        self.assertEqual(self._merge(self.dup, self.glob).status_code, 403)

    def test_other_tenant_cannot_merge_source(self):
        other = self._user("u4", self.t2, ["view", "add", "change", "delete"])
        self._login(other, self.t2)
        self.assertEqual(self._merge(self.dup, self.glob).status_code, 404)
