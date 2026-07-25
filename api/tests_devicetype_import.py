"""Import from the NetBox devicetype-library (YAML → DeviceType + templates)."""
from __future__ import annotations

import tempfile

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from .devicetype_import import (
    elevation_image_base,
    expand_github_dir,
    is_github_dir,
    positionize,
    to_raw_url,
)
from .models import DeviceType

User = get_user_model()

# Trimmed but structurally faithful devicetype-library file (Cisco C9300-48P).
SAMPLE_YAML = """\
manufacturer: Cisco
model: Catalyst 9300-48P
slug: cisco-c9300-48p
part_number: C9300-48P
u_height: 1
is_full_depth: true
airflow: front-to-rear
console-ports:
  - name: con0
    type: rj-45
  - name: usb
    type: usb-mini-b
power-ports:
  - name: PS1
    type: iec-60320-c16
    maximum_draw: 715
  - name: PS2
    type: iec-60320-c16
    maximum_draw: 715
interfaces:
  - name: GigabitEthernet0/0
    type: 1000base-t
    mgmt_only: true
  - name: GigabitEthernet1/0/1
    type: 1000base-t
  - name: GigabitEthernet1/0/2
    type: 1000base-t
  - name: TenGigabitEthernet1/1/1
    type: 10gbase-x-sfpp
module-bays:
  - name: Network Module
    position: '1'
"""

PANEL_YAML = """\
manufacturer: Generic
model: 24-port LC panel
u_height: 1
rear-ports:
  - name: R1
    type: lc
    positions: 2
front-ports:
  - name: F1
    type: lc
    rear_port: R1
    rear_port_position: 1
  - name: F2
    type: lc
    rear_port: R1
    rear_port_position: 2
"""


