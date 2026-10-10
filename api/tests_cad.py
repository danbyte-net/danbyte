"""CAD drawings under floor plans: the renderer, the DWG converter, the CAD
sanitiser profile, the plan's drawing endpoints (permissions and tenant
isolation on each), media access, clone and file cleanup."""
from __future__ import annotations

import json
import os
import shutil
import stat
import sys
import tarfile
import tempfile
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from lxml import etree
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import cad_render
from . import tests_cad_fixtures as fx
from .models import FloorPlan, FloorPlanDrawing, FloorPlanTile, Location, Site
from .svg_sanitize import (
    MAX_ELEMENTS,
    MAX_SVG_BYTES,
    MAX_TEXT_CHARS,
    SvgRejected,
    SvgTooLarge,
    sanitize_svg,
)

User = get_user_model()
MEDIA = tempfile.mkdtemp(prefix="danbyte-cad-test-")
SVG = "{http://www.w3.org/2000/svg}"


class _InlineQueue:
    """django_rq's queue, running the job at once."""

    def enqueue(self, fn, *args, **kwargs):
        fn(*args)


def _tree(data: bytes):
    return etree.fromstring(data)


def _layers(root) -> list[str]:
    return [g.get("data-layer") for g in root.iter(f"{SVG}g") if g.get("data-layer")]


@override_settings(MEDIA_ROOT=MEDIA, DANBYTE_CAD_CONVERTER="")
class _Base(APITestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=site, name="Hall A", slug="hall-a"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Ground", cell_mm=600
        )
        osite = Site.objects.create(tenant=self.other, name="LON")
        oloc = Location.objects.create(tenant=self.other, site=osite, name="B", slug="b")
        self.other_plan = FloorPlan.objects.create(
            tenant=self.other, location=oloc, name="Other"
        )
        self.admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.login(self.admin)
        self.queue = mock.patch("django_rq.get_queue", return_value=_InlineQueue())
        self.queue.start()
        self.addCleanup(self.queue.stop)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def member(self, name, *actions, tenant=None, types=("floorplan",)):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(tenant or self.tenant)
        if actions:
            p = ObjectPermission.objects.create(
                name=f"{name}-perm", object_types=list(types), actions=list(actions)
            )
            p.users.add(u)
        return u

    def url(self, plan=None, tail=""):
        return f"/api/floor-plans/{(plan or self.plan).id}/drawing/{tail}"

    def upload(self, data: bytes, name="plan.dxf", plan=None):
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(
                self.url(plan), {"file": SimpleUploadedFile(name, data)}, format="multipart"
            )

    def ready(self, data: bytes | None = None, plan=None) -> FloorPlanDrawing:
        r = self.upload(data or fx.floor_dxf(), plan=plan)
        self.assertEqual(r.status_code, 202, r.content)
        d = FloorPlanDrawing.objects.get(floor_plan=plan or self.plan)
        self.assertEqual(d.status, "ready", d.error)
        return d

    def svg(self, d: FloorPlanDrawing) -> bytes:
        with d.rendered.open("rb") as fh:
            return fh.read()


# ─── the renderer ───────────────────────────────────────────────────────────


