"""Sensitivity labels: the catalog (CRUD, one default, tenancy, RBAC, site
roles, audit), the starter seeds, and the marking on a PDF report - its
cover badge, every page's header and footer, the option's validation and the
per-report cover colours."""

from __future__ import annotations

import importlib
from unittest import mock

from django.apps import apps as django_apps
from django.contrib.auth.models import User
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from auth_api.object_types import is_registered
from auth_api.site_paths import site_role_catalog_types
from core.models import Organization, Tenant, TenantSettings

from . import report_background as rb
from . import sensitivity as sens
from .models import SensitivityLabel, Site
from .search_index import SPECS
from .tests_object_report import _Report
from .tests_report_cover import _Cover, _cover_of

URL = "/api/sensitivity-labels/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="Campus")
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        self.theirs = SensitivityLabel.objects.create(
            tenant=self.tenant2, name="Secret", slug="secret", color="#000000"
        )
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def user(self, name, types, actions, sites=None):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"{name}-grant", object_types=types, actions=actions
        )
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        perm.users.add(u)
        return u

    def label(self, name="Confidential", **kw):
        return SensitivityLabel.objects.create(
            tenant=self.tenant, name=name, slug=name.lower(), **kw
        )


class CatalogTests(_Base):
    def test_create_slug_colour_icon_and_text_colour(self):
        r = self.client.post(URL, {
            "name": "Top Secret", "color": "#FDE047", "icon": "shield-alert",
            "description": "Eyes only", "weight": 5,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["slug"], "top-secret")
        self.assertEqual(body["color"], "#fde047")
        self.assertEqual(body["text_color"], "#000")
        self.assertEqual(body["icon"], "shield-alert")
        self.assertIsNotNone(body["numid"])
        self.assertFalse(body["is_default"])

    def test_unique_name_per_tenant_and_validation(self):
        self.label("Internal")
        r = self.client.post(URL, {"name": "Internal"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.json())
        # Another tenant's "Secret" is no clash.
        self.assertEqual(self.client.post(URL, {"name": "Secret"}, format="json").status_code, 201)
        for bad in ({"name": "X", "color": "red"}, {"name": "Y", "icon": "<svg>"}):
            self.assertEqual(self.client.post(URL, bad, format="json").status_code, 400)

    def test_update_list_search_and_delete(self):
        lab = self.label("Internal", color="#2563eb")
        r = self.client.patch(f"{URL}{lab.id}/", {"color": "#16a34a"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.client.get(f"{URL}?search=intern").json()["count"], 1)
        self.assertEqual(self.client.get(f"{URL}?search=nope").json()["count"], 0)
        picker = self.client.get(f"{URL}?picker=1").json()["results"][0]
        self.assertEqual(
            set(picker), {"id", "numid", "name", "slug", "color", "text_color", "icon",
                          "is_default"},
        )
        self.assertEqual(self.client.delete(f"{URL}{lab.id}/").status_code, 204)
        self.assertFalse(SensitivityLabel.objects.filter(pk=lab.pk).exists())

    def test_one_default_per_tenant(self):
        a = self.label("Internal", is_default=True)
        b = self.label("Public")
        r = self.client.patch(f"{URL}{b.id}/", {"is_default": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        a.refresh_from_db()
        self.assertFalse(a.is_default)
        r = self.client.post(URL, {"name": "Secret", "is_default": True}, format="json")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(
            list(SensitivityLabel.objects.filter(tenant=self.tenant, is_default=True)
                 .values_list("name", flat=True)),
            ["Secret"],
        )
        # The other tenant's default is untouched.
        self.theirs.is_default = True
        self.theirs.save()
        self.client.patch(f"{URL}{b.id}/", {"is_default": True}, format="json")
        self.theirs.refresh_from_db()
        self.assertTrue(self.theirs.is_default)

    def test_bulk_edit(self):
        a, b = self.label("Internal"), self.label("Public")
        r = self.client.post(f"{URL}bulk-update/", {
            "ids": [str(a.id), str(b.id)], "fields": {"color": "#dc2626"},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            set(SensitivityLabel.objects.filter(pk__in=[a.pk, b.pk])
                .values_list("color", flat=True)),
            {"#dc2626"},
        )
        r = self.client.post(f"{URL}bulk-update/", {
            "ids": [str(self.theirs.id)], "fields": {"color": "#22c55e"},
        }, format="json")
        self.theirs.refresh_from_db()
        self.assertEqual(self.theirs.color, "#000000")
        r = self.client.post(f"{URL}bulk-delete/", {"ids": [str(a.id), str(b.id)]},
                             format="json")
        self.assertIn(r.status_code, (200, 204), r.content)
        self.assertFalse(SensitivityLabel.objects.filter(pk__in=[a.pk, b.pk]).exists())


class TenancyTests(_Base):
    def test_another_tenants_label_is_invisible(self):
        self.label()
        names = [x["name"] for x in self.client.get(URL).json()["results"]]
        self.assertEqual(names, ["Confidential"])
        for call in (self.client.get, self.client.delete):
            self.assertEqual(call(f"{URL}{self.theirs.id}/").status_code, 404)
        r = self.client.patch(f"{URL}{self.theirs.id}/", {"name": "Mine"}, format="json")
        self.assertEqual(r.status_code, 404)


class RbacTests(_Base):
    def test_registered_searchable_and_audited(self):
        self.assertTrue(is_registered("sensitivitylabel"))
        self.assertIn("sensitivitylabel", SPECS)
        lab = self.client.post(URL, {"name": "Internal"}, format="json").json()
        self.client.patch(f"{URL}{lab['id']}/", {"color": "#2563eb"}, format="json")
        actions = list(
            ChangeLogEntry.objects.filter(object_type="api.sensitivitylabel", object_id=lab["id"])
            .order_by("timestamp").values_list("action", flat=True)
        )
        self.assertEqual(actions[:2], ["create", "update"])

    def test_view_only_reads_but_does_not_write(self):
        lab = self.label()
        self.login(self.user("viewer", ["sensitivitylabel"], ["view"]))
        self.assertEqual(self.client.get(URL).json()["count"], 1)
        self.assertEqual(self.client.post(URL, {"name": "X"}, format="json").status_code, 403)
        r = self.client.patch(f"{URL}{lab.id}/", {"name": "Y"}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.delete(f"{URL}{lab.id}/").status_code, 403)

    def test_no_grant_sees_nothing(self):
        self.label()
        self.login(self.user("nobody", ["device"], ["view"]))
        r = self.client.get(URL)
        self.assertTrue(r.status_code == 403 or r.json()["count"] == 0)

    def test_site_roles_read_the_labels(self):
        self.assertIn("sensitivitylabel", site_role_catalog_types())


class SeedTests(_Base):
    def test_starter_set_once(self):
        created = sens.seed_sensitivity_labels(self.tenant)
        self.assertEqual(created, 4)
        rows = list(SensitivityLabel.objects.filter(tenant=self.tenant).order_by("weight"))
        self.assertEqual([r.name for r in rows],
                         ["Public", "Internal", "Confidential", "Restricted"])
        self.assertTrue(all(r.color and r.icon for r in rows))
        self.assertFalse(any(r.is_default for r in rows))
        self.assertTrue(TenantSettings.objects.get(tenant=self.tenant).sensitivity_labels_seeded)
        # A second run creates nothing, and a deleted seed stays deleted.
        rows[0].delete()
        self.assertEqual(sens.seed_sensitivity_labels(self.tenant), 0)
        self.assertFalse(
            SensitivityLabel.objects.filter(tenant=self.tenant, slug="public").exists()
        )

    def test_user_edits_are_kept(self):
        mine = self.label("Internal", color="#000000", description="ours")
        sens.seed_sensitivity_labels(self.tenant)
        mine.refresh_from_db()
        self.assertEqual((mine.color, mine.description), ("#000000", "ours"))
        self.assertEqual(SensitivityLabel.objects.filter(tenant=self.tenant).count(), 4)

    def test_a_new_tenant_is_seeded(self):
        r = self.client.post("/api/tenants/", {"name": "Fresh", "slug": "fresh"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(SensitivityLabel.objects.filter(tenant_id=r.json()["id"]).count(), 4)

    def test_the_data_migration_matches_and_is_idempotent(self):
        mig = importlib.import_module("api.migrations.0264_seed_sensitivity_labels")
        self.assertEqual(mig.STARTER, sens.STARTER_LABELS)
        mig.seed(django_apps, None)
        mig.seed(django_apps, None)
        self.assertEqual(SensitivityLabel.objects.filter(tenant=self.tenant).count(), 4)
        # The other tenant keeps its own label beside the seeds.
        self.assertTrue(SensitivityLabel.objects.filter(pk=self.theirs.pk).exists())


class MarkingTests(SimpleTestCase):
    def test_marking_dict(self):
        lab = SensitivityLabel(name="Confidential", color="#D97706", icon="shield")
        m = sens.marking_for(lab)
        self.assertEqual(set(m), {"name", "color", "text_color", "icon_svg"})
        self.assertEqual(m["color"], "#d97706")
        self.assertEqual(m["text_color"], "#ffffff")
        self.assertTrue(m["icon_svg"].startswith("<svg"))
        self.assertIn('stroke="#ffffff"', m["icon_svg"])
        self.assertIsNone(sens.marking_for(None))

    def test_no_colour_and_unknown_icon(self):
        m = sens.marking_for(SensitivityLabel(name="Plain", icon="no-such-icon"))
        self.assertEqual((m["color"], m["text_color"], m["icon_svg"]),
                         (sens.NEUTRAL, sens.INK, ""))

    def test_the_name_is_escaped(self):
        from .reports.marking import Marking, marking_badge

        m = sens.marking_for(SensitivityLabel(name="<b>x</b>", color="#000000"))
        self.assertIn("&lt;b&gt;", marking_badge(Marking.from_dict(m)))


class ReportMarkingTests(_Report):
    def setUp(self):
        super().setUp()
        self.conf = SensitivityLabel.objects.create(
            tenant=self.tenant, name="Confidential", slug="confidential",
            color="#d97706", icon="shield",
        )

    def report(self, **options):
        return self.html("devices", {"filters": {}, "options": options})

    def test_no_label_no_marking(self):
        r, html = self.report(cover=True)
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("marking-top", html)
        self.assertNotIn("class='marking", html)
        self.assertNotIn("element(marking-top)", html)

    def test_every_page_header_and_footer(self):
        r, html = self.report(sensitivity_label=str(self.conf.id))
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertIn("@top-center{content:element(marking-top)", html)
        self.assertIn("@bottom-center{content:element(marking-bottom)", html)
        body = html[html.index("<body>"):]
        self.assertTrue(body.startswith("<body><div class='marking-top'>"))
        self.assertEqual(body.count("<span class='marking-name'>Confidential</span>"), 2)
        self.assertIn("background:#d97706;color:#ffffff", body)
        # The label's icon, sanitised, as an image.
        self.assertIn("<img class='marking-icon' src='data:image/svg+xml;base64,", body)

    def test_cover_badge_top_right(self):
        _r, html = self.report(cover=True, sensitivity_label=str(self.conf.id))
        cover = _cover_of(html)
        self.assertIn("class='marking cover-marking'", cover)
        self.assertIn("Confidential", cover)
        self.assertRegex(html, r"section\.cover \.cover-marking\{position:absolute;right:")

    def test_another_tenants_label_is_refused(self):
        org2 = Organization.objects.create(name="Evil", slug="evil")
        t2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        theirs = SensitivityLabel.objects.create(tenant=t2, name="Theirs", slug="theirs")
        for value in (str(theirs.id), "not-a-uuid"):
            r, html = self.report(sensitivity_label=value)
            self.assertEqual(r.status_code, 400, value)
            self.assertEqual(html, "")
        r = self.client.post(
            "/api/devices/report/?estimate=1",
            {"filters": {}, "options": {"sensitivity_label": str(theirs.id)}}, format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("sensitivity_label", str(r.json()))

    def test_a_reader_who_may_not_view_labels_is_refused(self):
        devices = (["device", "site", "status", "devicerole", "devicetype"], ["view"])
        self.login(self.member("reader", devices))
        r, _ = self.report(sensitivity_label=str(self.conf.id))
        self.assertEqual(r.status_code, 400)
        self.login(self.member("labeller", devices, (["sensitivitylabel"], ["view"])))
        r, html = self.report(sensitivity_label=str(self.conf.id))
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertIn("Confidential", html)

    def test_a_real_render(self):
        r = self.client.post("/api/devices/report/", {"filters": {}, "options": {
            "cover": True, "sensitivity_label": str(self.conf.id)}}, format="json")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(r.content.startswith(b"%PDF"))


class CoverColourTests(_Cover):
    def report(self, **options):
        return self.html("devices", {"filters": {}, "options": options})

    def test_override_reaches_the_cover(self):
        with mock.patch.object(rb, "waves", wraps=rb.waves) as drawn:
            r, _ = self.report(cover=True, orientation="portrait", cover_colors={
                "horizon": "#14532D", "wave": "#16a34a", "crest": "#ffffff"})
        self.assertEqual(r.status_code, 200, r.content[:300])
        drawn.assert_called_once_with(*rb.size_px(210, 297), "#14532d", "#16a34a", "#ffffff")

    def test_tenant_colours_without_one(self):
        TenantSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"report_cover_horizon": "#7f1d1d"})
        with mock.patch.object(rb, "waves", wraps=rb.waves) as drawn:
            self.report(cover=True, orientation="portrait", cover_colors=None)
        self.assertEqual(drawn.call_args.args[2], "#7f1d1d")

    def test_validation(self):
        bad = (
            {"horizon": "red", "wave": "#16a34a", "crest": "#ffffff"},
            {"horizon": "#14532d", "wave": "#16a34a"},
            {"horizon": "#14532d", "wave": "#16a34a", "crest": "url(x)"},
            "#14532d",
        )
        for colors in bad:
            r, html = self.report(cover=True, cover_colors=colors)
            self.assertEqual(r.status_code, 400, colors)
            self.assertEqual(html, "")


class SiteRoleMigrationTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="Campus")
        self.mig = importlib.import_module(
            "auth_api.migrations.0051_site_roles_sensitivity_labels")
        self.rpki = importlib.import_module("auth_api.migrations.0050_site_roles_rpki_caches")
        self.cat = importlib.import_module("auth_api.migrations.0029_site_roles_catalog_view")
        self.core = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")

    def perm(self, name, actions, types):
        p = ObjectPermission.objects.create(name=name, actions=actions, object_types=types)
        p.sites.set([self.site])
        return p

    def test_viewer_and_catalog_view_gain_the_labels(self):
        view = self.perm("A - site view", ["view"],
                         sorted(set(self.core.CORE) | set(self.cat.ROLE_CATALOGS)))
        edit = self.perm("B - site edit", ["view", "add", "change", "delete"],
                         sorted(self.core.CORE))
        catalog = self.perm("B - catalog view", ["view"],
                            sorted(set(self.cat.ROLE_CATALOGS) | set(self.rpki.NEW_CATALOGS)))
        custom = self.perm("Ops - site view", ["view"], ["device", "prefix"])
        self.mig.forwards(django_apps, None)
        self.mig.forwards(django_apps, None)
        for p in (view, edit, catalog, custom):
            p.refresh_from_db()
        self.assertIn("sensitivitylabel", view.object_types)
        self.assertNotIn("sensitivitylabel", edit.object_types)
        self.assertIn("sensitivitylabel", catalog.object_types)
        self.assertEqual(custom.object_types, ["device", "prefix"])
        self.assertEqual(len(view.object_types), len(set(view.object_types)))
