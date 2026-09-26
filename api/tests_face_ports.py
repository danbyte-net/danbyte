"""api.face_ports: the effective marker layout, ``{position}`` rendering and
the marker → component matcher, plus the face-ports endpoint and floor-plan
scene that sit on them."""
from __future__ import annotations

from types import SimpleNamespace as NS

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .face_ports import (
    FACE_PORT_KINDS,
    ComponentIndex,
    effective_image_ports,
    render_marker_name,
)
from .models import (
    Cable,
    CableTermination,
    Device,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorTileType,
    Interface,
    InventoryItem,
    Location,
    ModuleBay,
    PowerOutlet,
    PowerPort,
    Rack,
    Site,
)
from .viewsets import DeviceViewSet

User = get_user_model()


def _marker(kind, name, x=0.5):
    return {"kind": kind, "name": name, "x": x, "y": 0.5, "w": 0.03, "h": 0.4}


class EffectiveImagePortsTests(SimpleTestCase):
    TYPE_LAYOUT = {"front": [_marker("interface", "Gi1/0/1")], "rear": []}

    def test_type_layout_when_no_override(self):
        dev = NS(image_ports=None, device_type=NS(image_ports=self.TYPE_LAYOUT))
        self.assertEqual(effective_image_ports(dev), self.TYPE_LAYOUT)

    def test_override_replaces_type_layout(self):
        own = {"front": [], "rear": [_marker("power-port", "PSU 1")]}
        dev = NS(image_ports=own, device_type=NS(image_ports=self.TYPE_LAYOUT))
        self.assertEqual(effective_image_ports(dev), own)

    def test_empty_override_does_not_inherit(self):
        dev = NS(image_ports={}, device_type=NS(image_ports=self.TYPE_LAYOUT))
        self.assertIsNone(effective_image_ports(dev))

    def test_none_without_any_layout(self):
        self.assertIsNone(effective_image_ports(NS(image_ports=None, device_type=None)))
        dev = NS(image_ports=None, device_type=NS(image_ports=None))
        self.assertIsNone(effective_image_ports(dev))


class RenderMarkerNameTests(SimpleTestCase):
    def test_position_renders_stack_member(self):
        self.assertEqual(render_marker_name("Gi{position}/0/1", 2), "Gi2/0/1")

    def test_standalone_uses_token_default(self):
        self.assertEqual(render_marker_name("Gi{position}/0/1", None), "Gi1/0/1")
        self.assertEqual(render_marker_name("Te{position:3}/1", None), "Te3/1")

    def test_plain_name_untouched(self):
        self.assertEqual(render_marker_name("PSU 1", 4), "PSU 1")


def _comp(name, marker_key=""):
    return NS(name=name, marker_key=marker_key)


class ComponentIndexTests(SimpleTestCase):
    def test_marker_key_beats_exact_name(self):
        renamed = _comp("uplink", marker_key="Gi1/0/1")
        other = _comp("Gi1/0/1")
        self.assertIs(ComponentIndex([other, renamed]).match("Gi1/0/1"), renamed)

    def test_exact_name_beats_tolerant_marker_key(self):
        keyed = _comp("uplink", marker_key="gi1/0/1")
        exact = _comp("Gi1/0/1")
        self.assertIs(ComponentIndex([keyed, exact]).match("Gi1/0/1"), exact)

    def test_tolerant_marker_key_beats_tolerant_name(self):
        keyed = _comp("renamed", marker_key="PSU 1")
        named = _comp("psu 1")
        self.assertIs(ComponentIndex([named, keyed]).match(" Psu 1 "), keyed)

    def test_tolerant_name(self):
        psu = _comp("PSU 1")
        self.assertIs(ComponentIndex([psu]).match("Psu 1"), psu)

    def test_first_component_wins_within_a_step(self):
        a, b = _comp("eth0"), _comp("eth0")
        self.assertIs(ComponentIndex([a, b]).match("eth0"), a)
        c, d = _comp("ETH1"), _comp("eth1 ")
        self.assertIs(ComponentIndex([c, d]).match("Eth1"), c)

    def test_inner_whitespace_is_significant(self):
        self.assertIsNone(ComponentIndex([_comp("PSU 1")]).match("PSU  1"))

    def test_components_without_marker_key(self):
        outlet = NS(name="OUT-1")
        index = ComponentIndex(iter([outlet]))
        self.assertIs(index.match("out-1"), outlet)
        self.assertEqual(index.components, [outlet])

    def test_no_match(self):
        self.assertIsNone(ComponentIndex([_comp("Gi1/0/1")]).match("Gi1/0/2"))
        self.assertIsNone(ComponentIndex([]).match("Gi1/0/1"))


