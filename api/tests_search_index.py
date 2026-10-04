"""Global search on the index (#89): folding, ranking, tokens, RBAC, the
special forms, and the signals that keep the table current."""
from __future__ import annotations

import uuid
from unittest import mock

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant

from . import search_views
from .models import VLAN, Device, DeviceRole, Prefix, SearchEntry, Site
from .search_index import fold, rebuild
from .search_views import CANDIDATES, parse_query, ranked_candidates
from .test_utils import status_for

User = get_user_model()


class ParseTests(APITestCase):
    def test_tokens_and_words(self):
        q, tokens = parse_query('core site:esbjerg type:device tag:"dc core"')
        self.assertEqual(q, "core")
        self.assertEqual(tokens, {"site": ["esbjerg"], "type": ["device"], "tag": ["dc core"]})
        self.assertEqual(parse_query("http://x:1")[0], "http://x:1")

    def test_fold(self):
        self.assertEqual(fold("Århus DC"), "arhus dc")
        self.assertEqual(fold("aarhus-sw1"), "arhus-sw1")
        self.assertEqual(fold("Næstved Ø"), "naestved o")
        self.assertEqual(fold("  Genève "), "geneve")

    def test_sql_fold_matches_python(self):
        from django.db import connection

        for raw in ("Århus DC", "aarhus-sw1", "Næstved Ø", "Genève", "München"):
            with connection.cursor() as c:
                c.execute("SELECT danbyte_fold(%s)", [raw])
                self.assertEqual(c.fetchone()[0], fold(raw), raw)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Beta", slug="beta")
        self.site = Site.objects.create(tenant=self.tenant, name="Århus DC")
        self.esbjerg = Site.objects.create(tenant=self.tenant, name="Esbjerg")
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Firewall", slug="firewall")
        self.fw = Device.objects.create(
            tenant=self.tenant, name="aarhus-fw1", site=self.site, role=self.role,
            description="Perimeter firewall",
        )
        self.sw = Device.objects.create(tenant=self.tenant, name="aarhus-sw1", site=self.site)
        self.esb = Device.objects.create(tenant=self.tenant, name="esbjerg-fw1", site=self.esbjerg,
                                         role=self.role)
        Device.objects.create(tenant=self.other, name="aarhus-other")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant),
            description="Aarhus management",
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/16", status=status_for(self.tenant))
        VLAN.objects.create(tenant=self.tenant, vlan_id=100, name="Servers")
        Tag.objects.create(name="core-net", slug="core-net")
        self.admin = User.objects.create_superuser("admin", "a@e.com", "x")
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _hits(self, q, **params):
        r = self.client.get("/api/search/", {"q": q, **params})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


class IndexTests(_Base):
    def test_signals_keep_the_index_current(self):
        entry = SearchEntry.objects.get(object_type="device", object_id=self.fw.id)
        self.assertEqual(entry.title, "aarhus-fw1")
        self.assertEqual(entry.facets["site"], ["arhus dc"])
        self.assertEqual(entry.facets["role"], ["firewall"])
        self.assertEqual(entry.context["site"], "Århus DC")
        self.assertEqual(entry.context["role"], "Firewall")
        hit = next(h for h in self._hits("aarhus-fw1")["hits"] if h["id"] == str(self.fw.id))
        self.assertEqual(hit["context"]["site"], "Århus DC")
        self.fw.name = "aarhus-fw9"
        self.fw.save()
        self.assertEqual(SearchEntry.objects.get(object_id=self.fw.id).title, "aarhus-fw9")
        self.fw.delete()
        self.assertFalse(SearchEntry.objects.filter(object_id=self.fw.id).exists())

    def test_rebuild_matches_signals(self):
        before = SearchEntry.objects.count()
        Device.objects.filter(pk=self.sw.pk).update(name="renamed-by-bulk")  # no signal
        self.assertEqual(SearchEntry.objects.get(object_id=self.sw.id).title, "aarhus-sw1")
        counts = rebuild(["device"])
        self.assertEqual(counts["device"], 4)
        self.assertEqual(SearchEntry.objects.get(object_id=self.sw.id).title, "renamed-by-bulk")
        self.assertEqual(SearchEntry.objects.count(), before)


