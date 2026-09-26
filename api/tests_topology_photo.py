"""``include=photo`` on /api/topology/: each device node's front photo with
the markers of its cabled ports. Markers resolve the way the face-ports
endpoint resolves them - ``{position}`` rendered for a stack member, the
frozen ``marker_key`` before the name, case and spaces ignored last, the
device's own layout over its type's - against the ports the graph already
loaded, with no SNMP and a cost flat in the node count."""
from __future__ import annotations

import io
import shutil
import tempfile
from unittest import mock

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api import topology_enrich as te
from api.models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    DeviceType,
    FrontPort,
    Interface,
    InterfaceTemplate,
    ModuleBay,
    PowerOutlet,
    PowerPort,
    RearPort,
    Site,
)
from auth_api.models import UserProfile
from core.models import Organization, Tenant

MEDIA = tempfile.mkdtemp(prefix="danbyte-topo-photo-")


def _png(w, h, fmt="PNG", exif=None):
    from PIL import Image

    buf = io.BytesIO()
    kw = {"exif": exif} if exif is not None else {}
    Image.new("RGB", (w, h), "#333").save(buf, fmt, **kw)
    return buf.getvalue()


def _marker(kind, name, x=0.5, **kw):
    return {"kind": kind, "name": name, "x": x, "y": 0.5, "w": 0.03, "h": 0.4, **kw}


