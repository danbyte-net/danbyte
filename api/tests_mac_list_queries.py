"""The MAC list and the other tag-carrying lists outside the viewsets load
tags through ``core.tags.TAGS`` (#393).

``prefetch_related("tags")`` builds a django-taggit queryset for every row
just to hold its tags; on 20,000 MACs that was most of a 15-second answer.
Each list here must answer at a flat query cost, build no taggit queryset per
row, and render the same tags the plain prefetch did.
"""
from __future__ import annotations

from contextlib import contextmanager
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.models import prefetch_related_objects
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase
from taggit.managers import _TaggableManager

from compliance.engine import evaluate
from compliance.models import ComplianceRule
from core.models import Organization, Tag, Tenant

from .models import Device, Interface, MACAddress, Site
from .serializers import TagSerializer
from .topology_enrich import _card_tags, _prefetch_card_relations

User = get_user_model()


@contextmanager
def taggit_querysets():
    """Counts the django-taggit querysets built inside the block."""
    real = _TaggableManager.get_queryset
    with mock.patch.object(
        _TaggableManager, "get_queryset", autospec=True, side_effect=real
    ) as built:
        yield built


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.client.force_login(User.objects.create_superuser("root", "r@a.c", "x"))
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.tags = [
            Tag.objects.create(tenant=self.tenant, name=f"t{i}", slug=f"t{i}",
                               color="#10b981" if i % 2 else "")
            for i in range(4)
        ]
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.n = 0

    def add_macs(self, count):
        for _ in range(count):
            i = self.n
            self.n += 1
            d = Device.objects.create(tenant=self.tenant, name=f"sw-{i}", site=self.site,
                                      latitude=55.0 + i / 100, longitude=12.0)
            d.tags.set([self.tags[(i + k) % 4] for k in range(i % 3)])
            iface = Interface.objects.create(device=d, name=f"eth{i}")
            m = MACAddress.objects.create(
                tenant=self.tenant, mac_address=f"02:00:00:00:{i // 256:02x}:{i % 256:02x}",
                assigned_interface=iface if i % 2 else None, description=f"m{i}",
            )
            # Several tags, out of name order, on most rows.
            m.tags.set([self.tags[(i + k) % 4] for k in range(i % 4)])

    def cost(self, url, only_tags=False):
        """``(queries, taggit querysets, body)`` of a second GET of ``url``;
        ``only_tags`` counts the tag queries alone."""
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx, taggit_querysets() as built:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        queries = [q for q in ctx.captured_queries
                   if not only_tags or '"core_tag"' in q["sql"]]
        return len(queries), built.call_count, r.json()

    @staticmethod
    def plain_prefetch(objs):
        """``{pk: [tag slug]}`` as the plain ``prefetch_related("tags")``
        lists them - the order the views rendered before."""
        objs = list(objs)
        prefetch_related_objects(objs, "tags")
        return {str(o.pk): [t.slug for t in o.tags.all()] for o in objs}


class MacListTests(_Base):
    def test_flat_cost_no_per_row_taggit_queryset(self):
        self.add_macs(4)
        small_q, small_t, _ = self.cost("/api/macs/")
        self.add_macs(26)
        big_q, big_t, body = self.cost("/api/macs/")
        self.assertEqual(body["count"], 30)
        self.assertEqual(small_q, big_q, "more MACs must not cost more queries")
        self.assertEqual(big_t, small_t)
        self.assertLessEqual(big_t, 1)

    def test_rows_show_what_the_plain_prefetch_did(self):
        self.add_macs(12)
        _, _, body = self.cost("/api/macs/")
        objs = list(MACAddress.objects.filter(tenant=self.tenant)
                    .select_related("assigned_interface__device"))
        prefetch_related_objects(objs, "tags")
        expected = {
            str(m.pk): {
                "tags": TagSerializer(m.tags.all(), many=True).data,
                "assigned_interface": {
                    "id": str(m.assigned_interface.id),
                    "name": m.assigned_interface.name,
                    "device": {"id": str(m.assigned_interface.device_id),
                               "name": m.assigned_interface.device.name},
                } if m.assigned_interface_id else None,
                "numid": m.numid, "description": m.description,
            }
            for m in objs
        }
        self.assertTrue(any(len(v["tags"]) > 1 for v in expected.values()))
        seen = 0
        for row in body["results"]:
            for o in row["objects"]:
                want = expected[o["id"]]
                self.assertEqual(o["tags"], want["tags"], o["mac_address"])
                self.assertEqual(o["assigned_interface"], want["assigned_interface"])
                self.assertEqual((o["numid"], o["description"]),
                                 (want["numid"], want["description"]))
                seen += 1
        self.assertEqual(seen, 12)

    def test_detail_shows_the_object_tags(self):
        self.add_macs(4)
        (m,) = MACAddress.objects.filter(description="m3").prefetch_related("tags")
        r = self.client.get(f"/api/macs/{m.mac_address}/")
        self.assertEqual(r.status_code, 200, r.content)
        (obj,) = r.json()["objects"]
        self.assertEqual(obj["tags"], TagSerializer(m.tags.all(), many=True).data)
        self.assertEqual(len(obj["tags"]), 3)


class OtherTagListTests(_Base):
    def test_site_map_devices(self):
        self.add_macs(3)
        small_q, small_t, _ = self.cost("/api/site-map/")
        self.add_macs(9)
        big_q, big_t, body = self.cost("/api/site-map/")
        self.assertEqual(len(body["devices"]), 12)
        self.assertEqual((small_q, small_t), (big_q, big_t))
        want = self.plain_prefetch(Device.objects.filter(tenant=self.tenant))
        self.assertTrue(any(len(v) > 1 for v in want.values()))
        for d in body["devices"]:
            self.assertEqual([t["slug"] for t in d["tags"]], want[d["id"]])

    def test_ansible_inventory(self):
        self.add_macs(3)
        # The config context still costs a query per host; the tags must not.
        small_q, small_t, _ = self.cost("/api/inventory/ansible/", only_tags=True)
        self.add_macs(9)
        big_q, big_t, body = self.cost("/api/inventory/ansible/", only_tags=True)
        self.assertEqual((small_q, small_t), (big_q, big_t))
        hv = body["_meta"]["hostvars"]["sw-2"]["danbyte"]
        self.assertEqual(sorted(hv["tags"]), ["t2", "t3"])
        self.assertIn("sw-2", body["tag_t3"]["hosts"])

    def test_topology_card_tags(self):
        self.add_macs(6)
        devices = list(Device.objects.filter(tenant=self.tenant))
        with taggit_querysets() as built:
            _prefetch_card_relations(devices, {"tags"})
            cards = {d.name: [t["slug"] for t in _card_tags(d)] for d in devices}
        self.assertLessEqual(built.call_count, 1)
        want = self.plain_prefetch(devices)
        for d in devices:
            self.assertEqual(cards[d.name], want[str(d.pk)])

    def test_compliance_required_tag(self):
        self.add_macs(9)
        rule = ComplianceRule.objects.create(
            tenant=self.tenant, name="tagged", object_type="device",
            check_type="required_tag", tag="t1",
        )
        with taggit_querysets() as built:
            out = evaluate(self.tenant, [rule])
        self.assertLessEqual(built.call_count, 1)
        missing = {v["object_repr"] for v in out["violations"]}
        want = {d.name for d in Device.objects.filter(tenant=self.tenant)
                if "t1" not in {t.slug for t in d.tags.all()}}
        self.assertEqual(missing, want)
        self.assertTrue(want and len(want) < 9)