class QueryTests(_Base):
    def test_folding_and_ranking(self):
        d = self._hits("aarhus")
        types = [(h["type"], h["title"]) for h in d["hits"]]
        # Prefix matches on the site (accent-folded) and the devices lead;
        # the other tenant's device never appears.
        self.assertIn(("site", "Århus DC"), types[:3])
        self.assertIn(("device", "aarhus-fw1"), types[:3])
        self.assertNotIn("aarhus-other", [t for _, t in types])
        d = self._hits("arhus dc")
        self.assertEqual((d["hits"][0]["type"], d["hits"][0]["title"]), ("site", "Århus DC"))

    def test_type_token_and_facets(self):
        d = self._hits("aarhus type:device")
        self.assertTrue(all(h["type"] == "device" for h in d["hits"]))
        self.assertEqual(d["facets"]["types"], [{"type": "device", "label": "Devices", "count": 2}])
        d = self._hits("fw type:devices site:esbjerg")
        self.assertEqual([h["title"] for h in d["hits"]], ["esbjerg-fw1"])
        d = self._hits("role:firewall")
        self.assertEqual(sorted(h["title"] for h in d["hits"]), ["aarhus-fw1", "esbjerg-fw1"])
        d = self._hits("aarhus", type="site")
        self.assertEqual([h["type"] for h in d["hits"]], ["site"])

    def test_address_queries_are_not_fuzzy(self):
        from .models import IPAddress

        st = status_for(self.tenant)
        p10 = Prefix.objects.create(tenant=self.tenant, cidr="10.10.0.0/24", status=st)
        IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.201", prefix=self.prefix, status=st)
        IPAddress.objects.create(tenant=self.tenant, ip_address="10.10.0.20", prefix=p10, status=st)
        Prefix.objects.create(tenant=self.tenant, cidr="10.150.20.0/24", status=st)
        d = self._hits("10.0.0.201")
        titles = [h["title"] for h in d["hits"]]
        self.assertEqual(titles[:3], ["10.0.0.201", "10.0.0.0/24", "10.0.0.0/16"])
        self.assertNotIn("10.10.0.20", titles)
        self.assertNotIn("10.150.20.0/24", titles)

    def test_ip_query_lists_containing_prefixes(self):
        d = self._hits("10.0.0.5")
        top = [(h["type"], h["title"]) for h in d["hits"][:2]]
        self.assertEqual(top, [("prefix", "10.0.0.0/24"), ("prefix", "10.0.0.0/16")])
        self.assertIn("contains", d["hits"][0]["subtitle"])
        d = self._hits("10.0.0.0/24")
        self.assertEqual(d["hits"][0]["title"], "10.0.0.0/24")

    def test_short_id_and_vlan_id(self):
        self.fw.refresh_from_db()
        # Short ids are per type, so every type's #1 ties on the number; the
        # device is in the top hits and a type token makes it exact.
        d = self._hits(str(self.fw.numid))
        self.assertIn(str(self.fw.id), [h["id"] for h in d["hits"][:5]])
        d = self._hits(f"{self.fw.numid} type:device")
        self.assertEqual(d["hits"][0]["id"], str(self.fw.id))
        d = self._hits("100 type:vlan")
        self.assertEqual(d["hits"][0]["title"], "100 · Servers")

    def test_paging(self):
        d = self._hits("aarhus", limit=2)
        self.assertEqual(len(d["hits"]), 2)
        self.assertEqual(d["next_cursor"], 2)
        d2 = self._hits("aarhus", limit=2, cursor=2)
        self.assertNotEqual(d["hits"][0]["id"], d2["hits"][0]["id"])

    def test_empty_query(self):
        d = self._hits("")
        self.assertEqual(d["hits"], [])

    def test_rbac_row_scope(self):
        viewer = User.objects.create_user("viewer", password="x")
        prof = UserProfile.objects.create(user=viewer)
        prof.tenants.add(self.tenant)
        g = Group.objects.create(name="esbjerg-only")
        viewer.groups.add(g)
        perm = ObjectPermission.objects.create(
            name="esbjerg devices", object_types=["device"], actions=["view"]
        )
        perm.groups.add(g)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.esbjerg)
        self.client.force_login(viewer)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        d = self._hits("fw1")
        self.assertEqual([h["title"] for h in d["hits"] if h["type"] == "device"], ["esbjerg-fw1"])