class HelperTests(APITestCase):
    def test_positionize(self):
        self.assertEqual(
            positionize("GigabitEthernet1/0/1"),
            "GigabitEthernet{position}/0/1",
        )
        self.assertEqual(positionize("xe-0/0/0"), "xe-{position:0}/0/0")
        # No leading slot segment → untouched.
        self.assertEqual(positionize("con0"), "con0")
        self.assertEqual(positionize("Ethernet48"), "Ethernet48")

    def test_to_raw_url(self):
        self.assertEqual(
            to_raw_url(
                "https://github.com/netbox-community/devicetype-library/"
                "blob/master/device-types/Cisco/C9300-48P.yaml"
            ),
            "https://raw.githubusercontent.com/netbox-community/"
            "devicetype-library/master/device-types/Cisco/C9300-48P.yaml",
        )
        # Raw / non-github URLs pass through.
        self.assertEqual(to_raw_url("https://example.com/x.yaml"),
                         "https://example.com/x.yaml")

    def test_elevation_image_base(self):
        raw = "https://raw.githubusercontent.com"
        # Plain owner/name shorthand → default branch via HEAD.
        self.assertEqual(
            elevation_image_base("danbyte-net/device-library"),
            f"{raw}/danbyte-net/device-library/HEAD/elevation-images",
        )
        # Repo page URL (trailing slash tolerated).
        self.assertEqual(
            elevation_image_base("https://github.com/danbyte-net/device-library/"),
            f"{raw}/danbyte-net/device-library/HEAD/elevation-images",
        )
        # /tree/<ref> pins the ref; an explicit elevation-images path is kept.
        self.assertEqual(
            elevation_image_base(
                "https://github.com/netbox-community/devicetype-library/tree/master"
            ),
            f"{raw}/netbox-community/devicetype-library/master/elevation-images",
        )
        self.assertEqual(
            elevation_image_base("https://github.com/o/r/tree/main/elevation-images"),
            f"{raw}/o/r/main/elevation-images",
        )
        # A full raw base passes through; a bare base gains the folder.
        self.assertEqual(
            elevation_image_base(f"{raw}/o/r/master/elevation-images"),
            f"{raw}/o/r/master/elevation-images",
        )
        self.assertEqual(
            elevation_image_base("https://mirror.example/devicetype-library"),
            "https://mirror.example/devicetype-library/elevation-images",
        )
        # https only; garbage is refused with a readable message.
        with self.assertRaises(ValueError):
            elevation_image_base("http://github.com/o/r")
        with self.assertRaises(ValueError):
            elevation_image_base("not a repo")
        with self.assertRaises(ValueError):
            elevation_image_base("")

    def test_is_github_dir(self):
        base = "https://github.com/netbox-community/devicetype-library"
        self.assertTrue(is_github_dir(f"{base}/tree/master/device-types"))
        self.assertTrue(is_github_dir(f"{base}/tree/master/device-types/Cisco"))
        self.assertTrue(is_github_dir(f"{base}/tree/master"))
        # /blob/ pointing at a folder (no extension) is still a folder — people
        # paste either form from the address bar.
        self.assertTrue(is_github_dir(f"{base}/blob/master/device-types/Cisco"))
        # /blob/ pointing at a file is NOT a folder.
        self.assertFalse(is_github_dir(f"{base}/blob/master/x.yaml"))
        self.assertFalse(
            is_github_dir(f"{base}/tree/master/device-types/Cisco/C9300.yaml")
        )
        self.assertFalse(is_github_dir("https://example.com/dir/"))

    def test_expand_github_dir(self):
        # A fake SSRF-guarded fetcher returning the trees API payload.
        class FakeResp:
            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "truncated": False,
                    "tree": [
                        {"type": "tree", "path": "device-types"},
                        {"type": "blob", "path": "device-types/Cisco/A.yaml"},
                        {"type": "blob", "path": "device-types/Cisco/B.yml"},
                        {"type": "blob", "path": "device-types/Cisco/logo.png"},
                        {"type": "blob", "path": "device-types/Arista/C.yaml"},
                        {"type": "blob", "path": "README.md"},
                    ],
                }

        calls = {}

        def fake_get(url, timeout=30):
            calls["url"] = url
            return FakeResp()

        base = "https://github.com/netbox-community/devicetype-library"
        raw = "https://raw.githubusercontent.com/netbox-community/devicetype-library/master/"
        # A vendor sub-folder → only that vendor's YAML (png filtered out).
        got = expand_github_dir(f"{base}/tree/master/device-types/Cisco", fake_get)
        self.assertEqual(got, [raw + "device-types/Cisco/A.yaml",
                               raw + "device-types/Cisco/B.yml"])
        self.assertIn("git/trees/master?recursive=1", calls["url"])
        # The whole device-types dir → every vendor's YAML.
        allf = expand_github_dir(f"{base}/tree/master/device-types", fake_get)
        self.assertEqual(len(allf), 3)
        self.assertNotIn(raw + "README.md", allf)


class ImportEndpointTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _import(self, items, stack=False):
        return self.client.post(
            "/api/device-types/import-yaml/",
            {"items": items, "stack_positions": stack},
            format="json",
        )

    def test_import_yaml_rejects_html_response(self):
        # A github folder (tree) URL fetched raw would return HTML; guard it.
        from unittest import mock

        class HtmlResp:
            text = "<!DOCTYPE html><html>oops</html>"

            def raise_for_status(self):
                pass

        with mock.patch("core.ssrf.safe_get", return_value=HtmlResp()):
            resp = self._import(["https://example.com/page"])
        self.assertEqual(resp.status_code, 200, resp.content)
        r = resp.json()["results"][0]
        self.assertFalse(r["ok"])
        self.assertIn("HTML page", r["error"])



    def test_imports_full_type(self):
        resp = self._import([SAMPLE_YAML])
        self.assertEqual(resp.status_code, 200, resp.content)
        r = resp.json()["results"][0]
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["name"], "Catalyst 9300-48P")
        self.assertEqual(r["created"]["interfaces"], 4)
        self.assertEqual(r["created"]["console_ports"], 2)
        self.assertEqual(r["created"]["power_ports"], 2)
        # module-bays import as bay templates now (was a skip note pre-M1).
        self.assertEqual(r["created"]["module_bays"], 1)

        dt = DeviceType.objects.get(tenant=self.tenant, name="Catalyst 9300-48P")
        self.assertEqual(dt.manufacturer.name, "Cisco")
        self.assertEqual(dt.part_number, "C9300-48P")
        self.assertEqual(dt.u_height, 1)
        # Hardware attributes now map instead of being skipped.
        self.assertTrue(dt.is_full_depth)
        self.assertEqual(dt.airflow, "front-to-rear")
        names = set(dt.interface_templates.values_list("name", flat=True))
        self.assertIn("GigabitEthernet1/0/1", names)
        mgmt = dt.interface_templates.get(name="GigabitEthernet0/0")
        self.assertTrue(mgmt.mgmt_only)

    def test_weight_and_elevation_images(self):
        from unittest.mock import patch

        yaml_doc = SAMPLE_YAML + (
            "slug: cisco-c9300-48p2\nweight: 7.7\nweight_unit: kg\n"
            "front_image: true\n"
        ).replace("slug: cisco-c9300-48p2", "")  # slug already in SAMPLE_YAML
        fake = type("R", (), {"status_code": 200, "content": b"\\x89PNG fake"})()
        with patch("requests.get", return_value=fake):
            resp = self._import([yaml_doc])
        r = resp.json()["results"][0]
        self.assertTrue(r["ok"], r)
        dt = DeviceType.objects.get(tenant=self.tenant, name="Catalyst 9300-48P")
        self.assertEqual(str(dt.weight), "7.70")  # DecimalField(dp=2)
        self.assertEqual(dt.weight_unit, "kg")
        self.assertTrue(dt.front_image)  # downloaded via the mocked fetch
        self.assertTrue(any("front_image: downloaded" in s for s in r["skipped"]))

    def test_stack_positions_rewrite(self):
        resp = self._import([SAMPLE_YAML], stack=True)
        r = resp.json()["results"][0]
        self.assertTrue(r["ok"], r)
        dt = DeviceType.objects.get(tenant=self.tenant, name="Catalyst 9300-48P")
        names = set(dt.interface_templates.values_list("name", flat=True))
        self.assertIn("GigabitEthernet{position}/0/1", names)
        self.assertIn("TenGigabitEthernet{position}/1/1", names)
        # Mgmt 0/0 becomes the Juniper-style zero-based token.
        self.assertIn("GigabitEthernet{position:0}/0", names)
        # Console con0 has no slot segment — untouched.
        self.assertEqual(dt.console_port_templates.filter(name="con0").count(), 1)

    def test_front_rear_port_mapping(self):
        resp = self._import([PANEL_YAML])
        r = resp.json()["results"][0]
        self.assertTrue(r["ok"], r)
        dt = DeviceType.objects.get(tenant=self.tenant, name="24-port LC panel")
        f2 = dt.front_port_templates.get(name="F2")
        self.assertEqual(f2.rear_port_template.name, "R1")
        self.assertEqual(f2.rear_port_position, 2)

    def test_duplicate_reports_error_and_batch_continues(self):
        self._import([SAMPLE_YAML])
        resp = self._import([SAMPLE_YAML, PANEL_YAML])
        results = resp.json()["results"]
        self.assertFalse(results[0]["ok"])
        self.assertIn("already exists", results[0]["error"])
        self.assertTrue(results[1]["ok"])

    def test_garbage_yaml_reports_error(self):
        resp = self._import(["{{{ not yaml"])
        r = resp.json()["results"][0]
        self.assertFalse(r["ok"])

    def test_empty_items_rejected(self):
        self.assertEqual(self._import([]).status_code, 400)