@override_settings(
    MEDIA_ROOT=MEDIA,
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
)
class _Base(APITestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="dc-1")
        u = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        self.client.force_login(u)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _type(self, name, front=None, image=(480, 40), **kw):
        """A device type with ``front`` markers and a ``image`` (w, h) PNG
        front photo; ``image=None`` for none, bytes for a file as given."""
        if image is not None:
            data = image if isinstance(image, bytes) else _png(*image)
            kw["front_image"] = SimpleUploadedFile(
                f"{name}.png", data, content_type="image/png"
            )
        if front is not None:
            kw["image_ports"] = {"front": front, "rear": []}
        return DeviceType.objects.create(tenant=self.tenant, name=name, **kw)

    def _device(self, name, device_type=None, **kw):
        return Device.objects.create(
            tenant=self.tenant, name=name, site=self.site,
            device_type=device_type, **kw,
        )

    def _cable(self, a, b):
        kinds = {
            Interface: "interface", FrontPort: "front_port", RearPort: "rear_port",
            PowerPort: "power_port", PowerOutlet: "power_outlet",
        }
        cab = Cable.objects.create(tenant=self.tenant)
        for end, port in (("A", a), ("B", b)):
            CableTermination.objects.create(
                cable=cab, end=end, **{kinds[type(port)]: port}
            )
        return cab

    def _graph(self, **body):
        body.setdefault("include", ["photo"])
        r = self.client.post("/api/topology/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _photos(self, g):
        return {n["data"]["name"]: n["data"].get("photo") for n in g["nodes"]}

    @staticmethod
    def _ports(photo):
        return [(m["port"], m["port_id"]) for m in photo["front"]["markers"]]


class PhotoPayloadTests(_Base):
    def setUp(self):
        super().setUp()
        self.peer = self._device("peer")
        self.peer_ports = 0

    def _to_peer(self, port):
        self.peer_ports += 1
        far = Interface.objects.create(device=self.peer, name=f"p{self.peer_ports}")
        self._cable(port, far)

    def test_default_payload_has_no_photo(self):
        dt = self._type("SW", front=[_marker("interface", "eth0")])
        a = self._device("sw-a", dt)
        self._to_peer(Interface.objects.create(device=a, name="eth0"))
        g = self.client.get("/api/topology/").json()
        self.assertTrue(g["nodes"])
        self.assertTrue(all("photo" not in n["data"] for n in g["nodes"]))

    def test_front_photo_and_cabled_markers(self):
        dt = self._type("SW-48", u_height=2, front=[
            _marker("interface", "eth0", 0.1),
            _marker("interface", "eth9", 0.9),
        ])
        a = self._device("sw-a", dt)
        eth0 = Interface.objects.create(device=a, name="eth0")
        Interface.objects.create(device=a, name="eth9")
        self._to_peer(eth0)
        g = self.client.get("/api/topology/?include=photo").json()
        photos = self._photos(g)
        front = photos["sw-a"]["front"]
        self.assertTrue(front["url"].startswith("/media/device-type-images/"))
        self.assertTrue(front["url"].endswith(".png"))
        self.assertAlmostEqual(front["aspect"], 40 / 480, places=5)
        self.assertIsNone(front["scale"])
        # Only the cabled port's marker ships; eth9 is uncabled.
        self.assertEqual(front["markers"], [{
            "port": "eth0", "port_id": str(eth0.id), "kind": "interface",
            "x": 0.1, "y": 0.5, "w": 0.03, "h": 0.4,
        }])
        self.assertEqual(photos["sw-a"]["u_height"], 2)
        self.assertIsNone(photos["sw-a"]["vc_position"])
        # The peer has no type: no photo, no faceplate, one unit.
        self.assertEqual(photos["peer"], {
            "front": None, "type_faceplate": False, "u_height": 1,
            "vc_position": None,
        })

    def test_position_renders_for_a_stack_member(self):
        dt = self._type("C9300", front=[
            _marker("interface", "Gi{position}/0/1"),
            _marker("interface", "Gi{position}/0/2"),
        ])
        member = self._device("sw-2", dt, vc_position=2)
        gi = Interface.objects.create(device=member, name="Gi2/0/1")
        # Member 1's name on member 2 is not the marker's port.
        Interface.objects.create(device=member, name="Gi1/0/2")
        self._to_peer(gi)
        self._to_peer(Interface.objects.get(device=member, name="Gi1/0/2"))
        photo = self._photos(self._graph())["sw-2"]
        self.assertEqual(self._ports(photo), [("Gi2/0/1", str(gi.id))])
        self.assertEqual(photo["vc_position"], 2)

    def test_marker_key_survives_a_rename(self):
        dt = self._type("C9300", front=[_marker("interface", "Gi1/0/2")])
        d = self._device("sw", dt)
        # Stamped from the template as Gi1/0/2, renamed since.
        uplink = Interface.objects.create(
            device=d, name="uplink-core", marker_key="Gi1/0/2"
        )
        self._to_peer(uplink)
        photo = self._photos(self._graph())["sw"]
        self.assertEqual(self._ports(photo), [("uplink-core", str(uplink.id))])

    def test_marker_key_wins_over_another_ports_name(self):
        dt = self._type("C9300", front=[_marker("interface", "Gi1/0/2")])
        d = self._device("sw", dt)
        uplink = Interface.objects.create(
            device=d, name="uplink-core", marker_key="Gi1/0/2"
        )
        other = Interface.objects.create(device=d, name="Gi1/0/2", marker_key="")
        self._to_peer(uplink)
        self._to_peer(other)
        photo = self._photos(self._graph())["sw"]
        self.assertEqual(self._ports(photo), [("uplink-core", str(uplink.id))])

    def test_an_uncabled_better_match_keeps_its_marker_off_the_map(self):
        """A marker lands where the faceplate lands it, among ALL the
        device's components: when that is an uncabled port, the marker is
        left out rather than falling through to a cabled port that matches
        only by a looser rule."""
        dt = self._type("SW", front=[
            _marker("interface", "Gi1/0/2", 0.2),  # marker_key of a spare
            _marker("interface", "eth0", 0.4),  # exact name of a spare
            _marker("interface", "eth1", 0.6),  # only the cabled one matches
        ])
        d = self._device("sw", dt)
        Interface.objects.create(device=d, name="spare", marker_key="Gi1/0/2")
        Interface.objects.create(device=d, name="eth0")
        for name in ("gi1/0/2", "ETH0", "ETH1"):
            self._to_peer(Interface.objects.create(device=d, name=name))
        front = self._photos(self._graph())["sw"]["front"]
        self.assertEqual(
            [(m["port"], m["x"]) for m in front["markers"]], [("ETH1", 0.6)]
        )

    def test_device_override_replaces_the_type_layout(self):
        dt = self._type("SW", image_ports={
            "front": [_marker("interface", "eth0", 0.1)], "rear": [],
            "view": {"front": {"scale": 0.8}},
        })
        d = self._device("sw", dt)
        eth0 = Interface.objects.create(device=d, name="eth0")
        eth1 = Interface.objects.create(device=d, name="eth1")
        self._to_peer(eth0)
        self._to_peer(eth1)
        front = self._photos(self._graph())["sw"]["front"]
        self.assertEqual(self._ports({"front": front}), [("eth0", str(eth0.id))])
        self.assertEqual(front["scale"], 0.8)

        d.image_ports = {
            "front": [_marker("interface", "eth1", 0.7)], "rear": [],
            "view": {"front": {"scale": 0.5}},
        }
        d.save(update_fields=["image_ports"])
        front = self._photos(self._graph())["sw"]["front"]
        self.assertEqual(self._ports({"front": front}), [("eth1", str(eth1.id))])
        self.assertEqual(front["markers"][0]["x"], 0.7)
        self.assertEqual(front["scale"], 0.5)

        # An empty override places nothing; it doesn't inherit.
        d.image_ports = {}
        d.save(update_fields=["image_ports"])
        front = self._photos(self._graph())["sw"]["front"]
        self.assertEqual(front["markers"], [])
        self.assertIsNone(front["scale"])

    def test_names_match_ignoring_case_and_spaces(self):
        dt = self._type("SRV", front=[
            _marker("power-port", "Psu 1", 0.8),
            _marker("interface", " ETH0 ", 0.2),
        ])
        d = self._device("srv", dt)
        pdu = self._device("pdu")
        psu = PowerPort.objects.create(device=d, name="PSU 1")
        self._cable(psu, PowerOutlet.objects.create(device=pdu, name="OUT-1"))
        eth0 = Interface.objects.create(device=d, name="eth0")
        self._to_peer(eth0)
        front = self._photos(self._graph())["srv"]["front"]
        self.assertEqual(
            [(m["port"], m["port_id"], m["kind"]) for m in front["markers"]],
            [("PSU 1", str(psu.id), "power-port"), ("eth0", str(eth0.id), "interface")],
        )

    def test_uncabled_and_uncableable_markers_are_left_out(self):
        dt = self._type("SW", front=[
            _marker("interface", "eth0"),
            _marker("interface", "eth1"),
            _marker("module-bay", "Slot 1"),
            _marker("bogus", "eth0"),
            _marker("front-port", "eth0"),  # the kind must match too
            _marker("interface", "eth0", 0.9),  # a second marker on eth0
            {"kind": "interface", "name": "eth0", "x": "0.5", "y": 0.5},
        ])
        d = self._device("sw", dt)
        eth0 = Interface.objects.create(device=d, name="eth0")
        Interface.objects.create(device=d, name="eth1")
        ModuleBay.objects.create(device=d, name="Slot 1")
        self._to_peer(eth0)
        front = self._photos(self._graph())["sw"]["front"]
        self.assertEqual(
            [(m["port"], m["x"]) for m in front["markers"]], [("eth0", 0.5)]
        )

    def test_panel_front_ports_on_raw_hops(self):
        panel_role = DeviceRole.objects.create(
            tenant=self.tenant, name="Panel", slug="panel", is_patch_panel=True
        )
        dt = self._type("PP-24", front=[_marker("front-port", "{position}")])
        panel = self._device("pp", dt, role=panel_role)
        rear = RearPort.objects.create(device=panel, name="R1", positions=24)
        fp = FrontPort.objects.create(
            device=panel, name="1", rear_port=rear, rear_port_position=1
        )
        sw = self._device("sw")
        self._cable(fp, Interface.objects.create(device=sw, name="eth0"))
        photos = self._photos(self._graph(collapse_panels=False))
        self.assertEqual(self._ports(photos["pp"]), [("1", str(fp.id))])

    def test_no_photo_or_missing_file_gives_no_front(self):
        none = self._type("NONE", image=None, front=[_marker("interface", "eth0")])
        gone = self._type("GONE", image=None, front=[_marker("interface", "eth0")])
        gone.front_image = "device-type-images/gone.png"
        gone.save()
        bare = self._type("BARE")  # a photo, nothing placed on it
        for name, dt in (("a", none), ("b", gone), ("c", bare)):
            d = self._device(name, dt)
            self._to_peer(Interface.objects.create(device=d, name="eth0"))
        photos = self._photos(self._graph())
        self.assertIsNone(photos["a"]["front"])
        self.assertIsNone(photos["b"]["front"])
        self.assertEqual(photos["c"]["front"]["markers"], [])
        self.assertIsNotNone(photos["c"]["front"]["aspect"])

    def test_unreadable_photo_has_no_aspect(self):
        dt = self._type("JUNK", image=b"not an image", front=[
            _marker("interface", "eth0"),
        ])
        d = self._device("sw", dt)
        eth0 = Interface.objects.create(device=d, name="eth0")
        self._to_peer(eth0)
        front = self._photos(self._graph())["sw"]["front"]
        self.assertIsNone(front["aspect"])
        self.assertEqual(self._ports({"front": front}), [("eth0", str(eth0.id))])

    def test_exif_quarter_turn_swaps_the_aspect(self):
        from PIL import Image

        exif = Image.Exif()
        exif[0x0112] = 6  # shown turned 90°
        dt = self._type("CAM", image=_png(400, 100, "JPEG", exif=exif.tobytes()))
        self._device("cam", dt)
        front = self._photos(self._graph())["cam"]["front"]
        self.assertAlmostEqual(front["aspect"], 4.0)

    def test_type_faceplate(self):
        tpl = self._type("TPL", image=None)
        InterfaceTemplate.objects.create(device_type=tpl, name="eth0")
        saved = self._type("SAVED", image=None, faceplate={
            "v": 1, "front": [{"id": "g1", "rows": 1, "bank": 0, "slots": []}],
            "rear": [],
        })
        rear_only = self._type("REAR", image=None, faceplate={
            "v": 1, "front": [], "rear": [{"id": "g1", "rows": 1, "bank": 0}],
        })
        InterfaceTemplate.objects.create(device_type=rear_only, name="eth0")
        bare = self._type("BARE", image=None)
        for name, dt in (("a", tpl), ("b", saved), ("c", rear_only), ("d", bare)):
            self._device(name, dt)
        photos = self._photos(self._graph())
        self.assertEqual(
            {k: photos[k]["type_faceplate"] for k in "abcd"},
            {"a": True, "b": True, "c": False, "d": False},
        )

    def test_matches_the_face_ports_endpoint(self):
        from api.viewsets import DeviceViewSet

        dt = self._type("C9300", front=[
            _marker("interface", "Gi{position}/0/1"),
            _marker("interface", "Gi{position}/0/2"),
            _marker("interface", "gi{position}/0/3 "),
            _marker("interface", "Gi{position}/0/4"),
            _marker("power-port", "Psu 1"),
        ])
        d = self._device("sw", dt, vc_position=3)
        pdu = self._device("pdu")
        cabled = [
            Interface.objects.create(device=d, name="Gi3/0/1"),
            Interface.objects.create(device=d, name="core", marker_key="Gi3/0/2"),
            Interface.objects.create(device=d, name="Gi3/0/3"),
        ]
        Interface.objects.create(device=d, name="Gi3/0/4")
        for port in cabled:
            self._to_peer(port)
        psu = PowerPort.objects.create(device=d, name="PSU 1")
        self._cable(psu, PowerOutlet.objects.create(device=pdu, name="OUT-1"))

        with mock.patch.object(DeviceViewSet, "_face_drift", return_value={}):
            face = self.client.get(f"/api/devices/{d.id}/face-ports/").json()
        expected = [(e["name"], e["id"]) for e in face["front"] if e["connected"]]
        photo = self._photos(self._graph())["sw"]
        self.assertEqual(self._ports(photo), expected)
        self.assertEqual(len(expected), 4)

    def test_never_asks_snmp(self):
        from api.viewsets import DeviceViewSet

        dt = self._type("SW", front=[_marker("interface", "eth0")])
        d = self._device("sw", dt)
        self._to_peer(Interface.objects.create(device=d, name="eth0"))
        boom = AssertionError("SNMP drift must not run for the topology")
        with mock.patch(
            "monitoring.snmp_drift.compute_device_drift", side_effect=boom
        ), mock.patch.object(DeviceViewSet, "_face_drift", side_effect=boom):
            photo = self._photos(self._graph())["sw"]
        self.assertEqual(len(photo["front"]["markers"]), 1)

    def test_group_by_ignores_photo(self):
        dt = self._type("SW", front=[_marker("interface", "eth0")])
        d = self._device("sw", dt)
        self._to_peer(Interface.objects.create(device=d, name="eth0"))
        with mock.patch.object(te, "enrich_photo") as spy:
            g = self._graph(group_by="site")
        spy.assert_not_called()
        self.assertTrue(all("photo" not in n["data"] for n in g["nodes"]))


class PhotoCostTests(_Base):
    def _measure(self):
        counted = []
        real = te.enrich_photo

        def spy(ctx):
            with CaptureQueriesContext(connection) as q:
                real(ctx)
            counted.append(len(q.captured_queries))

        with mock.patch.object(te, "enrich_photo", side_effect=spy):
            g = self._graph()
        self.assertEqual(len(counted), 1)
        return counted[0], g

    def test_cost_is_flat_in_the_node_count(self):
        types = [
            self._type(f"T{i}", front=[_marker("interface", "eth0")])
            for i in range(3)
        ]
        InterfaceTemplate.objects.create(device_type=types[0], name="eth0")
        core = self._device("core")

        def add(count, start):
            for i in range(start, start + count):
                d = self._device(f"d{i}", types[i % 3])
                self._cable(
                    Interface.objects.create(device=d, name="eth0"),
                    Interface.objects.create(device=core, name=f"e{i}"),
                )

        add(3, 0)
        small, g = self._measure()
        self.assertEqual(len(g["nodes"]), 4)
        add(27, 3)
        large, g = self._measure()
        self.assertEqual(len(g["nodes"]), 31)
        self.assertEqual(small, large)
        # The types' interface templates, then the devices' interfaces.
        self.assertLessEqual(large, 2)
        photos = self._photos(g)
        self.assertTrue(all(
            len(photos[f"d{i}"]["front"]["markers"]) == 1 for i in range(30)
        ))

    def test_aspect_is_read_once_per_file(self):
        dt = self._type("SW")
        self._device("sw", dt)
        with mock.patch.object(
            te, "_photo_measure", wraps=te._photo_measure
        ) as measure:
            self._graph()
            self._graph()
            self.assertEqual(measure.call_count, 1)
            # A new upload bumps updated_at: measured again.
            dt.front_image = SimpleUploadedFile(
                "tall.png", _png(100, 200), content_type="image/png"
            )
            dt.save()
            front = self._photos(self._graph())["sw"]["front"]
            self.assertEqual(measure.call_count, 2)
        self.assertAlmostEqual(front["aspect"], 2.0)

    def test_a_cache_outage_only_costs_a_measure(self):
        from django.core.cache.backends.locmem import LocMemCache

        dt = self._type("SW")
        self._device("sw", dt)
        down = ConnectionError("cache down")
        with mock.patch.object(LocMemCache, "get_many", side_effect=down), \
                mock.patch.object(LocMemCache, "set_many", side_effect=down):
            front = self._photos(self._graph())["sw"]["front"]
        self.assertAlmostEqual(front["aspect"], 40 / 480, places=5)