class RenderTests(_Base):
    def test_a_floor_plan_renders_one_group_per_layer(self):
        d = self.ready()
        self.assertEqual(d.units, "mm")
        self.assertEqual(d.units_mm_per_unit, 1.0)
        self.assertEqual(d.scale_source, "units")
        names = [row["name"] for row in d.layers]
        for layer in ("WALLS", "DOORS", "FURNITURE", "HATCH", "TEXT", "DIMS",
                      "GRID-OFF", "FROZEN"):
            self.assertIn(layer, names)
        root = _tree(self.svg(d))
        self.assertEqual(sorted(_layers(root)), sorted(names))
        # Each layer is one group, its parts under data-kind groups.
        kinds = {g.get("data-kind") for g in root.iter(f"{SVG}g") if g.get("data-kind")}
        self.assertEqual(kinds, {"hatch", "dimension", "text"})
        self.assertEqual(d.rendered_bytes, len(self.svg(d)))
        self.assertGreater(d.rendered_elements, 10)

    def test_the_view_box_is_the_extents_in_drawing_units_y_down(self):
        d = self.ready()
        root = _tree(self.svg(d))
        ext = d.extents
        w = ext["max_x"] - ext["min_x"]
        h = ext["max_y"] - ext["min_y"]
        vb = [float(v) for v in root.get("viewBox").split()]
        self.assertEqual(vb[:2], [0, 0])
        self.assertAlmostEqual(vb[2], w, places=1)
        self.assertAlmostEqual(vb[3], h, places=1)
        # The room's walls span 10 m in x.
        self.assertGreater(w, 10000)

    def test_a_block_insert_keeps_its_scale_and_rotation(self):
        d = self.ready()
        root = _tree(self.svg(d))
        g = next(g for g in root.iter(f"{SVG}g") if g.get("data-layer") == "FURNITURE")
        path = g.find(f"{SVG}path").get("d")
        ox, top = d.extents["min_x"], d.extents["max_y"]
        # DESK (1600 x 800) at (7000, 4000), half size, turned 90°: x from
        # 6600 to 7000, y from 4000 to 4800 in the drawing.
        nums = [float(v) for v in path.replace("M", " ").replace("L", " ").split()]
        xs, ys = nums[0::2], nums[1::2]
        self.assertAlmostEqual(min(xs) + ox, 6600, places=0)
        self.assertAlmostEqual(max(xs) + ox, 7000, places=0)
        self.assertAlmostEqual(top - max(ys), 4000, places=0)
        self.assertAlmostEqual(top - min(ys), 4800, places=0)

    def test_text_is_svg_text_and_hatches_are_fills(self):
        d = self.ready()
        root = _tree(self.svg(d))
        texts = [t.text for t in root.iter(f"{SVG}text")]
        self.assertIn("Server room", texts)
        self.assertIn("Hall A", texts)
        self.assertIn("Cold aisle", texts)
        hatch = next(g for g in root.iter(f"{SVG}g") if g.get("data-kind") == "hatch")
        fills = [p.get("fill") for p in hatch.iter(f"{SVG}path")]
        self.assertEqual(len(fills), 2)
        self.assertTrue(all(f and f != "none" for f in fills))
        # The pattern hatch is a light tint, the solid one opaque.
        opacities = sorted(p.get("fill-opacity") or "1" for p in hatch.iter(f"{SVG}path"))
        self.assertEqual(opacities, ["0.25", "1"])
        self.assertEqual(root.findall(f".//{SVG}image"), [])

    def test_off_and_frozen_layers_are_drawn_but_start_hidden(self):
        d = self.ready()
        rows = {row["name"]: row for row in d.layers}
        self.assertFalse(rows["GRID-OFF"]["on"])
        self.assertTrue(rows["FROZEN"]["frozen"])
        self.assertTrue(rows["WALLS"]["on"])
        self.assertEqual(rows["WALLS"]["color"], "#ff0000")
        self.assertGreater(rows["WALLS"]["entity_count"], 0)
        self.assertEqual(sorted(d.placement["hidden_layers"]), ["FROZEN", "GRID-OFF"])
        self.assertEqual(d.placement["rotation"], 0)
        self.assertEqual(d.placement["opacity"], 60)

    def test_units_set_and_unset(self):
        for code, unit, mpu, source in ((1, "in", 25.4, "units"), (6, "m", 1000.0, "units"),
                                        (0, "unitless", None, "assumed")):
            with self.subTest(code=code):
                d = self.ready(fx.floor_dxf(units=code))
                self.assertEqual(d.units, unit)
                self.assertEqual(d.units_mm_per_unit, mpu)
                self.assertEqual(d.scale_source, source)
                self.assertEqual(d.mm_per_unit, mpu or 1.0)

    def test_external_references_are_never_drawn(self):
        d = self.ready(fx.hostile_dxf())
        self.assertEqual(d.skipped["external"], 3)
        data = self.svg(d)
        for needle in (b"/etc/passwd", b"/etc/shadow", b"/etc/hosts", b"<image", b"href"):
            self.assertNotIn(needle, data)

    def test_a_nested_block_bomb_fails_fast(self):
        self.upload(fx.block_bomb_dxf())
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(d.status, "failed")
        self.assertIn("too many shapes", d.error)

    def test_garbage_fails_with_a_reason(self):
        self.upload(b"0\n" + os.urandom(4000))
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(d.status, "failed")
        self.assertIn("not a readable DXF", d.error)
        self.assertFalse(d.rendered)

    def test_an_empty_model_space_fails(self):
        import ezdxf

        self.upload(fx.to_bytes(ezdxf.new("R2018")))
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(d.status, "failed")
        self.assertIn("nothing to show", d.error)

    def test_over_the_cap_it_simplifies_hatches_first(self):
        full = self.svg(self.ready())
        FloorPlanDrawing.objects.all().delete()
        with mock.patch.object(cad_render, "MAX_SVG_BYTES", len(full) - 200):
            d = self.ready()
        self.assertEqual(d.simplified[0], "hatch")
        kinds = {g.get("data-kind") for g in _tree(self.svg(d)).iter(f"{SVG}g")}
        self.assertNotIn("hatch", kinds)
        self.assertLessEqual(d.rendered_bytes, len(full) - 200)

    def test_still_over_the_cap_it_fails_saying_so(self):
        with mock.patch.object(cad_render, "MAX_SVG_BYTES", 300):
            self.upload(fx.floor_dxf())
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(d.status, "failed")
        self.assertIn("too large", d.error)

    def test_many_entities_merge_into_few_elements(self):
        d = self.ready(fx.many_lines_dxf(5000))
        self.assertLess(d.rendered_elements, 200)
        self.assertEqual(d.layers[0]["entity_count"], 5000)

    def test_the_engine_runs_isolated_with_limits(self):
        seen = {}
        real = cad_render._run

        def spy(argv, **kw):
            seen["argv"], seen["env"] = argv, kw["env"]
            return real(argv, **kw)

        with mock.patch.object(cad_render, "_run", side_effect=spy):
            self.ready()
        self.assertEqual(seen["argv"][:2], [sys.executable, "-I"])
        self.assertNotIn("DJANGO_SETTINGS_MODULE", seen["env"])
        self.assertNotIn("SECRET_KEY", " ".join(seen["env"]))