class BackgroundImportTests(APITestCase):
    DIR = ("https://github.com/netbox-community/devicetype-library/"
           "tree/master/device-types/Cisco")

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=self.org, name="Other", slug="oth")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_start_enqueues_and_returns_run(self):
        from unittest import mock

        with mock.patch("django_rq.get_queue") as gq:
            resp = self.client.post(
                "/api/device-types/import-folder/",
                {"url": self.DIR}, format="json",
            )
            gq.return_value.enqueue.assert_called_once()
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["status"], "queued")
        self.assertTrue(body["id"])

    def test_start_rejects_non_folder_url(self):
        resp = self.client.post(
            "/api/device-types/import-folder/",
            {"url": "https://github.com/x/y/blob/master/a.yaml"},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_poll_and_tenant_isolation(self):
        from .models import DeviceTypeImportRun

        run = DeviceTypeImportRun.objects.create(
            tenant=self.tenant, source_url=self.DIR, status="running",
            progress={"done": 3, "total": 10, "created": 3, "failed": 0},
        )
        resp = self.client.get(f"/api/device-types/import-runs/{run.id}/")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["progress"]["total"], 10)
        # A run in another tenant is invisible.
        hidden = DeviceTypeImportRun.objects.create(
            tenant=self.other, source_url=self.DIR, status="queued"
        )
        self.assertEqual(
            self.client.get(
                f"/api/device-types/import-runs/{hidden.id}/"
            ).status_code,
            404,
        )

    def test_task_imports_each_file_and_records_progress(self):
        from unittest import mock

        from .devicetype_import_tasks import run_devicetype_import
        from .models import DeviceTypeImportRun

        run = DeviceTypeImportRun.objects.create(
            tenant=self.tenant, source_url=self.DIR, status="queued"
        )

        class Resp:
            text = "manufacturer: Cisco\nmodel: X\nu_height: 1\n"

            def raise_for_status(self):
                pass

        with mock.patch(
            "api.devicetype_import.expand_github_dir",
            return_value=["u1", "u2", "u3"],
        ), mock.patch("core.ssrf.safe_get", return_value=Resp()), mock.patch(
            "api.devicetype_import.import_yaml_auto",
            side_effect=[
                {"ok": True, "name": "a"},
                {"ok": False, "name": "b", "error": "duplicate"},
                {"ok": True, "name": "c"},
            ],
        ):
            run_devicetype_import(str(run.id))

        run.refresh_from_db()
        self.assertEqual(run.status, "success")
        self.assertEqual(run.progress["total"], 3)
        self.assertEqual(run.progress["created"], 2)
        self.assertEqual(run.progress["failed"], 1)
        self.assertEqual(run.failures[0]["error"], "duplicate")
        self.assertIsNotNone(run.finished_at)

    def test_task_records_failure_when_listing_blows_up(self):
        from unittest import mock

        from .devicetype_import_tasks import run_devicetype_import
        from .models import DeviceTypeImportRun

        run = DeviceTypeImportRun.objects.create(
            tenant=self.tenant, source_url=self.DIR, status="queued"
        )
        with mock.patch(
            "api.devicetype_import.expand_github_dir",
            side_effect=ValueError("truncated tree"),
        ):
            run_devicetype_import(str(run.id))
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIn("truncated", run.error)


# ─── Reimporting images for existing types ──────────────────────────────────

class _Resp:
    def __init__(self, status_code: int, content: bytes = b""):
        self.status_code = status_code
        self.content = content


