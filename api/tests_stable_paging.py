"""Every page is cut from a total order (#529) and read by its ids first
(#532).

VLAN IDs repeat across sites; ordered by the ID alone, rows sharing one had
no fixed order and each page could return a different slice of them, so a
walk over the pages showed some VLANs twice and others never. The
pagination now appends the primary key to any ORDER BY that can tie.
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext
from django.urls import get_resolver
from django.utils import timezone
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from core.models import Organization, Tenant

from .models import VLAN, IPAddress, Prefix, Site
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


class IdsFirstTests(_Tenant):
    """Any list pages its ids first: the page's rows, with their joins and
    per-row subqueries, are read for that page alone (#532)."""

    def setUp(self):
        super().setUp()
        p = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/16")
        theirs = Prefix.objects.create(tenant=self.other, cidr="10.0.0.0/16")
        for i in range(60):
            IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"10.0.{i // 250}.{i % 250 + 1}", prefix=p)
        IPAddress.objects.create(tenant=self.other, ip_address="10.0.0.1", prefix=theirs)

    def _page(self, url):
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r.json(), [q["sql"] for q in ctx.captured_queries]

    def test_a_deep_page_costs_what_page_one_does(self):
        first, body1, sql = self._page("/api/ips/?page_size=5&page=1")
        last, body12, _ = self._page("/api/ips/?page_size=5&page=12")
        self.assertEqual(first, last)
        self.assertEqual(body1["count"], 60)
        self.assertEqual(len(body12["results"]), 5)
        ids = [s for s in sql if s.startswith('SELECT "api_ipaddress"."id" AS "pk" FROM')
               and " LIMIT " in s]
        self.assertEqual(len(ids), 1, sql)
        self.assertIn("LIMIT 5", ids[0])

    def test_pages_match_the_one_query_answer(self):
        from .pagination import StandardResultsSetPagination

        _, seen = self._walk("/api/ips/", 7)
        whole = self.client.get("/api/ips/?page_size=1000").json()["results"]
        self.assertEqual(seen, [row["id"] for row in whole])
        # The other tenant's address never pages in.
        self.assertEqual(len(seen), 60)
        mine = {str(pk) for pk in IPAddress.objects.filter(
            tenant=self.tenant).values_list("pk", flat=True)}
        self.assertEqual(set(seen), mine)
        # Byte for byte what a one-query page answers.
        def one_query(self, queryset, request, view=None):
            return super(StablePagination, self).paginate_queryset(
                stable_order(queryset), request, view)

        paged = self.client.get("/api/ips/?page_size=9&page=3").json()
        with mock.patch.object(StandardResultsSetPagination, "paginate_queryset", one_query):
            plain = self.client.get("/api/ips/?page_size=9&page=3").json()
        self.assertEqual(paged, plain)