# ─── jobs re-check what they were queued for ────────────────────────────────


class JobRecheckTests(_Base):
    def _queued(self, data=None):
        d = FloorPlanDrawing(tenant=self.tenant, floor_plan=self.plan, source_kind="dxf")
        d.source.save("a.dxf", ContentFile(data or fx.floor_dxf()), save=False)
        d.save()
        return d

    def test_a_replaced_file_is_left_alone(self):
        d = self._queued()
        old = d.source.name
        d.source.save("b.dxf", ContentFile(fx.floor_dxf(units=1)), save=False)
        d.save()
        cad_render.run_render(str(d.id), old)
        d.refresh_from_db()
        self.assertEqual(d.status, "queued")
        self.assertFalse(d.rendered)

    def test_a_drawing_out_of_its_plans_tenant_is_left_alone(self):
        d = self._queued()
        FloorPlanDrawing.objects.filter(pk=d.pk).update(tenant=self.other)
        cad_render.run_render(str(d.id), d.source.name)
        d.refresh_from_db()
        self.assertEqual(d.status, "queued")

    def test_a_deleted_drawing_is_a_no_op(self):
        d = self._queued()
        pk, name = str(d.id), d.source.name
        d.delete()
        cad_render.run_render(pk, name)  # nothing to raise
        self.assertFalse(FloorPlanDrawing.objects.exists())

    def test_a_queue_that_is_down_fails_the_drawing(self):
        self.queue.stop()
        with mock.patch("django_rq.get_queue", side_effect=ConnectionError("down")):
            r = self.upload(fx.floor_dxf())
        self.queue.start()
        self.assertEqual(r.status_code, 202)
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(d.status, "failed")
        self.assertIn("queue", d.error)


# ─── DWG through a converter ────────────────────────────────────────────────


DWG = b"AC1032" + b"\x00" * 200


