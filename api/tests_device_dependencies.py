"""Device dependencies (#450): the database refusals, cycles with their path
(also through an update and between two concurrent writers), tenant and site
scope on both ends, bulk edit limited to the safe fields, import with a
cycle row and a dry run, the medium catalog's 409, and the starter media."""
from __future__ import annotations

import importlib
import threading
import time

from django.apps import apps as django_apps
from django.contrib.auth.models import User
from django.db import IntegrityError, connection, transaction
from django.test import TestCase, TransactionTestCase
from rest_framework.exceptions import ValidationError
from rest_framework.test import APITestCase

from api.dependencies import load_graph, save_dependency
from api.dependency_media_seeds import BUILTIN_MEDIA, seed_builtin_media
from api.models import DependencyMedium, Device, DeviceDependency, Site
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant

DEPS = "/api/device-dependencies/"
MEDIA = "/api/dependency-media/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        seed_builtin_media(self.tenant)
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.core = Device.objects.create(tenant=self.tenant, name="core-1", site=self.site_a)
        self.dist = Device.objects.create(tenant=self.tenant, name="dist-2", site=self.site_a)
        self.acc = Device.objects.create(tenant=self.tenant, name="acc-7", site=self.site_a)
        self.remote = Device.objects.create(tenant=self.tenant, name="remote-1",
                                            site=self.site_b)
        self.foreign = Device.objects.create(tenant=self.other, name="theirs")
        self.fibre = DependencyMedium.objects.get(tenant=self.tenant, slug="fibre")
        self.admin = User.objects.create_superuser("dep-root", password="x")
        self.login(self.admin)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None

    def post(self, up, down, **data):
        return self.client.post(DEPS, {"upstream_id": str(up.id),
                                       "downstream_id": str(down.id), **data},
                                format="json")

    def dep(self, up, down, **kw):
        return DeviceDependency.objects.create(tenant=self.tenant, upstream=up,
                                               downstream=down, **kw)

    def member(self, *grants, sites=None):
        """A tenant member with ``(types, actions)`` grants, or
        ``(types, actions, sites)`` for one limited to sites; ``sites``
        limits the two-part ones."""
        user = User.objects.create_user(f"m{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for i, grant in enumerate(grants):
            types, actions = grant[0], grant[1]
            limit = grant[2] if len(grant) > 2 else sites
            p = ObjectPermission.objects.create(name=f"{user.username}-{i}",
                                                object_types=types, actions=actions)
            p.users.add(user)
            p.tenants.add(self.tenant)
            if limit:
                p.sites.set(limit)
        return user


class ConstraintTests(_Base):
    def test_database_refuses_self_pair_reverse_and_grouped_peer(self):
        self.dep(self.core, self.dist)
        for up, down, kw in (
            (self.core, self.core, {}),
            (self.core, self.dist, {}),
            (self.dist, self.core, {}),
            (self.dist, self.core, {"kind": "peer"}),
            (self.acc, self.dist, {"kind": "peer", "redundancy_group": "g"}),
        ):
            with self.assertRaises(IntegrityError), transaction.atomic():
                self.dep(up, down, **kw)

    def test_db_defaults_on_a_raw_insert(self):
        with connection.cursor() as cur:
            cur.execute(
                "INSERT INTO api_devicedependency (id, tenant_id, upstream_id, downstream_id,"
                " custom_fields, created_at, updated_at) VALUES"
                " (gen_random_uuid(), %s, %s, %s, '{}', now(), now())",
                [self.tenant.pk, self.core.pk, self.dist.pk],
            )
        row = DeviceDependency.objects.get()
        self.assertEqual((row.kind, row.redundancy_group, row.description, row.comments),
                         ("dependency", "", "", ""))


class ApiWriteTests(_Base):
    def test_create_reads_both_ends_and_the_medium(self):
        body = self.ok(self.post(self.core, self.dist, medium_id=str(self.fibre.id),
                                 redundancy_group=" uplinks "), 201)
        self.assertEqual(body["upstream"]["name"], "core-1")
        self.assertEqual(body["downstream"]["site"]["name"], "A")
        self.assertEqual(body["medium"]["slug"], "fibre")
        self.assertEqual(body["redundancy_group"], "uplinks")
        self.assertEqual(body["kind"], "dependency")
        self.assertIsNotNone(body["numid"])

    def test_self_duplicate_and_reverse_are_field_errors(self):
        self.assertIn("downstream_id", self.ok(self.post(self.core, self.core), 400))
        self.ok(self.post(self.core, self.dist), 201)
        self.assertIn("upstream_id", self.ok(self.post(self.core, self.dist), 400))
        self.assertIn("upstream_id", self.ok(self.post(self.dist, self.core), 400))
        self.assertIn("upstream_id",
                      self.ok(self.post(self.dist, self.core, kind="peer"), 400))

    def test_a_cycle_is_refused_with_its_path(self):
        self.ok(self.post(self.core, self.dist), 201)
        self.ok(self.post(self.dist, self.acc), 201)
        body = self.ok(self.post(self.acc, self.core), 400)
        self.assertEqual(body["upstream_id"],
                         ["This would make a cycle: core-1 → dist-2 → acc-7 → core-1."])
        self.assertEqual(DeviceDependency.objects.count(), 2)

    def test_a_cycle_through_an_update(self):
        self.ok(self.post(self.core, self.dist), 201)
        self.ok(self.post(self.dist, self.acc), 201)
        other = self.ok(self.post(self.remote, self.core), 201)
        r = self.client.patch(f"{DEPS}{other['id']}/", {"upstream_id": str(self.acc.id)},
                              format="json")
        self.assertIn("cycle", self.ok(r, 400)["upstream_id"][0])
        # The row itself is not part of its own cycle check.
        self.ok(self.client.patch(f"{DEPS}{other['id']}/", {"description": "x"},
                                  format="json"))

    def test_a_peer_is_stored_the_same_way_round(self):
        a, b = sorted([self.core, self.dist], key=lambda d: str(d.pk))
        body = self.ok(self.post(b, a, kind="peer"), 201)
        self.assertEqual((body["upstream"]["id"], body["downstream"]["id"]),
                         (str(a.pk), str(b.pk)))
        self.assertIn("redundancy_group",
                      self.ok(self.post(self.acc, self.remote, kind="peer",
                                        redundancy_group="g"), 400))

    def test_peers_never_make_a_cycle(self):
        self.ok(self.post(self.core, self.dist), 201)
        self.ok(self.post(self.dist, self.acc), 201)
        self.ok(self.post(self.acc, self.remote, kind="peer"), 201)
        self.ok(self.post(self.remote, self.core), 201)

    def test_writes_bump_the_cached_graph(self):
        self.assertFalse(load_graph(self.tenant.pk))
        with self.captureOnCommitCallbacks(execute=True):
            self.ok(self.post(self.core, self.dist), 201)
        self.assertEqual(load_graph(self.tenant.pk).upstreams(self.dist.pk), {str(self.core.pk)})
        with self.captureOnCommitCallbacks(execute=True):
            DeviceDependency.objects.get().delete()
        self.assertFalse(load_graph(self.tenant.pk))

    def test_filters(self):
        tag = Tag.objects.create(tenant=self.tenant, name="ring")
        d1 = self.dep(self.core, self.dist, medium=self.fibre, redundancy_group="up")
        d1.tags.add(tag)
        self.dep(self.dist, self.acc)
        self.dep(self.acc, self.remote, kind="peer")

        def ids(q):
            return {r["id"] for r in self.ok(self.client.get(f"{DEPS}?{q}"))["results"]}

        self.assertEqual(len(ids("")), 3)
        self.assertEqual(len(ids(f"device={self.dist.id}")), 2)
        self.assertEqual(ids(f"upstream={self.core.id}"), {str(d1.id)})
        self.assertEqual(len(ids(f"downstream={self.acc.id}")), 1)
        self.assertEqual(len(ids("kind=peer")), 1)
        self.assertEqual(ids(f"medium={self.fibre.id}"), {str(d1.id)})
        self.assertEqual(ids("redundancy_group=up"), {str(d1.id)})
        self.assertEqual(len(ids(f"site={self.site_b.id}")), 1)
        self.assertEqual(ids("tag=ring"), {str(d1.id)})
        self.assertEqual(len(ids("search=dist")), 2)
        self.assertEqual(self.client.get(f"{DEPS}?kind=nope").status_code, 400)

    def test_writes_are_logged_and_reach_the_device_history(self):
        body = self.ok(self.post(self.core, self.dist), 201)
        entry = ChangeLogEntry.objects.get(object_type="api.devicedependency")
        self.assertEqual(str(entry.object_id), body["id"])
        rows = self.ok(self.client.get(
            f"/api/changelog/?object_ids={self.dist.id},{body['id']}"))["results"]
        self.assertIn(body["id"], {str(r["object_id"]) for r in rows})


class TenancyAndScopeTests(_Base):
    def test_another_tenants_device_is_not_found(self):
        body = self.ok(self.post(self.core, self.foreign), 400)
        self.assertIn("downstream_id", body)
        self.assertIn("does not exist", str(body["downstream_id"]))

    def test_downstream_site_editor_may_record_and_upstream_only_may_not(self):
        crud = ["view", "add", "change", "delete"]
        both = self.member((["devicedependency"], crud), (["device"], ["view"]))
        site_a = self.member((["devicedependency"], crud, [self.site_a]),
                             (["device"], ["view"]))
        self.login(site_a)
        # remote (site B) → dist (site A): the dependency is site A's.
        self.ok(self.post(self.remote, self.dist), 201)
        # acc (site A) → remote (site B): site B's, outside the grant.
        self.assertEqual(self.post(self.acc, self.remote).status_code, 403)
        self.assertFalse(DeviceDependency.objects.filter(downstream=self.remote).exists())
        self.login(both)
        self.ok(self.post(self.acc, self.remote), 201)

    def test_the_upstream_must_be_viewable(self):
        user = self.member((["devicedependency"], ["view", "add", "change", "delete"]),
                           (["device"], ["view"]), sites=[self.site_a])
        self.login(user)
        body = self.ok(self.post(self.remote, self.dist), 400)
        self.assertIn("upstream_id", body)

    def test_an_end_the_caller_may_not_view_reads_as_null(self):
        self.dep(self.remote, self.dist)
        user = self.member((["devicedependency", "device"], ["view"]), sites=[self.site_a])
        self.login(user)
        row = self.ok(self.client.get(DEPS))["results"][0]
        self.assertIsNone(row["upstream"])
        self.assertEqual(row["downstream"]["name"], "dist-2")
        self.assertEqual(self.ok(self.client.get(f"{DEPS}?search=remote"))["count"], 0)


class BulkTests(_Base):
    def test_bulk_edit_sets_the_safe_fields_and_refuses_the_ends(self):
        d1 = self.dep(self.core, self.dist)
        d2 = self.dep(self.dist, self.acc)
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(f"{DEPS}bulk-update/", {
                "ids": [str(d1.id), str(d2.id)],
                "fields": {"medium_id": str(self.fibre.id), "redundancy_group": "ring",
                           "description": "x"},
            }, format="json")
        self.ok(r)
        d1.refresh_from_db()
        self.assertEqual((d1.medium, d1.redundancy_group), (self.fibre, "ring"))
        self.assertEqual(load_graph(self.tenant.pk).up[str(self.dist.pk)].keys(), {"ring"})
        for key, value in (("upstream_id", str(self.acc.id)), ("kind", "peer"),
                           ("downstream_id", str(self.core.id))):
            r = self.client.post(f"{DEPS}bulk-update/", {
                "ids": [str(d1.id)], "fields": {key: value}}, format="json")
            self.assertEqual(r.status_code, 400, key)

    def test_bulk_group_on_a_peer_is_refused(self):
        p = self.dep(self.acc, self.remote, kind="peer")
        r = self.client.post(f"{DEPS}bulk-update/", {
            "ids": [str(p.id)], "fields": {"redundancy_group": "g"}}, format="json")
        self.assertIn("redundancy_group", self.ok(r, 400))

    def test_bulk_edit_fields_describe_only_the_safe_fields(self):
        body = self.ok(self.client.get(f"{DEPS}bulk-edit-fields/"))
        self.assertEqual([f["key"] for f in body["fields"]],
                         ["medium_id", "redundancy_group", "description"])


class ImportTests(_Base):
    URL = "/api/io/devicedependency/import/"

    def test_import_round_trip(self):
        content = ("upstream,downstream,medium,redundancy_group,description,tags\n"
                   "core-1,dist-2,fibre,up,first,ring\n"
                   "dist-2,acc-7,ethernet,,,\n")
        body = self.ok(self.client.post(self.URL, {"format": "csv", "content": content},
                                        format="json"))
        self.assertEqual((body["created"], body["errors"]), (2, []))
        d = DeviceDependency.objects.get(upstream=self.core)
        self.assertEqual((d.medium, d.redundancy_group), (self.fibre, "up"))
        self.assertEqual(list(d.tags.names()), ["ring"])
        text = self.client.get("/api/io/devicedependency/export/?fmt=csv")
        text = b"".join(text.streaming_content).decode() if text.streaming \
            else text.content.decode()
        self.assertIn("core-1", text)
        body = self.ok(self.client.post(self.URL, {"format": "csv", "content": text},
                                        format="json"))
        self.assertEqual((body["created"], body["errors"]), (0, []))

    def test_a_cycle_row_is_refused_also_in_a_dry_run(self):
        self.dep(self.core, self.dist)
        self.dep(self.dist, self.acc)
        content = "upstream,downstream\nacc-7,core-1\n"
        for dry in (True, False):
            body = self.ok(self.client.post(
                self.URL, {"format": "csv", "content": content, "dry_run": dry},
                format="json"))
            self.assertEqual(body["created"], 0)
            self.assertIn("cycle", str(body["errors"]))
        self.assertEqual(DeviceDependency.objects.count(), 2)


class MediumTests(_Base):
    def test_a_medium_in_use_is_kept_with_a_409(self):
        self.dep(self.core, self.dist, medium=self.fibre)
        r = self.client.delete(f"{MEDIA}{self.fibre.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertIn("1 dependency", r.json()["detail"])
        DeviceDependency.objects.all().delete()
        self.assertEqual(self.client.delete(f"{MEDIA}{self.fibre.id}/").status_code, 204)

    def test_catalog_crud_and_picker(self):
        body = self.ok(self.client.post(MEDIA, {"name": "Microwave", "line_style": "dashed",
                                                "color": "#123456"}, format="json"), 201)
        self.assertEqual(body["slug"], "microwave")
        rows = self.ok(self.client.get(f"{MEDIA}?picker=1"))["results"]
        self.assertIn("line_style", rows[0])
        self.assertEqual(len(rows), len(BUILTIN_MEDIA) + 1)
        r = self.client.post(MEDIA, {"name": "x", "line_style": "wavy"}, format="json")
        self.assertEqual(r.status_code, 400)


class SeedTests(TestCase):
    def test_seed_is_idempotent_and_leaves_a_tenant_with_media_alone(self):
        org = Organization.objects.create(name="O", slug="o")
        t = Tenant.objects.create(org=org, name="T", slug="t")
        self.assertEqual(seed_builtin_media(t), 6)
        self.assertEqual(seed_builtin_media(t), 0)
        DependencyMedium.objects.filter(tenant=t, slug="satellite").delete()
        self.assertEqual(seed_builtin_media(t), 0)
        self.assertEqual(DependencyMedium.objects.filter(tenant=t).count(), 5)

    def test_migration_seeds_existing_tenants_once(self):
        mig = importlib.import_module("api.migrations.0274_seed_dependency_media")
        org = Organization.objects.create(name="O", slug="o")
        fresh = Tenant.objects.create(org=org, name="F", slug="f")
        kept = Tenant.objects.create(org=org, name="K", slug="k")
        DependencyMedium.objects.create(tenant=kept, name="Own", slug="own")
        mig.forwards(django_apps, None)
        mig.forwards(django_apps, None)
        self.assertEqual(DependencyMedium.objects.filter(tenant=fresh).count(), 6)
        self.assertEqual(list(DependencyMedium.objects.filter(tenant=kept)
                              .values_list("slug", flat=True)), ["own"])
        self.assertEqual([m[0] for m in mig.MEDIA], [m[0] for m in BUILTIN_MEDIA])

    def test_a_tenant_created_through_the_api_gets_the_media(self):
        Organization.objects.create(name="O", slug="o")
        admin = User.objects.create_superuser("seed-root", password="x")
        self.client.force_login(admin)
        r = self.client.post("/api/tenants/", {"name": "New", "slug": "new"},
                             content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        t = Tenant.objects.get(slug="new")
        self.assertEqual(DependencyMedium.objects.filter(tenant=t).count(), 6)


class ConcurrentCreateTests(TransactionTestCase):
    """Two writers that each close half a cycle: the advisory lock makes the
    second wait for the first and see its edge."""

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()

    def test_the_second_writer_is_refused(self):
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        a, b, c = (Device.objects.create(tenant=tenant, name=n) for n in "abc")
        DeviceDependency.objects.create(tenant=tenant, upstream=a, downstream=b)
        saved = threading.Event()
        errors: dict = {}

        def first():
            try:
                with transaction.atomic():
                    save_dependency(DeviceDependency(tenant=tenant, upstream=b, downstream=c))
                    saved.set()
                    time.sleep(0.5)
            finally:
                connection.close()

        def second():
            try:
                saved.wait(5)
                save_dependency(DeviceDependency(tenant=tenant, upstream=c, downstream=a))
            except ValidationError as exc:
                errors["second"] = exc.detail
            finally:
                connection.close()

        threads = [threading.Thread(target=first), threading.Thread(target=second)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertIn("cycle", str(errors.get("second")))
        self.assertEqual(DeviceDependency.objects.filter(tenant=tenant).count(), 2)
