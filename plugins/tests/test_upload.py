"""Offline plugin upload — install/uninstall + safety, superuser-gated."""
from __future__ import annotations

import io
import tarfile
import tempfile

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APITestCase

UPLOAD_URL = "/api/plugins/upload/"


def _plugin_tar(pkg="danbyte_uptest", *, extra=None) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        def add(name, content):
            data = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))

        add(f"{pkg}/__init__.py", "")
        add(
            f"{pkg}/apps.py",
            "from plugins.base import DanbytePluginConfig\n"
            f"class Cfg(DanbytePluginConfig):\n    name = '{pkg}'\n",
        )
        add(f"{pkg}/danbyte_plugin.py", "")
        for n, c in (extra or {}).items():
            add(n, c)
    return buf.getvalue()


def _traversal_tar() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        data = b"pwned"
        info = tarfile.TarInfo("../evil.py")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class PluginUploadTests(APITestCase):
    def setUp(self):
        self.superuser = User.objects.create_superuser("root", "r@a.com", "pw")
        self.plain = User.objects.create_user("plain", "p@a.com", "pw")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def _override(self):
        from pathlib import Path

        return override_settings(PLUGIN_UPLOAD_DIR=Path(self._tmp.name))

    def _upload(self, data: bytes, name="plugin.tar.gz"):
        return self.client.post(
            UPLOAD_URL,
            {"archive": SimpleUploadedFile(name, data, "application/gzip")},
            format="multipart",
        )

    def test_requires_superuser(self):
        self.client.force_login(self.plain)
        with self._override():
            self.assertEqual(self._upload(_plugin_tar()).status_code, 403)

    def test_upload_installs_and_records_manifest(self):
        from pathlib import Path

        from plugins.install import uploaded_names

        self.client.force_login(self.superuser)
        with self._override():
            r = self._upload(_plugin_tar())
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(r.json()["installed"], "danbyte_uptest")
            # Extracted onto disk + recorded so the next boot loads it.
            self.assertTrue((Path(self._tmp.name) / "danbyte_uptest" / "apps.py").is_file())
            self.assertIn("danbyte_uptest", uploaded_names())

    def test_rejects_archive_without_a_plugin(self):
        self.client.force_login(self.superuser)
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            d = b"x"
            info = tarfile.TarInfo("readme.txt")
            info.size = len(d)
            tf.addfile(info, io.BytesIO(d))
        with self._override():
            r = self._upload(buf.getvalue())
        self.assertEqual(r.status_code, 400)

    def test_rejects_path_traversal(self):
        self.client.force_login(self.superuser)
        with self._override():
            r = self._upload(_traversal_tar())
        self.assertEqual(r.status_code, 400)

    def test_rejects_unsupported_type(self):
        self.client.force_login(self.superuser)
        with self._override():
            r = self._upload(b"not an archive", name="plugin.rar")
        self.assertEqual(r.status_code, 400)

    def test_uninstall(self):
        from plugins.install import uploaded_names

        self.client.force_login(self.superuser)
        with self._override():
            self._upload(_plugin_tar())
            self.assertIn("danbyte_uptest", uploaded_names())
            r = self.client.delete("/api/plugins/danbyte_uptest/uploaded/")
            self.assertEqual(r.status_code, 200, r.content)
            self.assertNotIn("danbyte_uptest", uploaded_names())

    def test_uninstall_unknown_is_404(self):
        self.client.force_login(self.superuser)
        with self._override():
            self.assertEqual(
                self.client.delete("/api/plugins/nope/uploaded/").status_code, 404
            )