class ConverterTests(_Base):
    def setUp(self):
        super().setUp()
        self.bin = tempfile.mkdtemp(prefix="danbyte-cad-bin-")
        self.addCleanup(shutil.rmtree, self.bin, True)
        self.dxf = os.path.join(self.bin, "fixture.dxf")
        with open(self.dxf, "wb") as fh:
            fh.write(fx.floor_dxf(units=6))
        self.env_dump = os.path.join(self.bin, "env.json")

    def fake(self, body: str, name="dwg2dxf") -> str:
        """A converter: a Python script taking dwg2dxf's arguments."""
        path = os.path.join(self.bin, name)
        with open(path, "w") as fh:
            fh.write(f"#!{sys.executable}\nimport json, os, shutil, sys, time\n{body}\n")
        os.chmod(path, 0o755)
        return path

    def copying(self) -> str:
        return self.fake(
            f"json.dump(dict(os.environ), open({self.env_dump!r}, 'w'))\n"
            f"out = sys.argv[sys.argv.index('-o') + 1]\n"
            f"shutil.copyfile({self.dxf!r}, out)"
        )

    def test_without_a_converter_dwg_is_refused_with_the_export_steps(self):
        r = self.upload(DWG, name="plan.dwg")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data["code"], "converter_missing")
        self.assertIn("DXF", r.data["file"][0])
        self.assertFalse(FloorPlanDrawing.objects.exists())
        s = self.client.get("/api/floor-plans/drawing-support/").data
        self.assertFalse(s["dwg"])
        self.assertTrue(s["dxf"])
        self.assertEqual(s["max_upload_bytes"], 50 * 1024 * 1024)

    def test_a_dwg_converts_and_renders(self):
        with self.settings(DANBYTE_CAD_CONVERTER=self.copying()):
            self.assertTrue(self.client.get("/api/floor-plans/drawing-support/").data["dwg"])
            r = self.upload(DWG, name="plan.dwg")
        self.assertEqual(r.status_code, 202, r.content)
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual((d.source_kind, d.status), ("dwg", "ready"), d.error)
        self.assertEqual(d.units, "m")
        # Scrubbed environment: nothing of the app's.
        env = json.load(open(self.env_dump))
        self.assertNotIn("DJANGO_SETTINGS_MODULE", env)
        self.assertNotIn("DB_NAME", env)
        self.assertEqual(env["HOME"], env["TMPDIR"])

    def test_only_the_two_known_programs_may_be_named(self):
        other = self.fake("pass", name="convert")
        for value in (other, "dwg2dxf", os.path.join(self.bin, "missing", "dwg2dxf")):
            with self.subTest(value=value), self.settings(DANBYTE_CAD_CONVERTER=value):
                with self.assertRaises(cad_render.ConverterUnavailable):
                    cad_render.converter()

    def test_a_world_writable_converter_is_refused(self):
        path = self.copying()
        os.chmod(path, 0o757)
        with self.settings(DANBYTE_CAD_CONVERTER=path):
            with self.assertRaises(cad_render.ConverterUnavailable):
                cad_render.converter()
        os.chmod(path, stat.S_IRWXU)

    def test_a_converter_that_fails_says_so(self):
        with self.settings(DANBYTE_CAD_CONVERTER=self.fake("sys.exit(1)")):
            self.upload(DWG, name="plan.dwg")
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(d.status, "failed")
        self.assertIn("could not read this file", d.error)

    def test_a_converter_that_hangs_is_killed(self):
        with self.settings(DANBYTE_CAD_CONVERTER=self.fake("time.sleep(30)")), \
                mock.patch.object(cad_render, "CONVERT_TIMEOUT", 1):
            self.upload(DWG, name="plan.dwg")
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(d.status, "failed")
        self.assertIn("too long", d.error)

    def test_converter_output_over_the_cap_is_refused(self):
        with self.settings(DANBYTE_CAD_CONVERTER=self.copying()), \
                mock.patch.object(cad_render, "MAX_CONVERTED_BYTES", 100):
            self.upload(DWG, name="plan.dwg")
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(d.status, "failed")

    def test_the_name_and_the_bytes_must_agree(self):
        with self.settings(DANBYTE_CAD_CONVERTER=self.copying()):
            for data, name in ((DWG, "plan.dxf"), (fx.floor_dxf(), "plan.dwg"),
                               (fx.floor_dxf(), "plan.txt"), (b"\x89PNG\r\n", "plan.dxf")):
                with self.subTest(name=name):
                    self.assertEqual(self.upload(data, name=name).status_code, 400)
        self.assertFalse(FloorPlanDrawing.objects.exists())


# ─── the sanitiser's CAD profile ────────────────────────────────────────────


def _svg(body: str) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">{body}</svg>'