class ShortTermTests(_Base):
    """A term of one or two characters ranks names first (#300) and returns
    exactly what the full match returns."""

    def _entries(self, n, title, body="", weight=10, object_type="device"):
        SearchEntry.objects.bulk_create([
            SearchEntry(tenant=self.tenant, object_type=object_type, object_id=uuid.uuid4(),
                        title=title.format(i=i), body=body.format(i=i), url="/x", weight=weight)
            for i in range(n)
        ])

    @staticmethod
    def _rows(rows):
        return [(r["object_type"], r["object_id"], round(float(r["score"]), 6)) for r in rows]

    def _ranked(self, q):
        """The candidates for ``q`` and how many statements found them."""
        words, tokens = parse_query(q)
        with CaptureQueriesContext(connection) as ctx:
            rows = ranked_candidates(words, tokens, self.tenant)
        return self._rows(rows), len(ctx.captured_queries)

    def _full(self, q):
        """The candidates the full match (names, bodies, near-misses) finds."""
        words, tokens = parse_query(q)
        with mock.patch.object(search_views, "_SHORT_TERM", 0):
            return self._rows(ranked_candidates(words, tokens, self.tenant))

    def test_names_that_fill_the_list_answer_alone(self):
        self._entries(CANDIDATES + 20, "aar-sw-{i:03}")
        # Rows that only mention it in the body can never rank among them.
        self._entries(50, "port {i}", body="sw uplink", weight=6, object_type="interface")
        rows, statements = self._ranked("sw")
        self.assertEqual(statements, 1)
        self.assertEqual(len(rows), CANDIDATES)
        self.assertEqual({t for t, _, _ in rows}, {"device"})
        self.assertEqual(rows, self._full("sw"))

    def test_body_rows_that_could_rank_run_the_full_match(self):
        # The names are weak: a light type with the term inside a word...
        self._entries(CANDIDATES + 20, "role {i:03} xswx", weight=3, object_type="contactrole")
        # ...so a heavy row whose whole body is the term outranks them.
        self._entries(5, "router {i}", body="sw")
        routers = set(SearchEntry.objects.filter(title__startswith="router ")
                      .values_list("object_id", flat=True))
        rows, statements = self._ranked("sw")
        self.assertEqual(statements, 2)
        ids = [i for _, i, _ in rows]
        first_role = next(n for n, (t, _, _) in enumerate(rows) if t == "contactrole")
        self.assertEqual(len(routers), 5)
        self.assertTrue(all(i in ids[:first_role] for i in routers))
        self.assertEqual(rows, self._full("sw"))

    def test_few_names_still_match_bodies(self):
        # "pe" is only in aarhus-fw1's description ("Perimeter firewall").
        rows, statements = self._ranked("pe")
        self.assertEqual(statements, 2)
        self.assertIn(("device", self.fw.id), [(t, i) for t, i, _ in rows])
        self.assertEqual(rows, self._full("pe"))

    def test_same_candidates_as_the_full_match(self):
        self._entries(CANDIDATES, "esb-fw-{i:03}", body="Ærø firewall")
        self._entries(CANDIDATES, "10.9.{i}.1", weight=9, object_type="ipaddress")
        for q in ("fw", "10", "1", "a", "æ", "ø", "pe", "s-", "#1", "fw site:esbjerg",
                  "10 type:ipaddress"):
            with self.subTest(q=q):
                self.assertEqual(self._ranked(q)[0], self._full(q))

