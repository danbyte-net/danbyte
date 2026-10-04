"""api.face_ports: the effective marker layout, ``{position}`` rendering and
the marker → component matcher, plus the face-ports endpoint and floor-plan
scene that sit on them."""
from __future__ import annotations

from types import SimpleNamespace as NS
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .face_ports import (
    FACE_PORT_KINDS,
    ComponentIndex,
    effective_image_ports,
    render_marker_name,
)
from .models import (
    Antenna,
    Cable,
    CableTermination,
    ConsolePort,
    ConsoleServerPort,
    Device,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorTileType,
    Interface,
    InventoryItem,
    Location,
    Module,
    ModuleBay,
    ModuleType,
    PortReservation,
    PowerOutlet,
    PowerPort,
    Rack,
    Site,
    Status,
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


class FacePortsBulkTests(_TenantBase):
    """GET /api/devices/face-ports/?ids= resolves every device together
    (api.port_state.FacePortLoader): the entries each device's own face-ports
    gives, drift aside, in a number of queries that does not grow with the
    devices asked for (#248)."""

    def setUp(self):
        super().setUp()
        self.planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned", color="#f59e0b"
        )
        self.failed = Status.objects.create(
            tenant=self.tenant, name="Failed", slug="failed", color="#ef4444"
        )
        self.module_type = ModuleType.objects.create(tenant=self.tenant, name="NM-8X")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", u_height=1,
            image_ports={
                "front": [
                    _marker("interface", "Gi{position}/0/1", 0.1),
                    _marker("interface", "Gi{position}/0/2", 0.2),
                    _marker("interface", "Gi{position}/0/3", 0.3),
                    _marker("interface", "Gi{position}/0/4", 0.4),
                    _marker("interface", "Gi{position}/0/9", 0.45),
                    _marker("console-port", "con0", 0.5),
                    _marker("module-bay", "Slot 1", 0.6),
                    _marker("inventory-item", "disk 1", 0.7),
                ],
                "rear": [_marker("power-port", "PSU1", 0.9)],
            },
        )
        # The far ends live off the switches: a core, a console server and
        # a PDU whose outlets cord the switches' first PSU.
        self.core = Device.objects.create(tenant=self.tenant, name="core1")
        self.console = Device.objects.create(tenant=self.tenant, name="cons1")
        self.pdu = Device.objects.create(tenant=self.tenant, name="pdu1")

    def _cable(self, a, b, **kwargs):
        cable = Cable.objects.create(tenant=self.tenant, **kwargs)
        CableTermination.objects.create(cable=cable, end="A", **a)
        CableTermination.objects.create(cable=cable, end="B", **b)
        return cable

    def _switch(self, n):
        """A switch with every kind of marker the type draws: a cabled port, a
        planned cable, a held port, an undocumented one, a console port on a
        console server, an installed module, a failed disk, a PSU corded to the
        PDU, and a PSU and an outlet no marker covers."""
        dev = Device.objects.create(
            tenant=self.tenant, name=f"sw{n:02}", device_type=self.dt, vc_position=1
        )
        ports = [
            Interface.objects.create(device=dev, name=f"Gi1/0/{i}", speed="1G")
            for i in range(1, 6)
        ]
        uplink = Interface.objects.create(
            device=self.core, name=f"Te1/{n}", label=f"to sw{n}"
        )
        self._cable({"interface": ports[0]}, {"interface": uplink}, label=f"C{n}")
        spare = Interface.objects.create(device=self.core, name=f"Te2/{n}")
        self._cable({"interface": ports[1]}, {"interface": spare}, status=self.planned)
        PortReservation.objects.create(tenant=self.tenant, interface=ports[2])
        ports[3].mark_connected = True
        ports[3].save(update_fields=["mark_connected"])
        con = ConsolePort.objects.create(device=dev, name="con0")
        line = ConsoleServerPort.objects.create(device=self.console, name=f"line{n}")
        self._cable({"console_port": con}, {"console_server_port": line})
        bay = ModuleBay.objects.create(device=dev, name="Slot 1")
        Module.objects.create(
            device=dev, module_bay=bay, module_type=self.module_type,
            serial_number=f"M{n}",
        )
        InventoryItem.objects.create(
            device=dev, name="Disk 1", kind="disk", status=self.failed
        )
        psu = PowerPort.objects.create(device=dev, name="PSU1")
        PowerPort.objects.create(device=dev, name="PSU2")
        PowerOutlet.objects.create(device=dev, name="OUT-1")
        outlet = PowerOutlet.objects.create(device=self.pdu, name=f"C13-{n}")
        self._cable({"power_outlet": outlet}, {"power_port": psu})
        return dev

    def _bulk(self, devices, query=""):
        ids = ",".join(str(d.id) for d in devices)
        resp = self.client.get(f"/api/devices/face-ports/?ids={ids}{query}")
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def test_bulk_matches_each_devices_own_face_ports(self):
        devices = [self._switch(n) for n in (1, 2, 3)]
        bulk = self._bulk(devices)
        self.assertEqual(set(bulk), {str(d.id) for d in devices})
        for dev in devices:
            single = self.client.get(f"/api/devices/{dev.id}/face-ports/").json()
            for entry in single["front"] + single["rear"]:
                entry["drift"] = None
            self.assertEqual(bulk[str(dev.id)], single)

        # And what it resolved, for one of them.
        body = bulk[str(devices[1].id)]
        front = {e["marker"]: e for e in body["front"]}
        cabled = front["Gi{position}/0/1"]
        self.assertEqual(
            (cabled["cable_state"], cabled["cable_label"], cabled["peer"]),
            ("connected", "C2", {"device": "core1", "port": "Te1/2", "port_label": "to sw2"}),
        )
        self.assertEqual(
            [front[f"Gi{{position}}/0/{i}"]["cable_state"] for i in (2, 3, 4)],
            ["reserved", "reserved", "marked"],
        )
        self.assertIsNone(front["Gi{position}/0/9"]["id"])
        self.assertEqual(
            front["con0"]["peer"], {"device": "cons1", "port": "line2", "port_label": ""}
        )
        self.assertEqual(front["Slot 1"]["module"]["serial_number"], "M2")
        self.assertEqual(front["disk 1"]["status"]["name"], "Failed")
        rear = {e["marker"]: e for e in body["rear"]}
        self.assertEqual(
            rear["PSU1"]["peer"], {"device": "pdu1", "port": "C13-2", "port_label": ""}
        )
        # The PSU and the outlet no marker covers, as synthetic entries.
        self.assertEqual(list(rear), ["PSU1", "PSU2", "OUT-1"])
        self.assertTrue(all(e["drift"] is None for e in body["front"] + body["rear"]))

    def test_queries_do_not_grow_with_the_devices(self):
        devices = [self._switch(n) for n in range(1, 13)]
        # The first request of a run also loads the session idle timeout.
        self._bulk(devices[:1])
        counts = []
        for batch in (devices[:2], devices):
            with CaptureQueriesContext(connection) as ctx:
                body = self._bulk(batch)
            self.assertEqual(len(body), len(batch))
            counts.append(len(ctx.captured_queries))
        self.assertEqual(counts[0], counts[1], counts)

    def test_drift_only_when_asked(self):
        dev = self._switch(1)
        psu = dev.power_ports.get(name="PSU2")
        with mock.patch.object(
            DeviceViewSet, "_face_drift", return_value={str(psu.id): "not reported by SNMP"}
        ) as drift:
            plain = self._bulk([dev])[str(dev.id)]
            drift.assert_not_called()
            asked = self._bulk([dev], "&drift=1")[str(dev.id)]
        self.assertTrue(all(e["drift"] is None for e in plain["rear"]))
        self.assertEqual(
            {e["name"]: e["drift"] for e in asked["rear"]},
            {"PSU1": None, "PSU2": "not reported by SNMP", "OUT-1": None},
        )

    def test_antenna_markers_resolve(self):
        """An antenna marker is a part with no status: it used to break the
        whole payload, now it resolves like a status-less hardware marker."""
        dt = DeviceType.objects.create(
            tenant=self.tenant, name="AP", u_height=0,
            image_ports={"front": [_marker("antenna", "ANT1")], "rear": []},
        )
        dev = Device.objects.create(tenant=self.tenant, name="ap1", device_type=dt)
        antenna = Antenna.objects.create(device=dev, name="ANT1")
        single = self.client.get(f"/api/devices/{dev.id}/face-ports/").json()
        entry = single["front"][0]
        self.assertEqual(
            (entry["id"], entry["kind"], entry["status"]), (str(antenna.id), None, None)
        )
        self.assertEqual(self._bulk([dev])[str(dev.id)], single)
