"""Config contexts: device/VM local context data (merged last) and matching
on device tags (any of the context's tags, AND with the other dimensions;
the context's own tenant's tags only)."""
from __future__ import annotations

import csv
import io
import json

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.config_context import LOCAL_SOURCE_NAME, render_config_context
from api.models import (
    Cluster,
    ClusterType,
    ConfigContext,
    Device,
    DeviceRole,
    ExportTemplate,
    Platform,
    Site,
    VirtualMachine,
)
from audit.models import ChangeLogEntry
from auth_api.models import UserProfile
from core.models import Organization, Tag, Tenant
from core.tags import merge_tags


def _body(resp) -> str:
    content = b"".join(resp.streaming_content) if resp.streaming else resp.content
    return content.decode().lstrip("﻿")


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Edge", slug="edge")
        self.plat = Platform.objects.create(tenant=self.tenant, name="IOS", slug="ios")
        ctype = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ctype)
        self.dev = Device.objects.create(
            tenant=self.tenant, name="edge1", site=self.site, role=self.role,
            platform=self.plat,
        )
        self.nat = Tag.objects.create(tenant=self.tenant, name="nat", slug="nat")
        self.wan = Tag.objects.create(tenant=self.tenant, name="wan", slug="wan")
        self.lab = Tag.objects.create(tenant=self.tenant, name="lab", slug="lab")
        self.theirs = Tag.objects.create(tenant=self.other, name="theirs", slug="theirs")
        self.legacy = Tag.objects.create(tenant=None, name="legacy", slug="legacy")
        self.admin = User.objects.create_user("cc-admin", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def ctx(self, name, data, weight=1000, tags=(), **dims):
        c = ConfigContext.objects.create(tenant=self.tenant, name=name, data=data, weight=weight)
        if tags:
            c.tags.set(tags)
        for k, v in dims.items():
            getattr(c, k).set(v)
        return c

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None


class MergeOrderTests(_Base):
    def test_local_data_merges_last_over_every_weight(self):
        self.ctx("low", {"route": "10.0.0.1", "ntp": {"a": 1}}, weight=10)
        self.ctx("high", {"route": "10.0.0.2", "ntp": {"b": 2}}, weight=9000)
        self.dev.local_context_data = {"route": "192.0.2.1", "ntp": {"c": 3}, "nat": True}
        self.dev.save()
        out = render_config_context(self.dev)
        self.assertEqual(out["rendered"]["route"], "192.0.2.1")
        self.assertEqual(out["rendered"]["ntp"], {"a": 1, "b": 2, "c": 3})
        self.assertTrue(out["rendered"]["nat"])
        self.assertEqual(out["applied"], ["low", "high"])

    def test_no_local_data_keeps_the_contexts(self):
        self.ctx("base", {"x": 1})
        out = render_config_context(self.dev)
        self.assertEqual(out["rendered"], {"x": 1})
        self.assertEqual([s["kind"] for s in out["sources"]], ["context"])

    def test_vm_local_data_merges_last(self):
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1", cluster=self.cluster, site=self.site, role=self.role,
            local_context_data={"x": "local"},
        )
        self.ctx("base", {"x": "ctx", "y": 1}, weight=5000)
        out = render_config_context(vm)
        self.assertEqual(out["rendered"], {"x": "local", "y": 1})


class TagMatchTests(_Base):
    def test_empty_tags_match_everything(self):
        self.ctx("all", {"a": 1})
        self.assertEqual(render_config_context(self.dev)["applied"], ["all"])

    def test_any_of_the_context_tags_matches(self):
        self.ctx("nat-or-wan", {"nat": True}, tags=[self.nat, self.wan])
        self.assertEqual(render_config_context(self.dev)["applied"], [])
        self.dev.tags.add(self.wan)
        self.assertEqual(render_config_context(self.dev)["applied"], ["nat-or-wan"])

    def test_tags_and_other_dimensions_all_must_match(self):
        other_role = DeviceRole.objects.create(tenant=self.tenant, name="Core", slug="core")
        self.ctx("nat-core", {"a": 1}, tags=[self.nat], device_roles=[other_role])
        self.ctx("nat-edge", {"b": 1}, tags=[self.nat], device_roles=[self.role])
        self.dev.tags.add(self.nat)
        self.assertEqual(render_config_context(self.dev)["applied"], ["nat-edge"])

    def test_vm_tags_match(self):
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="vm1", cluster=self.cluster)
        self.ctx("lab", {"lab": True}, tags=[self.lab])
        self.assertEqual(render_config_context(vm)["applied"], [])
        vm.tags.add(self.lab)
        self.assertEqual(render_config_context(vm)["applied"], ["lab"])

    def test_merge_moves_the_match_to_the_target_tag(self):
        c = self.ctx("nat", {"nat": True}, tags=[self.nat])
        merge_tags(self.nat, self.wan)
        self.assertEqual(list(c.tags.all()), [self.wan])


