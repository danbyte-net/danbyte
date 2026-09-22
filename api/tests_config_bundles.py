"""Config bundles, bulk rendering, and what a push tool last put on a box."""
from __future__ import annotations

import hashlib
import io
import tarfile

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from integrations.models import ConfigPush

from .models import ConfigBundle, Device, DeviceRole, DeviceType, ExportTemplate, Manufacturer, Site

User = get_user_model()


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        site = Site.objects.create(tenant=self.tenant, name="DC1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.leaf_role = DeviceRole.objects.create(tenant=self.tenant, name="leaf", slug="leaf")
        self.spine_role = DeviceRole.objects.create(tenant=self.tenant, name="spine", slug="spine")
        self.leaf1 = Device.objects.create(
            tenant=self.tenant, name="leaf1", device_type=dt, site=site, role=self.leaf_role
        )
        self.leaf2 = Device.objects.create(
            tenant=self.tenant, name="leaf2", device_type=dt, site=site, role=self.leaf_role
        )
        self.spine = Device.objects.create(
            tenant=self.tenant, name="spine1", device_type=dt, site=site, role=self.spine_role
        )
        self.frr = ExportTemplate.objects.create(
            tenant=self.tenant, name="frr", object_type="device",
            template_code="hostname {{ device.name }}\n", target_path="/etc/frr/frr.conf",
        )
        self.ifaces = ExportTemplate.objects.create(
            tenant=self.tenant, name="interfaces", object_type="device",
            template_code="auto lo\n# {{ device.name }}\n",
            target_path="/etc/network/interfaces",
        )
        self.bundle = ConfigBundle.objects.create(tenant=self.tenant, name="leaf-files")
        self.bundle.templates.set([self.frr, self.ifaces])
        self.bundle.roles.set([self.leaf_role])
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class BundleRenderTests(_Base):
    def test_a_bundle_renders_every_file_keyed_by_path(self):
        r = self.client.get(f"/api/devices/{self.leaf1.id}/render/?bundle=leaf-files")

        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["bundle"], "leaf-files")
        self.assertEqual(
            list(body["files"]), ["/etc/frr/frr.conf", "/etc/network/interfaces"]
        )
        frr = body["files"]["/etc/frr/frr.conf"]
        self.assertEqual(frr["output"], "hostname leaf1")
        self.assertEqual(frr["sha256"], sha("hostname leaf1"))
        self.assertIsNone(frr["pushed"])
        self.assertIsNone(frr["drift"])  # never pushed: unknown, not "no"

    def test_role_picks_the_bundle_bound_to_the_devices_role(self):
        r = self.client.get(f"/api/devices/{self.leaf1.id}/render/?bundle=role")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["bundle"], "leaf-files")

        r = self.client.get(f"/api/devices/{self.spine.id}/render/?bundle=role")
        self.assertEqual(r.status_code, 400)
        self.assertIn("No bundle is bound", r.json()["detail"])

    def test_two_bundles_on_one_role_is_an_error_not_a_guess(self):
        second = ConfigBundle.objects.create(tenant=self.tenant, name="also-leaf")
        second.roles.set([self.leaf_role])
        r = self.client.get(f"/api/devices/{self.leaf1.id}/render/?bundle=role")
        self.assertEqual(r.status_code, 400)
        self.assertIn("more than one bundle", r.json()["detail"])

    def test_a_tarball_keeps_paths_relative(self):
        r = self.client.get(
            f"/api/devices/{self.leaf1.id}/render/?bundle=leaf-files&archive=tar"
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Type"], "application/x-tar")
        with tarfile.open(fileobj=io.BytesIO(r.content)) as tar:
            names = sorted(tar.getnames())
            self.assertEqual(names, ["leaf1/etc/frr/frr.conf", "leaf1/etc/network/interfaces"])
            self.assertEqual(
                tar.extractfile("leaf1/etc/frr/frr.conf").read(), b"hostname leaf1"
            )

    def test_a_single_template_render_carries_its_path_and_hash(self):
        r = self.client.get(f"/api/devices/{self.leaf1.id}/render/?template={self.frr.id}")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["output"], "hostname leaf1")
        self.assertEqual(body["path"], "/etc/frr/frr.conf")
        self.assertEqual(body["sha256"], sha("hostname leaf1"))
        self.assertEqual(body["template"], "frr")

    def test_another_tenants_bundle_is_not_found(self):
        foreign = ConfigBundle.objects.create(tenant=self.other, name="theirs")
        r = self.client.get(f"/api/devices/{self.leaf1.id}/render/?bundle={foreign.id}")
        self.assertEqual(r.status_code, 400)
        r = self.client.get(f"/api/devices/{self.leaf1.id}/render/?bundle=theirs")
        self.assertEqual(r.status_code, 400)


