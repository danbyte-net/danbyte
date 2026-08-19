"""Document attachments (#12) - generic file/link attach, private downloads,
SSRF-guarded links, RBAC/tenant/site scoping, and the dead-link sweep.

Load-bearing guarantees under test: exactly one of file/url; you can only attach
to (and download for) an object you can view; external links are SSRF-checked;
files are served through the private download action, never a raw /media path;
and tenant isolation holds on list + download.
"""
from __future__ import annotations

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Device, DeviceRole, DeviceType, Document, DocumentCategory, Manufacturer, Site,
)

User = get_user_model()


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="S")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="MX")
        role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        self.device = Device.objects.create(
            tenant=self.tenant, name="rtr1", device_type=dt, role=role, site=self.site,
        )
        self.admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self._login(self.admin)

    def _login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def _member(self, name, perms):
        """A non-superuser in the tenant granted `perms` = [(object_types, actions)]."""
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        for object_types, actions in perms:
            op = ObjectPermission.objects.create(
                name=f"{name}-{'-'.join(object_types)}",
                object_types=object_types, actions=actions,
            )
            op.users.add(u)
        return u

    def _pdf(self, name="d.pdf", body=b"%PDF-1.4 hello"):
        return SimpleUploadedFile(name, body, content_type="application/pdf")