class ContextTagApiTests(_Base):
    URL = "/api/config-contexts/"

    def test_round_trip(self):
        body = self.ok(self.client.post(self.URL, {
            "name": "nat", "data": {"nat": True},
            "tag_ids": [self.nat.id, self.wan.id],
        }, format="json"), 201)
        self.assertEqual(sorted(t["slug"] for t in body["tags"]), ["nat", "wan"])
        body = self.ok(self.client.patch(f"{self.URL}{body['id']}/",
                                         {"tag_ids": [self.lab.id]}, format="json"))
        self.assertEqual([t["slug"] for t in body["tags"]], ["lab"])
        body = self.ok(self.client.get(f"{self.URL}{body['id']}/"))
        self.assertEqual([t["slug"] for t in body["tags"]], ["lab"])

    def test_other_tenants_tag_is_refused(self):
        r = self.client.post(self.URL, {"name": "x", "data": {},
                                        "tag_ids": [self.theirs.id]}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("tag_ids", r.json())
        self.assertFalse(ConfigContext.objects.filter(name="x").exists())

    def test_global_tag_is_refused(self):
        r = self.client.post(self.URL, {"name": "x", "data": {},
                                        "tag_ids": [self.legacy.id]}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("tag_ids", r.json())

    def test_update_refuses_another_tenants_tag(self):
        c = self.ctx("nat", {}, tags=[self.nat])
        r = self.client.patch(f"{self.URL}{c.id}/", {"tag_ids": [self.theirs.id]},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(list(c.tags.all()), [self.nat])

    def test_serializer_refuses_a_tag_from_another_tenant_than_the_context(self):
        from api.serializers import ConfigContextSerializer

        theirs_ctx = ConfigContext.objects.create(tenant=self.other, name="theirs")
        ser = ConfigContextSerializer(theirs_ctx, data={"tag_ids": [self.nat.id]},
                                      partial=True)
        self.assertFalse(ser.is_valid())
        self.assertIn("tag_ids", ser.errors)


class LocalDataApiTests(_Base):
    def test_device_round_trip(self):
        url = f"/api/devices/{self.dev.id}/"
        body = self.ok(self.client.patch(url, {"local_context_data": {"route": "192.0.2.1"}},
                                         format="json"))
        self.assertEqual(body["local_context_data"], {"route": "192.0.2.1"})
        self.assertEqual(self.ok(self.client.get(url))["local_context_data"],
                         {"route": "192.0.2.1"})
        body = self.ok(self.client.patch(url, {"local_context_data": {}}, format="json"))
        self.assertIsNone(body["local_context_data"])

    def test_device_refuses_a_non_object(self):
        r = self.client.patch(f"/api/devices/{self.dev.id}/",
                              {"local_context_data": [1, 2]}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("local_context_data", r.json())

    def test_vm_round_trip(self):
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="vm1", cluster=self.cluster)
        body = self.ok(self.client.patch(f"/api/virtual-machines/{vm.id}/",
                                         {"local_context_data": {"a": 1}}, format="json"))
        self.assertEqual(body["local_context_data"], {"a": 1})

    def test_change_log_records_local_data(self):
        self.ok(self.client.patch(f"/api/devices/{self.dev.id}/",
                                  {"local_context_data": {"nat": True}}, format="json"))
        entry = ChangeLogEntry.objects.filter(
            object_id=str(self.dev.id), action="update").order_by("-timestamp").first()
        self.assertIsNotNone(entry)
        self.assertIn("local_context_data", entry.changes)

    def test_rendered_view_labels_each_source(self):
        c = self.ctx("base", {"x": 1})
        self.dev.local_context_data = {"y": 2}
        self.dev.save()
        body = self.ok(self.client.get(f"/api/devices/{self.dev.id}/config-context/"))
        self.assertEqual(body["rendered"], {"x": 1, "y": 2})
        self.assertEqual(body["applied"], ["base"])
        self.assertEqual(body["sources"], [
            {"kind": "context", "id": str(c.id), "name": "base", "weight": 1000},
            {"kind": "local", "name": LOCAL_SOURCE_NAME},
        ])

    def test_template_render_sees_local_values(self):
        self.ctx("base", {"route": "10.0.0.1"})
        self.dev.local_context_data = {"route": "192.0.2.1"}
        self.dev.save()
        tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="cfg", object_type="device",
            template_code="ip route 0.0.0.0/0 {{ config_context.route }}",
        )
        r = self.client.get(f"/api/devices/{self.dev.id}/render/?template={tmpl.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("ip route 0.0.0.0/0 192.0.2.1", r.json()["output"])

    def test_csv_export_and_import_carry_local_data(self):
        self.dev.local_context_data = {"nat": True}
        self.dev.save()
        resp = self.client.get("/api/io/device/export/?fmt=csv")
        self.assertEqual(resp.status_code, 200)
        rows = list(csv.DictReader(io.StringIO(_body(resp))))
        row = next(r for r in rows if r["name"] == "edge1")
        self.assertEqual(json.loads(row["local_context_data"]), {"nat": True})
        row["local_context_data"] = json.dumps({"nat": False, "route": "192.0.2.9"})
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=list(row))
        w.writeheader()
        w.writerow(row)
        r = self.client.post("/api/io/device/import/",
                             {"format": "csv", "content": buf.getvalue()}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json().get("errors"), r.content)
        self.dev.refresh_from_db()
        self.assertEqual(self.dev.local_context_data, {"nat": False, "route": "192.0.2.9"})