class FakeRepo:
    """In-memory raw.githubusercontent.com: ``{"Cisco/slug.front.png": b"…"}``.
    Lookup keys on the URL's trailing ``<Manufacturer>/<file>`` segments, so
    any normalised base works. Stands in for BOTH ``safe_request`` (HEAD
    probes) and ``safe_get`` (downloads) — tests never touch the network."""

    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.calls: list[str] = []

    def _body(self, url: str) -> bytes | None:
        from urllib.parse import unquote

        self.calls.append(url)
        return self.files.get(unquote("/".join(url.split("/")[-2:])))

    def request(self, method: str, url: str, **kw) -> _Resp:  # safe_request
        body = self._body(url)
        return _Resp(404) if body is None else _Resp(200)

    def get(self, url: str, **kw) -> _Resp:  # safe_get
        body = self._body(url)
        return _Resp(404) if body is None else _Resp(200, body)


@override_settings(MEDIA_ROOT=tempfile.mkdtemp(prefix="danbyte-test-media-"))
class ReimportImagesTests(APITestCase):
    """The media-loss recovery flow: match EXISTING types against a
    library-layout repo and re-download only the elevation images."""

    URL = "/api/device-types/reimport-images/"

    def setUp(self):
        from .models import Manufacturer

        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=self.org, name="Other", slug="oth")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.cisco = Manufacturer.objects.create(
            tenant=self.tenant, name="Cisco", slug="cisco"
        )

    def _repo(self, *slugs: str, faces=("front", "rear")) -> FakeRepo:
        return FakeRepo({
            f"Cisco/{slug}.{face}.png": f"PNG:{slug}.{face}".encode()
            for slug in slugs
            for face in faces
        })

    def _post(self, repo: FakeRepo, *, dry_run=False, overwrite=False, body=None):
        from unittest import mock

        payload = {"repo": "danbyte-net/device-library", **(body or {})}
        qs = []
        if dry_run:
            qs.append("dry_run=1")
        if overwrite:
            qs.append("overwrite=1")
        url = self.URL + ("?" + "&".join(qs) if qs else "")
        with mock.patch("core.ssrf.safe_request", side_effect=repo.request), \
                mock.patch("core.ssrf.safe_get", side_effect=repo.get):
            return self.client.post(url, payload, format="json")

    def _attach(self, dt, face: str, content=b"OLD"):
        from django.core.files.base import ContentFile

        field = dt.front_image if face == "front" else dt.rear_image
        field.save(f"cisco-{dt.name.lower()}.{face}.png", ContentFile(content),
                   save=True)

    def test_dry_run_classification(self):
        # A: no images, repo has it → matched. B: no images, repo doesn't →
        # no_match. C: both faces present with real files on disk → skipped.
        a = DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", manufacturer=self.cisco
        )
        b = DeviceType.objects.create(
            tenant=self.tenant, name="Unobtainium X1", manufacturer=self.cisco
        )
        c = DeviceType.objects.create(
            tenant=self.tenant, name="C9200-24T", manufacturer=self.cisco
        )
        self._attach(c, "front")
        self._attach(c, "rear")

        resp = self._post(self._repo("cisco-c9300-48p"), dry_run=True)
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertTrue(data["dry_run"])
        by_id = {r["id"]: r for r in data["results"]}
        self.assertEqual(by_id[str(a.id)]["status"], "matched")
        self.assertEqual(by_id[str(a.id)]["slug"], "cisco-c9300-48p")
        self.assertEqual(by_id[str(a.id)]["faces"]["front"], "available")
        self.assertEqual(by_id[str(b.id)]["status"], "no_match")
        self.assertEqual(by_id[str(c.id)]["status"], "skipped_has_images")
        self.assertEqual(data["totals"]["matched"], 1)
        self.assertEqual(data["totals"]["no_match"], 1)
        self.assertEqual(data["totals"]["skipped_has_images"], 1)
        # Dry run never writes.
        a.refresh_from_db()
        self.assertFalse(a.front_image)

    def test_corrupt_media_counts_as_gap(self):
        # DB says the type has a front image; the file is GONE from storage
        # (the lost-media case). It must classify as matched, not skipped —
        # and the surviving filename is itself the matching signal.
        dt = DeviceType.objects.create(
            tenant=self.tenant, name="Nexus Something Odd",
            manufacturer=self.cisco,
        )
        from django.core.files.base import ContentFile

        # Filename carries a slug the *name* would never derive.
        dt.front_image.save(
            "cisco-n9k-c93180yc-ex.front.png", ContentFile(b"x"), save=True
        )
        dt.front_image.storage.delete(dt.front_image.name)

        resp = self._post(self._repo("cisco-n9k-c93180yc-ex"), dry_run=True)
        row = resp.json()["results"][0]
        self.assertEqual(row["status"], "matched")
        self.assertEqual(row["slug"], "cisco-n9k-c93180yc-ex")
        self.assertEqual(row["faces"]["front"], "available")

    def test_apply_fills_gaps_only(self):
        dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", manufacturer=self.cisco
        )
        self._attach(dt, "front", b"OLD")  # intact on disk → kept

        resp = self._post(self._repo("cisco-c9300-48p"))
        self.assertEqual(resp.status_code, 200, resp.content)
        row = resp.json()["results"][0]
        self.assertEqual(row["status"], "matched")
        self.assertEqual(row["faces"], {"front": "kept", "rear": "downloaded"})
        self.assertEqual(row["downloaded"], 1)
        dt.refresh_from_db()
        with dt.front_image.open() as fh:
            self.assertEqual(fh.read(), b"OLD")  # untouched
        with dt.rear_image.open() as fh:
            self.assertEqual(fh.read(), b"PNG:cisco-c9300-48p.rear")

    def test_apply_overwrite_replaces_intact_images(self):
        dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", manufacturer=self.cisco
        )
        self._attach(dt, "front", b"OLD")

        resp = self._post(self._repo("cisco-c9300-48p"), overwrite=True)
        row = resp.json()["results"][0]
        self.assertEqual(row["faces"]["front"], "downloaded")
        dt.refresh_from_db()
        with dt.front_image.open() as fh:
            self.assertEqual(fh.read(), b"PNG:cisco-c9300-48p.front")

    def test_apply_writes_changelog(self):
        from audit.models import ChangeLogEntry

        dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", manufacturer=self.cisco
        )
        ChangeLogEntry.objects.all().delete()
        self._post(self._repo("cisco-c9300-48p"))
        self.assertTrue(
            ChangeLogEntry.objects.filter(
                object_type="api.devicetype", object_id=str(dt.id),
                action="update",
            ).exists()
        )

    def test_tenant_scoping_never_touches_other_tenant(self):
        from .models import Manufacturer

        theirs_mfr = Manufacturer.objects.create(
            tenant=self.other, name="Cisco", slug="cisco"
        )
        theirs = DeviceType.objects.create(
            tenant=self.other, name="C9300-48P", manufacturer=theirs_mfr
        )
        resp = self._post(self._repo("cisco-c9300-48p"))
        data = resp.json()
        self.assertNotIn(str(theirs.id), {r["id"] for r in data["results"]})
        theirs.refresh_from_db()
        self.assertFalse(theirs.front_image)
        self.assertFalse(theirs.rear_image)

    def test_airgapped_refuses_before_any_fetch(self):
        from unittest import mock

        from core.models import DeploymentSettings

        dep = DeploymentSettings.load()
        dep.disable_update_check = True
        dep.save()
        DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", manufacturer=self.cisco
        )
        with mock.patch("core.ssrf.safe_request") as req, \
                mock.patch("core.ssrf.safe_get") as get:
            resp = self.client.post(
                self.URL, {"repo": "danbyte-net/device-library"}, format="json"
            )
            req.assert_not_called()
            get.assert_not_called()
        self.assertEqual(resp.status_code, 409, resp.content)
        self.assertIn("airgapped", resp.json()["detail"])

    def test_fetch_failure_is_reported_not_500(self):
        from unittest import mock

        dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", manufacturer=self.cisco
        )
        with mock.patch(
            "core.ssrf.safe_request", side_effect=OSError("connection refused")
        ), mock.patch(
            "core.ssrf.safe_get", side_effect=OSError("connection refused")
        ):
            resp = self.client.post(
                self.URL, {"repo": "danbyte-net/device-library"}, format="json"
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        row = resp.json()["results"][0]
        self.assertEqual(row["id"], str(dt.id))
        self.assertEqual(row["status"], "fetch_failed")
        self.assertEqual(resp.json()["totals"]["fetch_failed"], 1)

    def test_bad_repo_is_a_400(self):
        resp = self.client.post(
            self.URL, {"repo": "http://github.com/o/r"}, format="json"
        )
        self.assertEqual(resp.status_code, 400)

    def test_over_cap_enqueues_background_run(self):
        from unittest import mock

        for i in range(3):
            DeviceType.objects.create(
                tenant=self.tenant, name=f"T{i}", manufacturer=self.cisco
            )
        with mock.patch("api.devicetype_import.REIMPORT_SYNC_CAP", 2), \
                mock.patch("django_rq.get_queue") as gq:
            resp = self.client.post(
                self.URL + "?overwrite=1",
                {"repo": "danbyte-net/device-library"},
                format="json",
            )
            gq.return_value.enqueue.assert_called_once()
        self.assertEqual(resp.status_code, 202, resp.content)
        run = resp.json()["run"]
        self.assertEqual(run["kind"], "image_reimport")
        self.assertEqual(run["options"], {"overwrite": True, "dry_run": False})
        self.assertIn("elevation-images", run["source_url"])

    def test_background_task_applies_and_records_totals(self):
        from unittest import mock

        from .devicetype_import_tasks import run_devicetype_image_reimport
        from .models import DeviceTypeImportRun

        DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", manufacturer=self.cisco
        )
        DeviceType.objects.create(
            tenant=self.tenant, name="Unobtainium X1", manufacturer=self.cisco
        )
        admin = User.objects.get(username="admin")
        run = DeviceTypeImportRun.objects.create(
            tenant=self.tenant, kind="image_reimport",
            source_url="https://raw.githubusercontent.com/o/r/HEAD/elevation-images",
            options={"overwrite": False, "dry_run": False},
            created_by=admin, status="queued",
        )
        repo = self._repo("cisco-c9300-48p")
        with mock.patch("core.ssrf.safe_request", side_effect=repo.request), \
                mock.patch("core.ssrf.safe_get", side_effect=repo.get):
            run_devicetype_image_reimport(str(run.id))
        run.refresh_from_db()
        self.assertEqual(run.status, "success", run.error)
        self.assertEqual(run.progress["total"], 2)
        self.assertEqual(run.progress["matched"], 1)
        self.assertEqual(run.progress["no_match"], 1)
        self.assertEqual(run.progress["images_downloaded"], 2)
        self.assertEqual(run.failures[0]["name"], "Unobtainium X1")

    def test_background_task_rechecks_airgap(self):
        from unittest import mock

        from core.models import DeploymentSettings

        from .devicetype_import_tasks import run_devicetype_image_reimport
        from .models import DeviceTypeImportRun

        admin = User.objects.get(username="admin")
        run = DeviceTypeImportRun.objects.create(
            tenant=self.tenant, kind="image_reimport",
            source_url="https://raw.githubusercontent.com/o/r/HEAD/elevation-images",
            options={}, created_by=admin, status="queued",
        )
        dep = DeploymentSettings.load()
        dep.disable_update_check = True
        dep.save()
        with mock.patch("core.ssrf.safe_request") as req:
            run_devicetype_image_reimport(str(run.id))
            req.assert_not_called()
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIn("airgapped", run.error)


