"""An Outpost of a deactivated tenant is refused.

Its token stops authenticating on every ``/api/outpost/`` endpoint and on the
build download, and the SSH driver stops dialling it - the same way an API
token dies with its tenant (#442).
"""
import shutil
import tempfile
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import MonitoringEngine, OutpostRelease
from .outpost_ssh import drive_ssh_outposts

MEDIA = tempfile.mkdtemp(prefix="danbyte-test-media-")


@override_settings(MEDIA_ROOT=MEDIA)
class OutpostTenantActiveTests(APITestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch-op", slug="branch-op",
            kind="remote", transport="pull", token={"secret": "tkn-abc"},
        )
        self.auth = {"HTTP_AUTHORIZATION": "Bearer tkn-abc"}

    def _deactivate(self):
        self.tenant.is_active = False
        self.tenant.save(update_fields=["is_active"])

    def test_pull_endpoints_refuse_the_token(self):
        self.assertEqual(self.client.get("/api/outpost/work/", **self.auth).status_code, 200)
        self._deactivate()
        self.assertEqual(self.client.get("/api/outpost/work/", **self.auth).status_code, 401)
        hello = self.client.post(
            "/api/outpost/hello/", {"version": "1.0.0"}, format="json", **self.auth
        )
        self.assertEqual(hello.status_code, 401)

    def test_download_refuses_the_token(self):
        OutpostRelease.objects.create(
            version="2.0.0", source="file",
            artifact=SimpleUploadedFile("danbyte-outpost-2.0.0.tar.gz", b"BUILD"),
        )
        url = "/api/outpost/download/2.0.0/"
        self.assertEqual(self.client.get(url, **self.auth).status_code, 200)
        self._deactivate()
        self.assertEqual(self.client.get(url, **self.auth).status_code, 401)

    def test_ssh_driver_skips_the_engine(self):
        MonitoringEngine.objects.create(
            tenant=self.tenant, name="ssh-op", slug="ssh-op", kind="remote",
            transport="ssh", ssh_host="10.8.0.1", ssh_user="danbyte",
            ssh_credential={"private_key": "KEY"},
        )
        drive = "monitoring.outpost_ssh.drive_ssh_engine"
        with mock.patch(drive, return_value={"ran": 0, "ingested": 0}) as run:
            self.assertEqual(drive_ssh_outposts()["engines"], 1)
        run.assert_called_once()
        self._deactivate()
        with mock.patch(drive) as run:
            self.assertEqual(drive_ssh_outposts()["engines"], 0)
        run.assert_not_called()