class BulkRenderTests(_Base):
    def test_every_leaf_renders_in_one_call(self):
        r = self.client.get("/api/devices/render/?bundle=role&role_slug=leaf")

        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            sorted(d["name"] for d in body["devices"].values()), ["leaf1", "leaf2"]
        )
        self.assertEqual(body["skipped"], {})
        leaf2 = body["devices"][str(self.leaf2.id)]
        self.assertEqual(leaf2["files"]["/etc/frr/frr.conf"]["output"], "hostname leaf2")

    def test_hashes_only_leaves_the_text_out(self):
        r = self.client.get(f"/api/devices/render/?template={self.frr.id}&hashes=1")
        self.assertEqual(r.status_code, 200, r.content)
        row = r.json()["devices"][str(self.leaf1.id)]["files"]["/etc/frr/frr.conf"]
        self.assertNotIn("output", row)
        self.assertEqual(row["sha256"], sha("hostname leaf1"))

    def test_a_device_the_target_does_not_apply_to_is_skipped_not_fatal(self):
        r = self.client.get("/api/devices/render/?bundle=role")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertIn(str(self.spine.id), body["skipped"])
        self.assertEqual(len(body["devices"]), 2)

    def test_the_cap_is_a_named_refusal(self):
        from unittest import mock

        with mock.patch("api.config_bundles.MAX_BULK_DEVICES", 2):
            r = self.client.get(f"/api/devices/render/?template={self.frr.id}")
        self.assertEqual(r.status_code, 400)
        self.assertIn("cap is 2", r.json()["detail"])


class ConfigPushTests(_Base):
    def test_a_push_is_recorded_and_the_next_render_compares_against_it(self):
        text = "hostname leaf1"
        r = self.client.post(f"/api/devices/{self.leaf1.id}/config-pushed/", {
            "files": [{"path": "/etc/frr/frr.conf", "sha256": sha(text), "output": text}],
            "bundle": "leaf-files", "source": "ansible",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(ConfigPush.objects.count(), 1)

        r = self.client.get(f"/api/devices/{self.leaf1.id}/render/?template={self.frr.id}")
        body = r.json()
        self.assertFalse(body["drift"])
        self.assertEqual(body["pushed"]["sha256"], sha(text))
        self.assertEqual(body["pushed"]["by"], "admin")
        self.assertEqual(body["diff"], "")

        # The model changes: the render moves, the push does not.
        self.frr.template_code = "hostname {{ device.name }}\n! v2\n"
        self.frr.save()
        r = self.client.get(f"/api/devices/{self.leaf1.id}/render/?template={self.frr.id}")
        body = r.json()
        self.assertTrue(body["drift"])
        self.assertIn("+! v2", body["diff"])
        self.assertIn("rendered now", body["diff"])

    def test_the_shorthand_and_a_hash_only_push(self):
        r = self.client.post(f"/api/devices/{self.leaf1.id}/config-pushed/", {
            "path": "/etc/frr/frr.conf", "sha256": sha("hostname leaf1"),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.get(f"/api/devices/{self.leaf1.id}/render/?template={self.frr.id}")
        body = r.json()
        self.assertFalse(body["drift"])
        self.assertFalse(body["pushed"]["has_output"])
        # Nothing to diff against, but the hash still says whether it moved.
        self.frr.template_code = "hostname {{ device.name }} changed\n"
        self.frr.save()
        body = self.client.get(
            f"/api/devices/{self.leaf1.id}/render/?template={self.frr.id}"
        ).json()
        self.assertTrue(body["drift"])
        self.assertEqual(body["diff"], "")

    def test_a_hash_that_does_not_match_the_text_is_refused(self):
        r = self.client.post(f"/api/devices/{self.leaf1.id}/config-pushed/", {
            "path": "/etc/frr/frr.conf", "sha256": "0" * 64, "output": "hostname leaf1",
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("does not match", str(r.json()["files"]))

    def test_the_latest_push_per_path_wins(self):
        old, new = "old\n", "hostname leaf1"
        for text in (old, new):
            self.client.post(f"/api/devices/{self.leaf1.id}/config-pushed/", {
                "path": "/etc/frr/frr.conf", "sha256": sha(text), "output": text,
            }, format="json")
        body = self.client.get(
            f"/api/devices/{self.leaf1.id}/render/?template={self.frr.id}"
        ).json()
        self.assertFalse(body["drift"])
        self.assertEqual(ConfigPush.objects.count(), 2)


class BundleApiTests(_Base):
    def test_only_device_templates_and_no_path_clashes(self):
        csv = ExportTemplate.objects.create(
            tenant=self.tenant, name="ips", object_type="ipaddress", template_code="x",
        )
        r = self.client.post("/api/config-bundles/", {
            "name": "bad", "template_ids": [str(csv.id)],
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("template_ids", r.json())

        clash = ExportTemplate.objects.create(
            tenant=self.tenant, name="frr-too", object_type="device",
            template_code="y", target_path="/etc/frr/frr.conf",
        )
        r = self.client.post("/api/config-bundles/", {
            "name": "bad2", "template_ids": [str(self.frr.id), str(clash.id)],
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("both land", str(r.json()["template_ids"]))

    def test_a_bundle_lists_its_templates_paths_and_roles(self):
        r = self.client.get("/api/config-bundles/")
        self.assertEqual(r.status_code, 200, r.content)
        row = r.json()["results"][0]
        self.assertEqual(
            [t["bundle_path"] for t in row["templates"]],
            ["/etc/frr/frr.conf", "/etc/network/interfaces"],
        )
        self.assertEqual([x["slug"] for x in row["roles"]], ["leaf"])
        r = self.client.get(f"/api/config-bundles/?role={self.spine_role.id}")
        self.assertEqual(r.json()["results"], [])

    def test_a_template_without_a_target_path_is_keyed_by_its_name(self):
        plain = ExportTemplate.objects.create(
            tenant=self.tenant, name="motd", object_type="device", template_code="hi",
            file_extension="txt",
        )
        self.assertEqual(plain.bundle_path, "motd.txt")
