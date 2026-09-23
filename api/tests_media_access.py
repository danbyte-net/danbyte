"""Uploaded files under /media/ are served only to someone who may view the
object they hang on (#227). Branding and device-type images stay public."""
from __future__ import annotations

import os
import shutil
import stat
import tempfile

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import TestCase, override_settings

from core.models import Organization, Tenant

from .models import (
    Device,
    DeviceRole,
    DeviceType,
    Document,
    Manufacturer,
    Site,
)

User = get_user_model()
MEDIA = tempfile.mkdtemp(prefix="danbyte-media-test-")


@override_settings(MEDIA_ROOT=MEDIA)
class MediaAccessTests(TestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        site = Site.objects.create(tenant=self.tenant, name="S")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="MX")
        role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        self.device = Device.objects.create(
            tenant=self.tenant, name="rtr1", device_type=dt, role=role, site=site,
        )
        self.doc = Document(
            tenant=self.tenant, name="Diagram", object_type="api.device",
            object_id=self.device.id,
        )
        self.doc.file.save(
            "core-network.pdf", ContentFile(b"%PDF-1.4 CONFIDENTIAL"), save=False
        )
        self.doc.save()
        self.url = f"/media/{self.doc.file.name}"
        self.admin = User.objects.create_superuser("admin", "a@x.com", "x")

    def _login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def test_a_document_is_stored_under_a_random_folder(self):
        parts = self.doc.file.name.split("/")
        self.assertEqual(parts[0], "documents")
        self.assertEqual(len(parts[1]), 32)
        self.assertEqual(parts[2], "core-network.pdf")

    def test_anonymous_gets_nothing(self):
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, 404)

    def test_the_owner_downloads_it_as_an_attachment(self):
        self._login(self.admin)
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(b"".join(r.streaming_content), b"%PDF-1.4 CONFIDENTIAL")
        self.assertIn("attachment", r["Content-Disposition"])
        self.assertEqual(r["X-Content-Type-Options"], "nosniff")
        self.assertIn("private", r["Cache-Control"])

    def test_another_tenant_cannot_reach_it(self):
        from auth_api.models import UserProfile

        outsider = User.objects.create_user("out", password="x")
        UserProfile.objects.create(user=outsider, role="custom").tenants.add(self.other)
        self._login(outsider, self.other)
        self.assertEqual(self.client.get(self.url).status_code, 404)

    def test_a_member_without_view_on_the_device_cannot_reach_it(self):
        from auth_api.models import UserProfile

        u = User.objects.create_user("noview", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        self._login(u)
        self.assertEqual(self.client.get(self.url).status_code, 404)

    def test_path_tricks_are_refused(self):
        self._login(self.admin)
        for bad in ("/media/../danbyte/settings.py", "/media/documents/%2e%2e/x",
                    "/media//etc/passwd"):
            with self.subTest(bad=bad):
                self.assertEqual(self.client.get(bad).status_code, 404)

    def test_branding_is_public_and_cacheable(self):
        os.makedirs(os.path.join(MEDIA, "branding"), exist_ok=True)
        with open(os.path.join(MEDIA, "branding", "logo.png"), "wb") as fh:
            fh.write(b"\x89PNG\r\n")
        r = self.client.get("/media/branding/logo.png")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("attachment", r.get("Content-Disposition", ""))
        self.assertIn("public", r["Cache-Control"])

    def test_an_unlisted_folder_is_never_served(self):
        os.makedirs(os.path.join(MEDIA, "oui-imports"), exist_ok=True)
        with open(os.path.join(MEDIA, "oui-imports", "x.csv"), "wb") as fh:
            fh.write(b"a,b")
        self._login(self.admin)
        self.assertEqual(self.client.get("/media/oui-imports/x.csv").status_code, 404)

    def test_a_new_upload_is_closed_to_other_users(self):
        mode = stat.S_IMODE(os.stat(self.doc.file.path).st_mode)
        self.assertEqual(mode & 0o007, 0, oct(mode))
        folder = os.path.dirname(self.doc.file.path)
        self.assertEqual(stat.S_IMODE(os.stat(folder).st_mode) & 0o007, 0)