class CadSanitiserTests(TestCase):
    def test_the_default_profile_is_unchanged(self):
        self.assertEqual(MAX_SVG_BYTES, 8 * 1024 * 1024)
        self.assertEqual(MAX_ELEMENTS, 60_000)
        self.assertEqual(MAX_TEXT_CHARS, 80_000)
        body = _svg('<g data-layer="WALLS" data-kind="text"><path d="M0 0L1 1"/></g>'
                    '<image href="/media/device-type-images/x.png" width="1" height="1"/>')
        out = sanitize_svg(body)
        self.assertEqual(out, sanitize_svg(body, profile="default"))
        self.assertNotIn(b"data-layer", out)
        self.assertNotIn(b"data-kind", out)
        self.assertIn(b"<image", out)
        with self.assertRaises(SvgTooLarge):
            sanitize_svg(_svg("<g/>" * 61_000))

    def test_the_cad_profile_keeps_layers_and_text(self):
        out = sanitize_svg(
            _svg('<g data-layer="A-WALL &amp; Doors" data-kind="text" data-x="1">'
                 '<text transform="matrix(1 0 0 1 2 3)" font-size="2">Room</text></g>'),
            profile="cad",
        )
        g = _tree(out).find(f"{SVG}g")
        self.assertEqual(g.get("data-layer"), "A-WALL & Doors")
        self.assertEqual(g.get("data-kind"), "text")
        self.assertIsNone(g.get("data-x"))
        self.assertEqual(g.find(f"{SVG}text").text, "Room")

    def test_the_cad_profile_drops_anything_that_references_or_runs(self):
        out = sanitize_svg(
            _svg('<script>alert(1)</script><g data-layer="X" onclick="x()">'
                 '<image href="/media/device-type-images/x.png" width="1" height="1"/>'
                 '<image href="file:///etc/passwd"/><use href="#s"/>'
                 '<symbol id="s"><path d="M0 0"/></symbol><style>path{fill:red}</style>'
                 '<foreignObject><div/></foreignObject><a href="javascript:x()">'
                 '<path d="M0 0L1 1"/></a><g data-kind="bogus"/></g>'),
            profile="cad",
        )
        for needle in (b"script", b"image", b"use", b"symbol", b"style", b"onclick",
                       b"foreignObject", b"javascript", b"passwd", b"bogus"):
            self.assertNotIn(needle, out)
        self.assertIn(b'd="M0 0L1 1"', out)

    def test_the_cad_profile_has_higher_caps_and_still_refuses_doctype(self):
        sanitize_svg(_svg("<g/>" * 61_000), profile="cad")
        with self.assertRaises(SvgTooLarge):
            sanitize_svg(_svg("<g/>" * 20), profile="cad", max_elements=10)
        with self.assertRaises(SvgRejected):
            sanitize_svg('<!DOCTYPE svg [<!ENTITY x "y">]>' + _svg(""), profile="cad")
        with self.assertRaises(ValueError):
            sanitize_svg(_svg(""), profile="nope")

    def test_a_script_injected_after_render_is_dropped(self):
        engine_svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
            '<g data-layer="WALLS"><path d="M0 0L10 10" stroke="#ff0000"/>'
            '<script>fetch("/api/")</script>'
            '<path d="M0 0" onload="alert(1)" style="fill:url(http://x)"/></g></svg>'
        )
        out = sanitize_svg(engine_svg, profile="cad")
        self.assertNotIn(b"script", out)
        self.assertNotIn(b"onload", out)
        self.assertNotIn(b"http://x", out)
        self.assertEqual(_layers(_tree(out)), ["WALLS"])


# ─── the plan's drawing endpoints ───────────────────────────────────────────


