"""Rack and cabinet PDFs (#248, #277): ``POST /api/{racks|cabinets}/{id}/
export/pdf/`` - who may call it, the title block the server writes from the
object, the sanitizer, the paper, the print links and a real render - and
the topology's sheet, which the shared renderer (``api/drawing_pdf.py``)
must leave as it was."""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import zlib
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APITestCase

from api import drawing_pdf
from api import elevation_pdf as ep
from api import topology_export as tx
from api.models import (
    Cabinet,
    CabinetType,
    Device,
    DeviceType,
    Location,
    Manufacturer,
    Rack,
    RackType,
    Site,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

User = get_user_model()

LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}

DRAWING = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800" '
    'viewBox="0 0 400 800" role="img" font-family="Inter, sans-serif">'
    '<rect x="10" y="10" width="300" height="54" fill="#2563eb" stroke="#e4e4e7"/>'
    '<text x="18" y="41" font-size="12" font-weight="500" fill="#ffffff">sw-01</text>'
    "</svg>"
)


def _pdf_objects(pdf: bytes) -> bytes:
    """The PDF's streams inflated: WeasyPrint packs its dictionaries into
    compressed object streams."""
    out = [pdf]
    for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", pdf, re.S):
        try:
            out.append(zlib.decompress(m.group(1)))
        except zlib.error:
            pass
    return b"".join(out)


def _page_mm(pdf: bytes) -> tuple[float, float]:
    boxes = re.findall(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]", _pdf_objects(pdf))
    assert len(boxes) == 1, boxes
    w, h = (float(v) for v in boxes[0])
    return round(w / 72 * 25.4), round(h / 72 * 25.4)