class DocumentFileTests(_Base):
    def test_create_file_document_and_private_download(self):
        r = self.client.post(
            "/api/documents/",
            {"name": "Datasheet", "object_type": "api.device",
             "object_id": str(self.device.id), "file": self._pdf()},
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        # Never leak the raw /media path; expose the private download route.
        self.assertNotIn("/media/", str(body))
        # Storage may append a dedupe suffix; the basename stays a .pdf.
        self.assertTrue(body["file_name"].endswith(".pdf"), body["file_name"])
        self.assertEqual(body["download_url"], f"/api/documents/{body['id']}/download/")
        # object_site_id is stamped from the target device.
        doc = Document.objects.get(pk=body["id"])
        self.assertEqual(doc.object_site_id, self.site.id)
        self.assertEqual(doc.object_type, "api.device")

        d = self.client.get(body["download_url"])
        self.assertEqual(d.status_code, 200)
        self.assertIn("attachment", d["Content-Disposition"])
        self.assertEqual(b"".join(d.streaming_content), b"%PDF-1.4 hello")

    def test_reject_disallowed_extension(self):
        r = self.client.post(
            "/api/documents/",
            {"name": "x", "object_type": "api.device", "object_id": str(self.device.id),
             "file": SimpleUploadedFile("evil.exe", b"MZ", content_type="x")},
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_download_404_for_link_only(self):
        with patch("core.ssrf.assert_public_url", return_value=None):
            r = self.client.post(
                "/api/documents/",
                {"name": "Vendor", "object_type": "api.device",
                 "object_id": str(self.device.id), "url": "https://vendor.example/doc"},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 201, r.content)
        did = r.json()["id"]
        self.assertIsNone(r.json()["download_url"])
        self.assertEqual(
            self.client.get(f"/api/documents/{did}/download/").status_code, 404
        )


class DocumentLinkAndConstraintTests(_Base):
    def test_create_link_document(self):
        with patch("core.ssrf.assert_public_url", return_value=None):
            r = self.client.post(
                "/api/documents/",
                {"name": "Runbook", "object_type": "api.device",
                 "object_id": str(self.device.id), "url": "https://ex.example/rb"},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["url"], "https://ex.example/rb")
        self.assertEqual(r.json()["link_status"], "unknown")

    def test_exactly_one_of_file_or_url_neither(self):
        r = self.client.post(
            "/api/documents/",
            {"name": "x", "object_type": "api.device", "object_id": str(self.device.id)},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_exactly_one_of_file_or_url_both(self):
        r = self.client.post(
            "/api/documents/",
            {"name": "x", "object_type": "api.device", "object_id": str(self.device.id),
             "url": "https://ex.example/x", "file": self._pdf()},
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_ssrf_rejects_loopback_url(self):
        r = self.client.post(
            "/api/documents/",
            {"name": "x", "object_type": "api.device", "object_id": str(self.device.id),
             "url": "http://127.0.0.1:8000/secret"},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("url", r.json())

    def test_unknown_object_type_400(self):
        r = self.client.post(
            "/api/documents/",
            {"name": "x", "object_type": "api.doesnotexist",
             "object_id": str(self.device.id), "url": "https://ex.example/x"},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)


class DocumentPermissionTests(_Base):
    def test_view_gate_blocks_attach_to_unviewable_object(self):
        # A member who may add documents but cannot view devices must not be able
        # to attach one to a device (object_type/object_id are attacker-set).
        member = self._member("adder", [(["document"], ["view", "add"])])
        self._login(member)
        with patch("core.ssrf.assert_public_url", return_value=None):
            r = self.client.post(
                "/api/documents/",
                {"name": "x", "object_type": "api.device",
                 "object_id": str(self.device.id), "url": "https://ex.example/x"},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 403, r.content)

    def test_view_gate_allows_when_target_viewable(self):
        member = self._member(
            "both", [(["document"], ["view", "add"]), (["device"], ["view"])]
        )
        self._login(member)
        with patch("core.ssrf.assert_public_url", return_value=None):
            r = self.client.post(
                "/api/documents/",
                {"name": "ok", "object_type": "api.device",
                 "object_id": str(self.device.id), "url": "https://ex.example/x"},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 201, r.content)


class DocumentTenantIsolationTests(_Base):
    def _other_tenant_doc(self):
        org2 = Organization.objects.create(name="Other", slug="other")
        t2 = Tenant.objects.create(org=org2, name="Other", slug="other")
        s2 = Site.objects.create(tenant=t2, name="S2")
        return Document.objects.create(
            tenant=t2, object_type="api.site", object_id=s2.id,
            object_site_id=s2.id, name="foreign", file=self._pdf("f.pdf"),
        )

    def test_foreign_document_not_listed_or_downloadable(self):
        foreign = self._other_tenant_doc()
        # Active tenant is self.tenant; the foreign row must be invisible…
        listed = self.client.get(
            f"/api/documents/?object_type=api.site&object_id={foreign.object_id}"
        )
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json()["count"], 0)
        # …and its download 404s (outside the tenant-scoped queryset).
        self.assertEqual(
            self.client.get(f"/api/documents/{foreign.id}/download/").status_code, 404
        )


class DocumentCategoryTests(_Base):
    def test_category_crud(self):
        r = self.client.post(
            "/api/document-categories/",
            {"name": "Warranty", "color": "#2563eb"},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        cid = r.json()["id"]
        self.assertEqual(
            self.client.get("/api/document-categories/").json()["count"], 1
        )
        p = self.client.patch(
            f"/api/document-categories/{cid}/",
            {"name": "Warranties"}, content_type="application/json",
        )
        self.assertEqual(p.status_code, 200, p.content)
        self.assertEqual(p.json()["name"], "Warranties")
        self.assertEqual(
            self.client.delete(f"/api/document-categories/{cid}/").status_code, 204
        )
        self.assertFalse(DocumentCategory.objects.filter(pk=cid).exists())

    def test_category_attached_to_document(self):
        cat = DocumentCategory.objects.create(tenant=self.tenant, name="Runbook")
        r = self.client.post(
            "/api/documents/",
            {"name": "d", "object_type": "api.device", "object_id": str(self.device.id),
             "category": str(cat.id), "file": self._pdf()},
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["category_detail"]["name"], "Runbook")


class DocumentLinkCheckCommandTests(_Base):
    def test_linkcheck_marks_ok_and_broken(self):
        from django.core.management import call_command

        d1 = Document.objects.create(
            tenant=self.tenant, object_type="api.device", object_id=self.device.id,
            object_site_id=self.site.id, name="ok", url="https://ex.example/ok",
        )
        d2 = Document.objects.create(
            tenant=self.tenant, object_type="api.device", object_id=self.device.id,
            object_site_id=self.site.id, name="bad", url="https://ex.example/bad",
        )

        class _Resp:
            def __init__(self, code):
                self.status_code = code

        def fake_get(url, **kw):
            if url.endswith("/bad"):
                return _Resp(404)
            return _Resp(200)

        with patch("api.management.commands.document_linkcheck.safe_get", fake_get):
            call_command("document_linkcheck")
        d1.refresh_from_db()
        d2.refresh_from_db()
        self.assertEqual(d1.link_status, "ok")
        self.assertEqual(d1.link_status_code, 200)
        self.assertEqual(d2.link_status, "broken")
        self.assertEqual(d2.link_status_code, 404)
        self.assertIsNotNone(d1.link_checked_at)