class _TenantBase(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()


class FacePortsPayloadTests(_TenantBase):
    """The face-ports payload, pinned field for field: the resolver moved into
    api.face_ports without changing what the endpoint returns."""

    def setUp(self):
        super().setUp()
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", u_height=1,
            image_ports={
                "front": [
                    _marker("interface", "Gi{position}/0/1", 0.1),
                    _marker("interface", "Gi{position}/0/2", 0.2),
                    _marker("interface", "Gi{position}/0/48", 0.3),
                    _marker("module-bay", "Slot 1", 0.4),
                    _marker("inventory-item", "disk 1", 0.5),
                    _marker("bogus", "X", 0.6),
                ],
                "rear": [_marker("power-port", "Psu 1", 0.8)],
            },
        )
        # Stack member 2: {position} markers resolve to member 2's ports.
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt, vc_position=2
        )
        self.eth = Interface.objects.create(
            device=self.dev, name="Gi2/0/1", speed="10G"
        )
        # Renamed after stamping - the frozen marker_key still resolves it.
        self.uplink = Interface.objects.create(
            device=self.dev, name="uplink-core", marker_key="Gi2/0/2",
            label="X1", enabled=False,
        )
        self.bay = ModuleBay.objects.create(device=self.dev, name="Slot 1")
        self.disk = InventoryItem.objects.create(
            device=self.dev, name="Disk 1", kind="disk"
        )
        self.psu1 = PowerPort.objects.create(device=self.dev, name="PSU 1")
        self.psu2 = PowerPort.objects.create(device=self.dev, name="PSU 2")
        self.out = PowerOutlet.objects.create(device=self.dev, name="OUT-1")

        peer = Device.objects.create(tenant=self.tenant, name="core1")
        peer_if = Interface.objects.create(device=peer, name="Te1/1", label="Core A")
        self.cable = Cable.objects.create(tenant=self.tenant, label="C-100")
        CableTermination.objects.create(cable=self.cable, end="A", interface=self.eth)
        CableTermination.objects.create(cable=self.cable, end="B", interface=peer_if)

    def _get(self, device=None):
        device = device or self.dev
        resp = self.client.get(f"/api/devices/{device.id}/face-ports/")
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    @staticmethod
    def _blank(marker, name):
        return {
            "marker": marker, "name": name, "kind": None, "id": None,
            "connected": False, "cable_id": None, "enabled": True, "speed": "",
            "type": "", "status": None, "module": None, "drift": None,
        }

    def _cabled(self, marker, comp, kind, **over):
        entry = {
            **self._blank(marker, comp.name), "kind": kind, "id": str(comp.id),
            "cable_state": "free", "label": "", "cable_label": "", "peer": None,
            "label_hidden": False, "label_color": "",
        }
        entry.update(over)
        return entry

    def _synthetic(self, comp, kind):
        return {
            "marker": comp.name, "name": comp.name, "kind": kind,
            "id": str(comp.id), "connected": False, "cable_state": "free",
            "cable_id": None, "enabled": True, "speed": "", "type": "",
            "status": None, "module": None, "drift": None,
        }

    def test_payload_is_unchanged(self):
        body = self._get()
        self.assertEqual(body["front"], [
            self._cabled(
                "Gi{position}/0/1", self.eth, "interface", connected=True,
                cable_id=str(self.cable.id), cable_state="connected",
                speed="10G", cable_label="C-100",
                peer={"device": "core1", "port": "Te1/1", "port_label": "Core A"},
            ),
            self._cabled(
                "Gi{position}/0/2", self.uplink, "interface",
                enabled=False, label="X1",
            ),
            self._blank("Gi{position}/0/48", "Gi2/0/48"),
            {**self._blank("Slot 1", "Slot 1"), "id": str(self.bay.id)},
            {**self._blank("disk 1", "Disk 1"), "id": str(self.disk.id)},
            self._blank("X", "X"),
        ])
        self.assertEqual(body["rear"], [
            self._cabled("Psu 1", self.psu1, "power_port"),
            self._synthetic(self.psu2, "power_port"),
            self._synthetic(self.out, "power_outlet"),
        ])

    def test_bulk_matches_single(self):
        single = self._get()
        bulk = self.client.get(f"/api/devices/face-ports/?ids={self.dev.id}").json()
        self.assertEqual(bulk, {str(self.dev.id): single})

    def test_device_override_replaces_type_markers(self):
        self.dev.image_ports = {
            "front": [_marker("interface", "uplink-core")], "rear": [],
        }
        self.dev.save(update_fields=["image_ports"])
        body = self._get()
        self.assertEqual(
            [(e["marker"], e["id"]) for e in body["front"]],
            [("uplink-core", str(self.uplink.id))],
        )
        # No rear markers: every power component comes back synthetic.
        self.assertEqual(
            [e["marker"] for e in body["rear"]], ["PSU 1", "PSU 2", "OUT-1"]
        )

    def test_empty_override_hides_type_markers(self):
        self.dev.image_ports = {}
        self.dev.save(update_fields=["image_ports"])
        body = self._get()
        self.assertEqual(body["front"], [])
        self.assertEqual(
            [e["marker"] for e in body["rear"]], ["PSU 1", "PSU 2", "OUT-1"]
        )

    def test_viewset_alias(self):
        self.assertIs(DeviceViewSet._FACE_PORT_KINDS, FACE_PORT_KINDS)