@override_settings(CACHES=LOCMEM)
class _Base(APITestCase):
    fake = mock.patch.object(ep, "render_with_deadline", return_value=b"%PDF-1.7 fake")

    def setUp(self):
        cache.clear()
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Globex", slug="globex")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(self.admin)

        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.site2 = Site.objects.create(tenant=self.tenant, name="CPH")
        hall = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall A", slug="hall-a"
        )
        apc = Manufacturer.objects.create(tenant=self.tenant, name="APC", slug="apc")
        rittal = Manufacturer.objects.create(tenant=self.tenant, name="Rittal", slug="rittal")
        self.rack = Rack.objects.create(
            tenant=self.tenant,
            site=self.site,
            location=hall,
            name="R01",
            rack_type=RackType.objects.create(
                tenant=self.tenant, manufacturer=apc, name="NetShelter SX"
            ),
        )
        server = DeviceType.objects.create(tenant=self.tenant, name="2U server", u_height=2)
        Device.objects.create(
            tenant=self.tenant,
            name="srv-01",
            site=self.site,
            device_type=server,
            rack=self.rack,
            position=10,
            face="front",
        )
        self.rack2 = Rack.objects.create(tenant=self.tenant, site=self.site2, name="R02")
        self.cabinet = Cabinet.objects.create(
            tenant=self.tenant,
            site=self.site,
            location=hall,
            name="K1",
            inner_width_mm=500,
            inner_height_mm=600,
            cabinet_type=CabinetType.objects.create(
                tenant=self.tenant,
                manufacturer=rittal,
                name="AE 1060",
                inner_width_mm=500,
                inner_height_mm=600,
            ),
        )
        theirs = Site.objects.create(tenant=self.other, name="Theirs")
        self.their_rack = Rack.objects.create(tenant=self.other, site=theirs, name="T01")
        self.their_cabinet = Cabinet.objects.create(
            tenant=self.other, site=theirs, name="TK1", inner_width_mm=300, inner_height_mm=400
        )

    def _login(self, user, tenant=None):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str((tenant or self.tenant).id)
        session.save()

    def _member(self, name, *types, site=None):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        if types:
            perm = ObjectPermission.objects.create(
                name=f"{name}-perm", object_types=list(types), actions=["view"]
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            if site:
                perm.sites.add(site)
        return user

    def _post(self, obj, body=None, query=""):
        kind = "racks" if isinstance(obj, Rack) else "cabinets"
        payload = {"svg": DRAWING, **(body or {})}
        return self.client.post(f"/api/{kind}/{obj.pk}/export/pdf/{query}", payload, format="json")


class RackPdfTests(_Base):
    def test_anonymous_refused(self):
        self.client.logout()
        self.assertIn(self._post(self.rack).status_code, (401, 403))

    def test_another_tenants_rack_is_not_found(self):
        with self.fake as render:
            r = self._post(self.their_rack)
        self.assertEqual(r.status_code, 404, r.content)
        render.assert_not_called()

    def test_rack_view_required(self):
        self._login(self._member("sites-only", "site", "device"))
        with self.fake as render:
            r = self._post(self.rack)
        self.assertEqual(r.status_code, 403, r.content)
        render.assert_not_called()

    def test_view_is_enough(self):
        self._login(self._member("viewer", "rack"))
        with self.fake:
            r = self._post(self.rack)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.content, b"%PDF-1.7 fake")

    def test_a_rack_outside_the_callers_sites_is_not_found(self):
        self._login(self._member("cph", "rack", site=self.site2))
        with self.fake:
            self.assertEqual(self._post(self.rack).status_code, 404)
            self.assertEqual(self._post(self.rack2).status_code, 200)

    def test_the_title_block_comes_from_the_rack(self):
        with self.fake as render:
            r = self._post(
                self.rack,
                {
                    "title": "Forged",
                    "subtitle": "Forged",
                    "meta": {"view": "Forged", "generated_at": "1999-12-31T23:59:00Z"},
                },
            )
        self.assertEqual(r.status_code, 200, r.content)
        kw = render.call_args.kwargs
        self.assertEqual(kw["title"], "R01")
        self.assertEqual(kw["subtitle"], "AMS · Hall A · APC NetShelter SX · 2 U used · 40 U free")
        self.assertTrue(kw["title_block"])
        # A rack is tall: A4 portrait unless the request says otherwise.
        self.assertEqual((kw["paper"], kw["orientation"]), ("a4", "portrait"))
        from django.utils import timezone

        self.assertLess(abs((timezone.now() - kw["generated"]).total_seconds()), 60)
        self.assertRegex(
            r["Content-Disposition"],
            r'^attachment; filename="r01-elevation-\d{4}-\d{2}-\d{2}\.pdf"$',
        )
        self.assertEqual(r["Cache-Control"], "private, no-store")

    def test_a_rack_without_location_or_type(self):
        with self.fake as render:
            self._post(self.rack2)
        self.assertEqual(render.call_args.kwargs["subtitle"], "CPH · 0 U used · 42 U free")

    def test_the_paper(self):
        with self.fake as render:
            r = self._post(self.rack, {"paper": {"size": "a3", "orientation": "landscape"}})
            self.assertEqual(r.status_code, 200)
            kw = render.call_args.kwargs
            self.assertEqual((kw["paper"], kw["orientation"]), ("a3", "landscape"))
            self._post(self.rack, {"paper": {"size": "letter"}, "title_block": False})
            kw = render.call_args.kwargs
            self.assertEqual((kw["paper"], kw["orientation"]), ("letter", "portrait"))
            self.assertFalse(kw["title_block"])
            for paper in ({"size": "a0"}, {"orientation": "sideways"}):
                with self.subTest(paper=paper):
                    self.assertEqual(self._post(self.rack, {"paper": paper}).status_code, 400)

    def test_the_sanitizer_is_applied(self):
        hostile = DRAWING.replace(
            "<rect ",
            '<script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/'
            'xhtml">x</div></foreignObject><image href="https://example.com/a.png" '
            'width="5" height="5"/><rect onload="alert(2)" style="fill:red" ',
        )
        with self.fake as render:
            r = self._post(self.rack, {"svg": hostile})
        self.assertEqual(r.status_code, 200, r.content)
        svg = render.call_args.args[0]
        self.assertIsInstance(svg, bytes)
        for gone in (b"script", b"alert", b"foreignObject", b"example.com", b"style="):
            self.assertNotIn(gone, svg)
        self.assertIn(b"sw-01", svg)
        with self.fake as render:
            for bad in ("<!DOCTYPE svg><svg/>", "<html/>", "not xml", ""):
                with self.subTest(bad=bad[:12]):
                    self.assertEqual(self._post(self.rack, {"svg": bad}).status_code, 400)
        render.assert_not_called()

    def test_caps(self):
        with self.fake, mock.patch.object(ep, "MAX_BODY_BYTES", 100):
            self.assertEqual(self._post(self.rack).status_code, 413)
        with mock.patch.object(ep, "render_with_deadline", side_effect=drawing_pdf.RenderTimeout):
            r = self._post(self.rack)
        self.assertEqual(r.status_code, 413)
        self.assertIn("too long", r.json()["detail"])
        self.assertIsNone(cache.get(f"topology-pdf-busy:{self.admin.pk}"))

    def test_one_render_at_a_time_with_every_other_drawing(self):
        # The user's lock and the deployment's slots are the topology's.
        cache.add(f"topology-pdf-busy:{self.admin.pk}", 1, 60)
        with self.fake as render:
            self.assertEqual(self._post(self.rack).status_code, 429)
        cache.clear()
        for i in range(drawing_pdf.RENDER_SLOTS):
            cache.add(f"topology-pdf-slot:{i}", "someone", 60)
        with self.fake as render:
            r = self._post(self.cabinet)
        self.assertEqual(r.status_code, 429)
        self.assertIn("Other PDFs", r.json()["detail"])
        render.assert_not_called()
        self.assertIsNone(cache.get(f"topology-pdf-busy:{self.admin.pk}"))

    def test_print_link_is_for_the_same_user_tenant_and_rack(self):
        with self.fake:
            r = self._post(self.rack, query="?print=1")
        self.assertEqual(r.status_code, 200, r.content)
        link = r.json()["url"]
        self.assertRegex(link, rf"^/api/racks/{self.rack.pk}/export/pdf/[A-Za-z0-9_-]{{24,64}}/$")

        got = self.client.get(link)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.content, b"%PDF-1.7 fake")
        self.assertRegex(
            got["Content-Disposition"], r'^inline; filename="r01-elevation-[\d-]+\.pdf"$'
        )
        self.assertEqual(got["Cache-Control"], "private, no-store")
        self.assertEqual(got["X-Content-Type-Options"], "nosniff")
        got = self.client.get(link + "?download=1")
        self.assertTrue(got["Content-Disposition"].startswith("attachment; "))

        # The token under another rack's URL.
        token = link.rstrip("/").rsplit("/", 1)[1]
        other = f"/api/racks/{self.rack2.pk}/export/pdf/{token}/"
        self.assertEqual(self.client.get(other).status_code, 404)
        # Another member of the tenant who may view the rack: not theirs.
        self._login(self._member("peer", "rack"))
        self.assertEqual(self.client.get(link).status_code, 404)
        # Someone who may not view racks at all.
        self._login(self._member("nosy", "site"))
        self.assertEqual(self.client.get(link).status_code, 403)
        # The same user in another tenant: the rack is not there.
        self._login(self.admin, self.other)
        self.assertEqual(self.client.get(link).status_code, 404)
        self._login(self.admin)
        self.assertEqual(self.client.get(link).status_code, 200)
        self.client.logout()
        self.assertIn(self.client.get(link).status_code, (401, 403))

    def test_a_new_print_link_replaces_the_last_of_its_kind(self):
        with self.fake, mock.patch.object(tx, "render_with_deadline", return_value=b"%PDF-1.7"):
            first = self._post(self.rack, query="?print=1").json()["url"]
            topology = self.client.post(
                "/api/topology/export/pdf/?print=1", {"svg": DRAWING}, format="json"
            )
        self.assertEqual(topology.status_code, 200, topology.content)
        # The topology keeps its own link; the rack's still works.
        self.assertEqual(self.client.get(first).status_code, 200)
        with self.fake:
            second = self._post(self.rack2, query="?print=1").json()["url"]
        self.assertEqual(self.client.get(first).status_code, 404)
        self.assertEqual(self.client.get(second).status_code, 200)

    def test_unknown_or_malformed_tokens(self):
        base = f"/api/racks/{self.rack.pk}/export/pdf/"
        for token in ("x" * 40, "short", "a" * 30 + "%2e%2e"):
            with self.subTest(token=token):
                self.assertEqual(self.client.get(f"{base}{token}/").status_code, 404)

    def test_a_real_render(self):
        r = self._post(self.rack)
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertEqual(r["Content-Type"], "application/pdf")
        pdf = r.content
        self.assertTrue(pdf.startswith(b"%PDF-"))
        objects = _pdf_objects(pdf)
        self.assertIn(b"/Title (R01)", objects)
        self.assertEqual(_page_mm(pdf), (210, 297))
        self.assertIn(b"Inter", objects)


