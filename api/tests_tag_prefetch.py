"""Lists load tags as plain lists (#296).

``prefetch_related("tags")`` built a django-taggit queryset for every row just
to hold that row's tags - about 0.2 ms a row. The lists now prefetch
``core.tags.TAGS`` and the tag field reads the list: the same query, the same
tags in the same order, no per-row queryset, and a write is never answered
from a stale list.
"""
from __future__ import annotations

import csv
import io
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.models import prefetch_related_objects
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase
from taggit.managers import _TaggableManager

from core.models import Organization, Tag, Tenant
from core.tags import TAGS, tags_of

from .models import Cable, CableTermination, Device, Interface, IPAddress, Prefix, Site
from .serializers import TagSerializer

User = get_user_model()


class TagListTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.tags = [
            Tag.objects.create(tenant=self.tenant, name=f"t{i}", slug=f"t{i}",
                               color="#10b981" if i % 2 else "")
            for i in range(4)
        ]
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", site=site)
        pfx.tags.set(self.tags[1:3])
        for i in range(8):
            d = Device.objects.create(tenant=self.tenant, name=f"sw-{i}", site=site)
            # Several tags, added out of name order, on most rows.
            d.tags.set([self.tags[(i + k) % 4] for k in range(i % 4)])
            a = Interface.objects.create(device=d, name="eth0")
            b = Interface.objects.create(device=d, name="eth1")
            a.tags.set([self.tags[3], self.tags[0]][: i % 3])
            ip = IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"10.0.0.{i + 1}", prefix=pfx,
                assigned_device=d, assigned_interface=a,
            )
            ip.tags.set(self.tags[i % 2:: 2])
            cable = Cable.objects.create(tenant=self.tenant, label=f"c{i}")
            CableTermination.objects.create(cable=cable, end="A", interface=a)
            CableTermination.objects.create(cable=cable, end="B", interface=b)
            if i % 2:
                cable.tags.set(self.tags[:2])

    def _get(self, url):
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r.json()["results"]

    def test_lists_render_the_tags_a_plain_prefetch_did_at_flat_cost(self):
        for url, model in (
            ("/api/devices/", Device), ("/api/interfaces/", Interface),
            ("/api/ips/", IPAddress), ("/api/prefixes/", Prefix), ("/api/cables/", Cable),
        ):
            with self.subTest(url=url):
                small, _ = self._get(f"{url}?page_size=2")
                big, rows = self._get(f"{url}?page_size=50")
                self.assertEqual(small, big, "a bigger page must not cost more queries")
                # What the old prefetch_related("tags") rendered for the same rows.
                objs = list(model.objects.filter(pk__in=[r["id"] for r in rows]))
                prefetch_related_objects(objs, "tags")
                expected = {
                    str(o.pk): TagSerializer(o.tags.all(), many=True).data for o in objs
                }
                self.assertTrue(any(len(v) > 1 for v in expected.values()))
                for row in rows:
                    self.assertEqual(row["tags"], expected[row["id"]], row["id"])

    def test_no_row_builds_a_taggit_queryset(self):
        real = _TaggableManager.get_queryset
        with mock.patch.object(
            _TaggableManager, "get_queryset", autospec=True, side_effect=real
        ) as built:
            r = self.client.get("/api/interfaces/?page_size=50")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["results"]), 16)
        # One for the page's single tag query, none per row.
        self.assertEqual(built.call_count, 1)

    def test_a_tag_write_is_answered_with_the_new_tags(self):
        d = Device.objects.get(name="sw-3")
        url = f"/api/devices/{d.id}/"
        r = self.client.patch(url, {"tag_ids": [str(self.tags[2].id)]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([t["name"] for t in r.json()["tags"]], ["t2"])
        r = self.client.patch(url, {"tag_ids": []}, format="json")
        self.assertEqual(r.json()["tags"], [])
        r = self.client.patch(url, {"description": "x"}, format="json")
        self.assertEqual(r.json()["tags"], [])

    def test_bulk_tagging_reads_the_selection_tags_in_one_go(self):
        ids = [str(i.id) for i in Interface.objects.filter(name="eth1").order_by("device__name")]

        def tag_reads(selection):
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.post(
                    "/api/interfaces/bulk-update/",
                    {"ids": selection, "fields": {"add_tag_ids": [self.tags[1].id]}},
                    format="json",
                )
            self.assertEqual(r.status_code, 200, r.content)
            return sum('FROM "core_tag" INNER JOIN' in q["sql"] for q in ctx.captured_queries)

        self.assertEqual(tag_reads(ids[:2]), tag_reads(ids[2:]))
        for iface in Interface.objects.filter(name="eth1"):
            self.assertEqual([t.name for t in iface.tags.all()], ["t1"])

    def test_a_manager_write_drops_the_prefetched_list(self):
        d = Device.objects.prefetch_related(TAGS).get(name="sw-0")
        self.assertEqual(list(tags_of(d)), [])
        d.tags.add(self.tags[0])
        self.assertEqual([t.name for t in tags_of(d)], ["t0"])
        d = Device.objects.prefetch_related(TAGS).get(name="sw-0")
        d.tags.clear()
        self.assertEqual(list(tags_of(d)), [])

    def test_export_reads_the_prefetched_tags(self):
        def export():
            r = self.client.get("/api/io/device/export/?fmt=csv")
            self.assertEqual(r.status_code, 200)
            return b"".join(r.streaming_content).decode()

        export()
        with CaptureQueriesContext(connection) as ctx:
            text = export()
        rows = {r["name"]: r for r in csv.DictReader(io.StringIO(text))}
        self.assertEqual(rows["sw-0"]["tags"], "")
        expected = ";".join(t.name for t in Device.objects.get(name="sw-3").tags.all())
        self.assertEqual(sorted(rows["sw-3"]["tags"].split(";")), sorted(expected.split(";")))
        tag_reads = [q for q in ctx.captured_queries if 'FROM "core_tag"' in q["sql"]]
        self.assertEqual(len(tag_reads), 1)