class SceneImagePortsTests(_TenantBase):
    """The floor-plan scene forwards the effective layout; the 3D client
    resolves the markers itself."""

    def test_scene_forwards_effective_layout(self):
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        loc = Location.objects.create(
            tenant=self.tenant, site=site, name="Hall A", slug="hall-a"
        )
        rack = Rack.objects.create(
            tenant=self.tenant, site=site, location=loc, name="R01"
        )
        plan = FloorPlan.objects.create(tenant=self.tenant, location=loc, name="Hall A")
        tile_type = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack"
        )
        FloorPlanTile.objects.create(
            floor_plan=plan, tile_type=tile_type, x=0, y=0, rack=rack, link_kind="rack"
        )
        layout = {"front": [_marker("interface", "Gi1/0/1")], "rear": []}
        own = {"front": [_marker("interface", "eth0")], "rear": []}
        dt = DeviceType.objects.create(
            tenant=self.tenant, name="1U", u_height=1, image_ports=layout
        )
        for pos, name, override in ((1, "inherit", None), (2, "own", own), (3, "blank", {})):
            Device.objects.create(
                tenant=self.tenant, name=name, device_type=dt, rack=rack,
                position=pos, face="front", image_ports=override,
            )

        body = self.client.get(f"/api/floor-plans/{plan.id}/scene/").json()
        devs = {d["name"]: d for d in body["tiles"][0]["rack"]["devices"]}
        self.assertEqual(devs["inherit"]["image_ports"], layout)
        self.assertEqual(devs["own"]["image_ports"], own)
        self.assertIsNone(devs["blank"]["image_ports"])
