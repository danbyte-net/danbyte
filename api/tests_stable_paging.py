"""Every page is cut from a total order (#529).

VLAN IDs repeat across sites; ordered by the ID alone, rows sharing one had
no fixed order and each page could return a different slice of them, so a
walk over the pages showed some VLANs twice and others never. The
pagination now appends the primary key to any ORDER BY that can tie.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from django.urls import get_resolver
from django.utils import timezone
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from core.models import Organization, Tenant

from .models import VLAN, Site
from .pagination import StablePagination, stable_order

User = get_user_model()


class _Tenant(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _walk(self, url, size):
        seen, page = [], 1
        while True:
            r = self.client.get(f"{url}{'&' if '?' in url else '?'}page_size={size}&page={page}")
            self.assertEqual(r.status_code, 200, r.content)
            body = r.json()
            seen += [row["id"] for row in body["results"]]
            if not body.get("next"):
                return body["count"], seen
            page += 1


class VlanWalkTests(_Tenant):
    def setUp(self):
        super().setUp()
        # The issue's shape: the same VLAN IDs at every site, plus others.
        for n in range(12):
            site = Site.objects.create(tenant=self.tenant, name=f"site-{n:02d}")
            for vid in range(100, 110):
                VLAN.objects.create(tenant=self.tenant, site=site, vlan_id=vid, name=f"v{vid}")
        for vid in range(200, 215):
            VLAN.objects.create(tenant=self.tenant, vlan_id=vid, name=f"g{vid}")
        # Another tenant's VLANs share the IDs and must never appear.
        VLAN.objects.create(tenant=self.other, vlan_id=100, name="theirs")
        self.ids = {str(pk) for pk in VLAN.objects.filter(tenant=self.tenant).values_list(
            "pk", flat=True)}

    def test_every_vlan_appears_exactly_once(self):
        for url in ("/api/vlans/", "/api/vlans/?picker=1"):
            for size in (7, 25, 1000):
                with self.subTest(url=url, size=size):
                    count, seen = self._walk(url, size)
                    self.assertEqual(count, len(self.ids))
                    self.assertEqual(len(seen), len(set(seen)), "a VLAN repeated")
                    self.assertEqual(set(seen), self.ids)

    def test_the_order_breaks_ties_by_id(self):
        _, seen = self._walk("/api/vlans/", 1000)
        rows = {str(v.pk): v for v in VLAN.objects.filter(tenant=self.tenant)}
        keys = [(rows[pk].vlan_id, rows[pk].pk) for pk in seen]
        self.assertEqual(keys, sorted(keys))


class ChangeLogWalkTests(_Tenant):
    def test_entries_written_at_one_instant_page_once_each(self):
        at = timezone.now()
        ChangeLogEntry.objects.bulk_create([
            ChangeLogEntry(tenant=self.tenant, timestamp=at, action="update",
                           object_type="api.vlan", object_id=str(i), object_repr=f"v{i}")
            for i in range(40)
        ])
        # auto_now_add: pin them to one instant, as a bulk change can.
        ChangeLogEntry.objects.filter(tenant=self.tenant).update(timestamp=at)
        want = {str(pk) for pk in ChangeLogEntry.objects.filter(
            tenant=self.tenant).values_list("pk", flat=True)}
        count, seen = self._walk("/api/changelog/", 6)
        self.assertEqual(count, len(want))
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(set(seen), want)


class EveryListIsStableTests(SimpleTestCase):
    def test_every_paged_viewset_uses_the_stable_pagination(self):
        """A list that pages with another class would bring #529 back."""
        from django.conf import settings
        from django.utils.module_loading import import_string

        default = import_string(settings.REST_FRAMEWORK["DEFAULT_PAGINATION_CLASS"])
        self.assertTrue(issubclass(default, StablePagination))
        bad = set()

        def visit(patterns):
            for p in patterns:
                if hasattr(p, "url_patterns"):
                    visit(p.url_patterns)
                    continue
                cls = getattr(getattr(p, "callback", None), "cls", None)
                pager = getattr(cls, "pagination_class", None)
                if pager is not None and not issubclass(pager, StablePagination):
                    bad.add(f"{cls.__module__}.{cls.__name__}")

        visit(get_resolver().url_patterns)
        self.assertEqual(sorted(bad), [])

    def test_stable_order_appends_the_key_only_when_rows_can_tie(self):
        def terms(qs):
            return [str(t) for t in stable_order(qs).query.order_by]

        self.assertEqual(terms(VLAN.objects.order_by("vlan_id")), ["vlan_id", "pk"])
        self.assertEqual(terms(VLAN.objects.order_by()), ["pk"])
        self.assertEqual(terms(ChangeLogEntry.objects.all()), ["-timestamp", "pk"])
        self.assertEqual(terms(VLAN.objects.order_by("vlan_id", "-pk")), ["vlan_id", "-pk"])
        self.assertEqual(terms(VLAN.objects.order_by("-id")), ["-id"])
        # A values() list or a union keeps its ORDER BY: it may only name
        # what it selects.
        vals = VLAN.objects.order_by("vlan_id").values("vlan_id")
        self.assertIs(stable_order(vals), vals)