class CabinetPdfTests(_Base):
    def test_another_tenants_cabinet_is_not_found(self):
        with self.fake:
            self.assertEqual(self._post(self.their_cabinet).status_code, 404)

    def test_cabinet_view_required(self):
        self._login(self._member("racks-only", "rack", "device"))
        with self.fake as render:
            self.assertEqual(self._post(self.cabinet).status_code, 403)
        render.assert_not_called()
        self._login(self._member("viewer", "cabinet"))
        with self.fake:
            self.assertEqual(self._post(self.cabinet).status_code, 200)

    def test_the_title_block_comes_from_the_cabinet(self):
        with self.fake as render:
            r = self._post(self.cabinet, {"title": "Forged"})
        self.assertEqual(r.status_code, 200, r.content)
        kw = render.call_args.kwargs
        self.assertEqual(kw["title"], "K1")
        self.assertEqual(kw["subtitle"], "AMS · Hall A · Rittal AE 1060 · Plate 500 × 600 mm")
        # A cabinet: A4 landscape unless the request says otherwise.
        self.assertEqual((kw["paper"], kw["orientation"]), ("a4", "landscape"))
        self.assertRegex(
            r["Content-Disposition"], r'^attachment; filename="k1-plate-\d{4}-\d{2}-\d{2}\.pdf"$'
        )

    def test_print_link(self):
        with self.fake:
            link = self._post(self.cabinet, query="?print=1").json()["url"]
        self.assertRegex(link, rf"^/api/cabinets/{self.cabinet.pk}/export/pdf/[A-Za-z0-9_-]+/$")
        self.assertEqual(self.client.get(link).status_code, 200)
        # A rack's URL with the cabinet's token.
        token = link.rstrip("/").rsplit("/", 1)[1]
        self.assertEqual(
            self.client.get(f"/api/racks/{self.rack.pk}/export/pdf/{token}/").status_code, 404
        )

    def test_print_links_without_a_cache(self):
        with self.fake, mock.patch.object(drawing_pdf.cache, "set", side_effect=ConnectionError):
            self.assertEqual(self._post(self.cabinet, query="?print=1").status_code, 503)
        with self.fake:
            link = self._post(self.cabinet, query="?print=1").json()["url"]
        with mock.patch.object(drawing_pdf.cache, "get", side_effect=ConnectionError):
            self.assertEqual(self.client.get(link).status_code, 503)

    def test_a_real_render(self):
        r = self._post(self.cabinet, {"paper": {"size": "a3"}})
        self.assertEqual(r.status_code, 200, r.content[:300])
        objects = _pdf_objects(r.content)
        self.assertIn(b"/Title (K1)", objects)
        self.assertEqual(_page_mm(r.content), (420, 297))