class RepoInventoryTests(APITestCase):
    """The one-shot repo listing that turns catalog matching into set lookups.
    The speed contract is behavioural: with an inventory, matching makes ZERO
    per-image probe requests."""

    BASE = (
        "https://raw.githubusercontent.com/danbyte-net/device-library/"
        "HEAD/elevation-images"
    )

    @staticmethod
    def _trees_get(url: str, **kw):
        """Fake api.github.com: top tree → subtree sha; subtree → blobs."""
        import json

        if url.endswith("/git/trees/HEAD"):
            body = {"tree": [
                {"path": "elevation-images", "type": "tree", "sha": "sub123"},
                {"path": "device-types", "type": "tree", "sha": "other"},
            ]}
        elif "/git/trees/sub123" in url:
            body = {"truncated": False, "tree": [
                {"path": "Cisco/catalyst-9300-24p.front.png", "type": "blob"},
                {"path": "Cisco/catalyst-9300-24p.rear.png", "type": "blob"},
                {"path": "APC/ap8853.front.jpg", "type": "blob"},
            ]}
        else:
            return _Resp(404)
        return _Resp(200, json.dumps(body).encode())

    def test_inventory_two_calls_and_contents(self):
        from unittest import mock

        from .devicetype_import import repo_image_inventory

        with mock.patch("core.ssrf.safe_get", side_effect=self._trees_get) as g:
            inv = repo_image_inventory(self.BASE)
        self.assertEqual(g.call_count, 2)
        self.assertIn("Cisco/catalyst-9300-24p.front.png", inv)
        self.assertIn("APC/ap8853.front.jpg", inv)

    def test_non_github_base_and_truncated_fall_back_to_none(self):
        from unittest import mock

        from .devicetype_import import repo_image_inventory

        self.assertIsNone(repo_image_inventory("https://mirror.example/images"))

        def truncated(url, **kw):
            import json

            if url.endswith("/git/trees/HEAD"):
                return _Resp(200, json.dumps({"tree": [
                    {"path": "elevation-images", "type": "tree", "sha": "s"},
                ]}).encode())
            return _Resp(200, json.dumps(
                {"truncated": True, "tree": []}
            ).encode())

        with mock.patch("core.ssrf.safe_get", side_effect=truncated):
            self.assertIsNone(repo_image_inventory(self.BASE))

    def test_missing_dir_is_an_honest_empty_set(self):
        """A repo with no elevation-images dir yields set() — every type
        reports no_match immediately instead of probing for an hour."""
        import json
        from unittest import mock

        def no_dir(url, **kw):
            if url.endswith("/git/trees/HEAD"):
                return _Resp(200, json.dumps({"tree": []}).encode())
            return _Resp(404)

        from .devicetype_import import repo_image_inventory

        with mock.patch("core.ssrf.safe_get", side_effect=no_dir):
            self.assertEqual(repo_image_inventory(self.BASE), set())

    def test_matching_with_inventory_makes_zero_probe_requests(self):
        from unittest import mock

        from .devicetype_import import reimport_images_for_type
        from .models import DeviceType, Manufacturer

        org = Organization.objects.create(name="Inv", slug="inv")
        tenant = Tenant.objects.create(org=org, name="Inv", slug="inv")
        mfr = Manufacturer.objects.create(tenant=tenant, name="Cisco", slug="cisco")
        dt = DeviceType.objects.create(
            tenant=tenant, manufacturer=mfr, name="Catalyst 9300-24P",
            u_height=1,
        )
        inv = {
            "Cisco/catalyst-9300-24p.front.png",
            "Cisco/catalyst-9300-24p.rear.png",
        }
        with mock.patch(
            "core.ssrf.safe_request",
            side_effect=AssertionError("probe fired despite inventory"),
        ):
            row = reimport_images_for_type(
                dt, self.BASE, apply=False, inventory=inv
            )
        self.assertEqual(row["status"], "matched")
        self.assertEqual(row["slug"], "catalyst-9300-24p")
        self.assertEqual(
            row["faces"], {"front": "available", "rear": "available"}
        )