class DrawingApiTests(_Base):
    def test_upload_returns_the_queued_drawing_then_get_reads_it(self):
        r = self.upload(fx.floor_dxf(), name="Ground floor.dxf")
        self.assertEqual(r.status_code, 202)
        self.assertEqual(r.data["status"], "queued")
        self.assertEqual(r.data["source_name"], "Ground floor.dxf")
        g = self.client.get(self.url())
        self.assertEqual(g.status_code, 200)
        self.assertEqual(g.data["status"], "ready")
        self.assertTrue(g.data["rendered_url"].startswith(
            f"/media/floor-plans/cad/{self.plan.id}/"))
        self.assertEqual(g.data["mm_per_unit"], 1.0)
        self.assertEqual(g.data["fit"]["grid_width"], 17)  # 10.0002 m / 600 mm
        plan = self.client.get(f"/api/floor-plans/{self.plan.id}/").data
        self.assertEqual(plan["drawing"]["status"], "ready")
        self.assertEqual(plan["drawing"]["rendered_url"], g.data["rendered_url"])

    def test_no_drawing_is_a_404(self):
        self.assertEqual(self.client.get(self.url()).status_code, 404)
        self.assertIsNone(self.client.get(f"/api/floor-plans/{self.plan.id}/").data["drawing"])

    def test_a_missing_or_oversized_file_is_refused(self):
        self.assertEqual(self.client.post(self.url(), {}, format="multipart").status_code, 400)
        with mock.patch.object(cad_render, "MAX_UPLOAD_BYTES", 100):
            r = self.upload(fx.floor_dxf())
        self.assertEqual(r.status_code, 400)
        self.assertIn("50 MB", r.data["file"][0])

    def test_a_new_upload_replaces_the_old_and_its_files(self):
        d = self.ready()
        old = [d.source.path, d.rendered.path]
        d.calibration = {"a": [0, 0], "b": [1, 0], "distance_mm": 5, "mm_per_unit": 5}
        d.placement = {**d.placement, "x_mm": 1200, "rotation": 90}
        d.save()
        d2 = self.ready(fx.floor_dxf(units=6))
        self.assertEqual(d2.pk, d.pk)
        self.assertIsNone(d2.calibration)
        self.assertEqual(d2.units, "m")
        # Position and rotation stay; the layers are the new file's.
        self.assertEqual((d2.placement["x_mm"], d2.placement["rotation"]), (1200, 90))
        for path in old:
            self.assertFalse(os.path.exists(path))

    def test_placement_patch_validates_and_returns_the_transform(self):
        d = self.ready()
        bad = [{"rotation": 45}, {"opacity": 101}, {"hidden_layers": ["NOPE"]},
               {"x_mm": "east"}, {"hide_text": "maybe"}]
        for body in bad:
            with self.subTest(body=body):
                self.assertEqual(
                    self.client.patch(self.url(), body, format="json").status_code, 400
                )
        r = self.client.patch(
            self.url(),
            {"x_mm": 600, "y_mm": 1200, "rotation": 90, "opacity": 40,
             "hidden_layers": ["TEXT", "DIMS"], "hide_text": True},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        p = r.data["placement"]
        self.assertEqual((p["x_mm"], p["y_mm"], p["rotation"], p["opacity"]), (600, 1200, 90, 40))
        self.assertEqual(p["hidden_layers"], ["DIMS", "TEXT"])
        self.assertTrue(p["hide_text"])
        w, h = cad_render.size_units(d)
        box = r.data["bounds_mm"]
        # Turned a quarter: the box is the drawing's height wide.
        self.assertAlmostEqual(box["width"], h)
        self.assertAlmostEqual(box["height"], w)
        self.assertEqual(
            r.data["transform_mm"],
            f"translate({cad_render._n(600 + h / 2)} {cad_render._n(1200 + w / 2)}) "
            f"rotate(90) scale(1) translate({cad_render._n(-w / 2)} {cad_render._n(-h / 2)})",
        )

    def test_calibration_sets_the_scale_and_delete_reverts(self):
        self.ready(fx.floor_dxf(units=0))
        r = self.client.post(self.url(tail="calibrate/"),
                             {"a": [0, 0], "b": [1, 0], "distance_mm": 600}, format="json")
        self.assertEqual(r.status_code, 400)  # 1 unit apart: under 1% of the drawing
        r = self.client.post(self.url(tail="calibrate/"),
                             {"a": [0, 0], "b": [3000, 4000], "distance_mm": 10000},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.data["scale_source"], "calibration")
        self.assertAlmostEqual(r.data["mm_per_unit"], 2.0)
        self.assertEqual(r.data["calibration"]["distance_mm"], 10000)
        r = self.client.delete(self.url(tail="calibrate/"))
        self.assertEqual((r.status_code, r.data["scale_source"]), (200, "assumed"))
        for body in ({"a": [0], "b": [1, 1], "distance_mm": 5},
                     {"a": [0, 0], "b": [3000, 4000], "distance_mm": 0},
                     {"a": [0, 0], "b": [3000, 4000], "distance_mm": 1e12}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post(self.url(tail="calibrate/"), body,
                                                  format="json").status_code, 400)

    def test_fit_grid_sizes_the_plan_to_the_drawing(self):
        self.ready()
        self.client.patch(self.url(), {"x_mm": 5000}, format="json")
        r = self.client.post(self.url(tail="fit-grid/"), {"cell_mm": 500}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.plan.refresh_from_db()
        self.assertEqual((self.plan.cell_mm, self.plan.grid_width, self.plan.grid_height),
                         (500, 21, 17))
        self.assertEqual(r.data["drawing"]["placement"]["x_mm"], 0)
        r = self.client.post(self.url(tail="fit-grid/"), {"cell_mm": 50}, format="json")
        self.assertEqual(r.status_code, 200)  # 201 cells
        self.ready(fx.floor_dxf(units=6))  # now 10 km wide
        r = self.client.post(self.url(tail="fit-grid/"), {}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data["min_cell_mm"], 19532)

    def test_a_server_render_with_layers_hidden_is_cached(self):
        d = self.ready()
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(self.url(tail="render/"),
                                 {"hidden_layers": ["WALLS"], "hide_text": True}, format="json")
        self.assertEqual(r.status_code, 202, r.content)
        key = r.data["key"]
        g = self.client.get(self.url(tail="render/"), {"key": key})
        self.assertEqual(g.data["status"], "ready", g.data)
        d.refresh_from_db()
        with open(os.path.join(MEDIA, d.variants[key]["file"]), "rb") as fh:
            root = _tree(fh.read())
        self.assertNotIn("WALLS", _layers(root))
        self.assertIn("DOORS", _layers(root))
        self.assertEqual(root.findall(f".//{SVG}text"), [])
        again = self.client.post(self.url(tail="render/"),
                                 {"hidden_layers": ["WALLS"], "hide_text": True}, format="json")
        self.assertEqual((again.status_code, again.data["key"]), (200, key))
        self.assertEqual(self.client.get(g.data["url"]).status_code, 200)
        self.assertEqual(
            self.client.get(self.url(tail="render/"), {"key": "nope"}).status_code, 404
        )

    def test_only_so_many_renders_are_kept(self):
        self.ready()
        with mock.patch.object(cad_render, "MAX_VARIANTS", 2):
            for layer in ("WALLS", "DOORS", "TEXT"):
                with self.captureOnCommitCallbacks(execute=True):
                    self.client.post(self.url(tail="render/"), {"hidden_layers": [layer]},
                                     format="json")
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(len(d.variants), 2)
        kept = {tuple(v["hidden_layers"]) for v in d.variants.values()}
        self.assertEqual(kept, {("DOORS",), ("TEXT",)})

    def test_reprocess_requeues(self):
        d = self.ready()
        d.placement = {**d.placement, "hidden_layers": ["WALLS"]}
        d.save()
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(self.url(tail="reprocess/"))
        self.assertEqual(r.status_code, 202)
        d.refresh_from_db()
        self.assertEqual(d.status, "ready")
        self.assertEqual(d.placement["hidden_layers"], ["WALLS"])

    def test_delete_removes_the_drawing_and_its_files(self):
        d = self.ready()
        folder = os.path.dirname(d.source.path)
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.delete(self.url())
        self.assertEqual(r.status_code, 204)
        self.assertFalse(FloorPlanDrawing.objects.exists())
        self.assertFalse(os.path.exists(folder))

    def test_deleting_the_plan_cleans_up_its_files(self):
        d = self.ready()
        folder = os.path.dirname(d.source.path)
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(
                self.client.delete(f"/api/floor-plans/{self.plan.id}/").status_code, 204
            )
        self.assertFalse(os.path.exists(folder))

    def test_clone_copies_the_drawing_into_its_own_folder(self):
        d = self.ready()
        d.placement = {**d.placement, "x_mm": 300}
        d.save()
        FloorPlanTile.objects.create(floor_plan=self.plan, x=0, y=0,
                                     tile_type=self._tile_type())
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(f"/api/floor-plans/{self.plan.id}/clone/")
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlanDrawing.objects.get(floor_plan_id=r.data["id"])
        self.assertEqual(copy.status, "ready")
        self.assertEqual(copy.tenant, self.tenant)
        self.assertEqual(copy.layers, d.layers)
        self.assertEqual(copy.placement["x_mm"], 300)
        self.assertTrue(copy.source.name.startswith(f"floor-plans/cad/{r.data['id']}/"))
        self.assertTrue(copy.rendered.name.startswith(f"floor-plans/cad/{r.data['id']}/"))
        self.assertEqual(self.svg(copy), self.svg(d))
        self.assertEqual(r.data["drawing"]["status"], "ready")

    def _tile_type(self):
        from .models import FloorTileType

        return FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")

    def test_changes_are_in_the_change_log(self):
        from audit.models import ChangeLogEntry

        d = self.ready()
        self.client.patch(self.url(), {"opacity": 30}, format="json")
        rows = ChangeLogEntry.objects.filter(object_type="api.floorplandrawing",
                                             object_id=str(d.id))
        self.assertTrue(rows.filter(action="create").exists())
        self.assertTrue(rows.filter(action="update").exists())
        self.assertEqual({r.tenant_id for r in rows}, {self.tenant.id})
        self.assertEqual({r.object_site_id for r in rows}, {self.loc.site_id})

    def test_the_drawing_is_in_a_media_backup(self):
        from backups.engine import archive_media

        d = self.ready()
        dest = os.path.join(tempfile.mkdtemp(), "media.tar")
        self.addCleanup(shutil.rmtree, os.path.dirname(dest), True)
        archive_media(dest)
        with tarfile.open(dest) as tar:
            names = tar.getnames()
        self.assertIn(f"media/{d.source.name}", names)
        self.assertIn(f"media/{d.rendered.name}", names)


# ─── permissions and tenant isolation, endpoint by endpoint ─────────────────


class DrawingAccessTests(_Base):
    WRITES = [
        ("post", "", None),
        ("patch", "", {"opacity": 10}),
        ("delete", "", None),
        ("post", "reprocess/", None),
        ("post", "calibrate/", {"a": [0, 0], "b": [3000, 4000], "distance_mm": 10}),
        ("delete", "calibrate/", None),
        ("post", "fit-grid/", {}),
    ]

    def setUp(self):
        super().setUp()
        self.d = self.ready()

    def call(self, method, tail, body, plan=None):
        url = self.url(plan, tail)
        if method == "post" and tail == "":
            return self.client.post(
                url, {"file": SimpleUploadedFile("x.dxf", fx.floor_dxf())}, format="multipart"
            )
        return getattr(self.client, method)(url, body, format="json")

    def test_a_viewer_reads_but_cannot_change(self):
        self.login(self.member("viewer", "view"))
        self.assertEqual(self.client.get(self.url()).status_code, 200)
        self.assertEqual(self.client.get(self.d.rendered.url).status_code, 200)
        self.assertEqual(self.client.get(self.d.source.url).status_code, 200)
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(self.url(tail="render/"), {"hidden_layers": ["WALLS"]},
                                 format="json")
        self.assertEqual(r.status_code, 202)
        for method, tail, body in self.WRITES:
            with self.subTest(method=method, tail=tail):
                self.assertEqual(self.call(method, tail, body).status_code, 403)
        self.d.refresh_from_db()
        self.assertEqual(self.d.placement["opacity"], 60)

    def test_an_editor_may_change(self):
        self.login(self.member("editor", "view", "change"))
        r = self.client.patch(self.url(), {"opacity": 10}, format="json")
        self.assertEqual(r.status_code, 200)

    def test_a_member_without_view_sees_nothing(self):
        self.login(self.member("nobody"))
        for tail in ("", "render/?key=x"):
            self.assertIn(self.client.get(self.url(tail=tail)).status_code, (403, 404))
        self.assertEqual(self.client.get(self.d.rendered.url).status_code, 404)
        self.assertEqual(self.client.get(self.d.source.url).status_code, 404)
        for method, tail, body in self.WRITES:
            with self.subTest(method=method, tail=tail):
                self.assertIn(self.call(method, tail, body).status_code, (403, 404))

    def test_another_tenant_cannot_reach_any_of_it(self):
        outsider = self.member("outsider", "view", "change", "add", "delete",
                               tenant=self.other)
        self.login(outsider, self.other)
        self.assertEqual(self.client.get(self.url()).status_code, 404)
        self.assertEqual(self.client.get(self.d.rendered.url).status_code, 404)
        self.assertEqual(self.client.get(self.d.source.url).status_code, 404)
        self.assertEqual(self.client.post(self.url(tail="render/"), {}, format="json")
                         .status_code, 404)
        for method, tail, body in self.WRITES:
            with self.subTest(method=method, tail=tail):
                self.assertEqual(self.call(method, tail, body).status_code, 404)
        self.d.refresh_from_db()
        self.assertEqual(self.d.status, "ready")
        self.assertEqual(self.client.post(f"/api/floor-plans/{self.plan.id}/clone/")
                         .status_code, 404)

    def test_a_superuser_in_another_tenant_cannot_reach_it_either(self):
        self.login(self.admin, self.other)
        self.assertEqual(self.client.get(self.url()).status_code, 404)
        self.assertEqual(self.client.get(self.d.rendered.url).status_code, 404)

    def test_media_paths_outside_a_plan_folder_are_refused(self):
        for bad in ("/media/floor-plans/cad/not-a-uuid/x.svg",
                    f"/media/floor-plans/cad/{self.plan.id}",
                    f"/media/floor-plans/cad/{self.plan.id}/../x.svg",
                    f"/media/floor-plans/cad/{self.other_plan.id}/x.svg"):
            with self.subTest(bad=bad):
                self.assertEqual(self.client.get(bad).status_code, 404)

    def test_the_rendered_svg_downloads_and_never_runs(self):
        r = self.client.get(self.d.rendered.url)
        self.assertEqual(r["Content-Type"], "image/svg+xml")
        self.assertIn("attachment", r["Content-Disposition"])
        self.assertIn("sandbox", r["Content-Security-Policy"])
        self.assertIn("private", r["Cache-Control"])

    def test_anonymous_gets_nothing(self):
        self.client.logout()
        self.assertIn(self.client.get(self.url()).status_code, (401, 403))
        self.assertEqual(self.client.get(self.d.rendered.url).status_code, 404)