class SheetTests(SimpleTestCase):
    """The shared sheet: the topology's exactly as it was, and the title
    block's text escaped."""

    WHEN = dt.datetime(2026, 9, 26, 12, 0, tzinfo=dt.UTC)

    def _pinned(self, html: str) -> str:
        from danbyte import __version__

        norm = html.replace(drawing_pdf.FONT_DIR.resolve().as_uri(), "FONTS")
        return hashlib.sha256(norm.replace(__version__, "VERSION").encode()).hexdigest()

    def test_the_topology_sheet_is_as_it_was(self):
        # Hashes of the page the topology drew before the renderer was shared.
        html = tx._sheet_html(
            tx.plan_sheet(640, 480, "a3", "landscape"),
            title="DC1 <fabric>",
            tenant="Acme & Co",
            filters="Site: DC1",
            generated=self.WHEN,
            title_block=True,
        )
        self.assertEqual(
            self._pinned(html), "1753dd55698b2b4c6a33742d5dacff403de361f2cfb67ec483d7447ce93b57a5"
        )
        html = tx._sheet_html(
            tx.plan_sheet(300, 900, "a4", "portrait", title_block=False),
            title="x",
            tenant="",
            filters="",
            generated=self.WHEN,
            title_block=False,
        )
        self.assertEqual(
            self._pinned(html), "7eac1164f9833b2f27ad18e7c13c240989f84698e55a1b61e85467d6ba321397"
        )

    def test_a_subtitle_is_escaped(self):
        html = drawing_pdf.sheet_html(
            drawing_pdf.plan_sheet(400, 800, "a4", "portrait"),
            title="R<1>",
            subtitle="AMS & Co · Hall A",
            generated=self.WHEN,
            title_block=True,
        )
        self.assertIn('<div class="t">R&lt;1&gt;</div>', html)
        self.assertIn('<div class="s">AMS &amp; Co · Hall A</div>', html)
        self.assertIn("2026-09-26 12:00 UTC", html)

    def test_file_names(self):
        self.assertEqual(
            drawing_pdf.file_name("København R1 elevation", self.WHEN, "rack"),
            "kobenhavn-r1-elevation-2026-09-26.pdf",
        )
        self.assertEqual(drawing_pdf.file_name("···", self.WHEN, "rack"), "rack-2026-09-26.pdf")
