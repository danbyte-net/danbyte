"""Importing NetBox rack-types, and each library kind needing add on what it
creates (#182)."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .devicetype_import import detect_kind, import_racktype_yaml, import_yaml_auto
from .models import DeviceType, DeviceTypeImportRun, ModuleType, RackType

User = get_user_model()

RACK = """
manufacturer: APC
model: AR3100
slug: apc-ar3100
form_factor: 4-post-cabinet
width: 19
u_height: 42
starting_unit: 1
outer_width: 600
outer_depth: 1070
outer_height: 1991
outer_unit: mm
max_weight: 1361
weight_unit: kg
description: NetShelter SX 42U
"""
DEVICE = "manufacturer: Cisco\nmodel: C9300-48P\nslug: c9300-48p\nu_height: 1\n"
MODULE = "manufacturer: Cisco\nmodel: C9300-NM-8X\ninterfaces:\n  - name: Te{module}/1\n    type: 10gbase-x-sfpp\n"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def user_with(self, *types):
        user = User.objects.create_user("u" + "".join(types), password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="p" + "".join(types), object_types=list(types),
            actions=["view", "add", "change"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        return user


class RackTypeImportTests(_Base):
    def test_a_rack_type_file_is_told_apart(self):
        import yaml

        self.assertEqual(detect_kind(yaml.safe_load(RACK)), "rack-type")
        self.assertEqual(detect_kind(yaml.safe_load(DEVICE)), "device-type")
        self.assertEqual(detect_kind(yaml.safe_load(MODULE)), "module-type")

    def test_fields_units_and_what_is_skipped(self):
        r = import_racktype_yaml(self.tenant, RACK)
        self.assertTrue(r["ok"], r)
        rt = RackType.objects.get(tenant=self.tenant, name="AR3100")
        self.assertEqual((rt.width, rt.u_height, rt.outer_width_mm, rt.outer_depth_mm),
                         (19, 42, 600, 1070))
        self.assertEqual((float(rt.max_weight), rt.max_weight_unit), (1361.0, "kg"))
        self.assertEqual(rt.manufacturer.name, "APC")
        self.assertEqual(rt.description, "NetShelter SX 42U")
        self.assertTrue(any("form_factor" in s for s in r["skipped"]))
        self.assertTrue(any("outer_height" in s for s in r["skipped"]))

    def test_inches_convert_and_a_bad_width_is_refused(self):
        r = import_racktype_yaml(self.tenant, RACK.replace("outer_unit: mm", "outer_unit: in")
                                 .replace("outer_width: 600", "outer_width: 24")
                                 .replace("outer_depth: 1070", "outer_depth: 42"))
        self.assertTrue(r["ok"], r)
        rt = RackType.objects.get(name="AR3100")
        self.assertEqual((rt.outer_width_mm, rt.outer_depth_mm), (610, 1067))
        bad = import_racktype_yaml(self.tenant, RACK.replace("model: AR3100", "model: X")
                                   .replace("width: 19", "width: 17"))
        self.assertFalse(bad["ok"])

    def test_a_second_import_of_the_same_model_is_refused(self):
        import_racktype_yaml(self.tenant, RACK)
        again = import_yaml_auto(self.tenant, RACK)
        self.assertFalse(again["ok"])
        self.assertEqual(again["kind"], "rack-type")


class KindPermissionTests(_Base):
    def post(self, *docs):
        return self.client.post("/api/device-types/import-yaml/", {"items": list(docs)},
                                format="json").json()["results"]

    def test_each_kind_needs_add_on_what_it_creates(self):
        self.login(self.user_with("devicetype"))
        rows = self.post(DEVICE, RACK, MODULE)
        self.assertEqual([r["ok"] for r in rows], [True, False, False])
        self.assertEqual(rows[1]["error"], "You can't add rack types.")
        self.assertFalse(RackType.objects.exists())
        self.assertFalse(ModuleType.objects.exists())

    def test_rack_types_with_the_rack_type_grant(self):
        self.login(self.user_with("devicetype", "racktype"))
        rows = self.post(RACK)
        self.assertTrue(rows[0]["ok"], rows)
        self.assertEqual(rows[0]["kind"], "rack-type")

    def grant(self, user, types, actions):
        perm = ObjectPermission.objects.create(
            name=f"{user.username}-{'-'.join(types)}", object_types=types, actions=actions)
        perm.users.add(user)
        perm.tenants.add(self.tenant)

    def test_seeing_the_catalog_is_not_enough(self):
        user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        self.grant(user, ["devicetype"], ["view"])
        self.login(user)
        r = self.client.post("/api/device-types/import-yaml/", {"items": [RACK]},
                             format="json")
        self.assertEqual(r.status_code, 403)
        r = self.client.post("/api/device-types/import-folder/", {
            "url": "https://github.com/netbox-community/devicetype-library/tree/master/rack-types/APC"},
            format="json")
        self.assertEqual(r.status_code, 403)

    def test_rack_types_only_from_the_rack_types_page(self):
        user = User.objects.create_user("racks", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        self.grant(user, ["devicetype"], ["view"])
        self.grant(user, ["racktype"], ["view", "add"])
        self.login(user)
        rows = self.post(RACK, DEVICE)
        self.assertEqual([r["ok"] for r in rows], [True, False])

    def test_the_background_run_rechecks_its_user(self):
        from .devicetype_import_tasks import run_devicetype_import

        user = self.user_with("devicetype")
        run = DeviceTypeImportRun.objects.create(
            tenant=self.tenant, source_url="https://github.com/x/y/tree/master/rack-types/APC",
            status="queued", created_by=user)

        class Resp:
            def __init__(self, text):
                self.text = text

            def raise_for_status(self):
                pass

        with mock.patch("api.devicetype_import.expand_github_dir", return_value=["a", "b"]), \
             mock.patch("core.ssrf.safe_get", side_effect=[Resp(RACK), Resp(DEVICE)]), \
             mock.patch("api.devicetype_import.repo_image_inventory", return_value=set()):
            run_devicetype_import(str(run.id))
        run.refresh_from_db()
        self.assertEqual((run.progress["created"], run.progress["failed"]), (1, 1))
        self.assertTrue(DeviceType.objects.filter(name="C9300-48P").exists())
        self.assertFalse(RackType.objects.exists())
