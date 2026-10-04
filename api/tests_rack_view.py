"""The rack page's Rack view (#248): one rack's port state and its 3D scene,
and the floor-plan scene that shares its geometry."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant
from monitoring.models import DeviceSnmp

from .capacity import rack_ports, rack_space
from .models import (
    VLAN,
    AuxPort,
    Cabinet,
    Cable,
    CableTermination,
    ConsolePort,
    Device,
    DeviceRole,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorTileType,
    FrontPort,
    Interface,
    IPAddress,
    Location,
    Module,
    ModuleBay,
    ModuleInterfaceTemplate,
    ModuleType,
    PortReservation,
    PowerFeed,
    PowerOutlet,
    PowerPanel,
    PowerPort,
    Prefix,
    Rack,
    RearPort,
    Site,
    Status,
    VirtualChassis,
    Zone,
)

User = get_user_model()


def _marker(kind, name, x=0.5):
    return {"kind": kind, "name": name, "x": x, "y": 0.5, "w": 0.03, "h": 0.4}


def _layout(front=(), rear=()):
    """A saved faceplate document: one group per side, a port slot per
    ``(kind, name)``."""

    def group(gid, slots):
        return {
            "id": gid, "rows": 1, "bank": 0,
            "slots": [{"t": "port", "kind": kind, "name": name} for kind, name in slots],
        }

    return {
        "v": 1,
        "front": [group("f", front)] if front else [],
        "rear": [group("r", rear)] if rear else [],
    }


class _RackBase(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self._login(self.admin)
        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall A", slug="hall-a"
        )
        self.rack = Rack.objects.create(
            tenant=self.tenant, site=self.site, location=self.loc, name="R01",
            outer_width_mm=800, outer_depth_mm=1200,
        )

    def _login(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()


class _SceneFixture(_RackBase):
    """A rack with gear on every kind of mount: front, rear, two half-width
    devices sharing a U, two 0U side strips (one fed by a power feed), a
    server whose PSU hangs off a strip outlet, and a loose device with no
    place in the rack - plus a cabinet tile and an unlinked tile."""

    def setUp(self):
        super().setUp()
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="leaf", slug="leaf", color="#3b82f6"
        )
        self.active = Status.objects.create(
            tenant=self.tenant, name="Live", slug="live", color="#10b981"
        )
        self.dt_switch = DeviceType.objects.create(
            tenant=self.tenant, name="1U Switch", u_height=1,
            airflow="front-to-rear",
            faceplate={"v": 1, "front": [], "rear": []},
            image_ports={
                "front": [_marker("interface", "Gi1/0/1", 0.1)],
                "rear": [_marker("power-port", "PSU1", 0.9)],
            },
        )
        self.dt_half = DeviceType.objects.create(
            tenant=self.tenant, name="Half switch", u_height=1, rack_width="half",
        )
        self.dt_server = DeviceType.objects.create(
            tenant=self.tenant, name="2U Server", u_height=2, is_full_depth=False,
        )
        self.dt_pdu = DeviceType.objects.create(
            tenant=self.tenant, name="Vertical PDU", u_height=0,
        )
        self.sw = Device.objects.create(
            tenant=self.tenant, name="sw-front", site=self.site,
            device_type=self.dt_switch, rack=self.rack, position=40, face="front",
            role=self.role, status=self.active, serial_number="SN-1",
            vc_position=2, port_labels="on",
        )
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.10", prefix=pfx,
            assigned_device=self.sw,
        )
        self.sw.primary_ip = ip
        self.sw.save(update_fields=["primary_ip"])
        self.srv = Device.objects.create(
            tenant=self.tenant, name="srv-rear", site=self.site,
            device_type=self.dt_server, rack=self.rack, position=30, face="rear",
            airflow="rear-to-front",
        )
        self.half_l = Device.objects.create(
            tenant=self.tenant, name="half-l", site=self.site,
            device_type=self.dt_half, rack=self.rack, position=20, face="front",
            rack_side="left",
        )
        self.half_r = Device.objects.create(
            tenant=self.tenant, name="half-r", site=self.site,
            device_type=self.dt_half, rack=self.rack, position=20, face="front",
            rack_side="right",
        )
        self.pdu_a = Device.objects.create(
            tenant=self.tenant, name="pdu-a", site=self.site,
            device_type=self.dt_pdu, rack=self.rack, mount="side_left",
            face="rear", mount_offset_mm=100, mount_span_u=38,
        )
        self.pdu_b = Device.objects.create(
            tenant=self.tenant, name="pdu-b", site=self.site,
            device_type=self.dt_pdu, rack=self.rack, mount="side_right",
        )
        Device.objects.create(
            tenant=self.tenant, name="loose", site=self.site, rack=self.rack,
        )
        self.inlet_a = PowerPort.objects.create(device=self.pdu_a, name="inlet")
        self.out_a1 = PowerOutlet.objects.create(
            device=self.pdu_a, name="C13-1", feed_leg="A"
        )
        PowerOutlet.objects.create(device=self.pdu_a, name="C13-2", feed_leg="B")
        PowerPort.objects.create(device=self.pdu_b, name="inlet-b")
        PowerOutlet.objects.create(device=self.pdu_b, name="C13-1")
        self.psu = PowerPort.objects.create(device=self.srv, name="PSU1")
        panel = PowerPanel.objects.create(
            tenant=self.tenant, site=self.site, name="PP1"
        )
        self.feed = PowerFeed.objects.create(
            tenant=self.tenant, power_panel=panel, rack=self.rack, name="Feed B",
            type="redundant", voltage=230, amperage=16,
        )
        feed_cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=feed_cable, end="A", power_feed=self.feed)
        CableTermination.objects.create(cable=feed_cable, end="B", power_port=self.inlet_a)
        cord = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cord, end="A", power_outlet=self.out_a1)
        CableTermination.objects.create(cable=cord, end="B", power_port=self.psu)

        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A",
            cell_mm=600, ceiling_mm=3000,
        )
        self.tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack", color="#64748b"
        )
        self.rack_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=2, y=3, rack=self.rack,
            link_kind="rack", label="row A",
        )
        self.cab = Cabinet.objects.create(
            tenant=self.tenant, site=self.site, name="K1",
            inner_width_mm=500, inner_height_mm=600,
        )
        Device.objects.create(
            tenant=self.tenant, name="plc-1", site=self.site, cabinet=self.cab,
        )
        self.cab_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=6, y=3, cabinet=self.cab,
            link_kind="cabinet",
        )
        self.free_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=9, y=9, label="future",
        )


# What a device carries in the scene when nothing sets it.
_GEO_BLANK = {
    "vc_position": None, "face": "", "rack_side": "", "mount": "",
    "mount_offset_mm": None, "mount_span_u": None, "u_height": 1,
    "rack_width": "full", "is_full_depth": True, "port_labels": "", "airflow": "",
    "role_color": "", "role_name": "", "status": None, "primary_ip": None,
    "serial_number": "", "front_image": None, "rear_image": None,
    "has_faceplate": False, "image_ports": None, "power_ports": [],
    "power_outlets": [], "power_legs": {}, "power_feed_type": "",
}


def _geo(dev, **over):
    return {
        "id": str(dev.id), "name": dev.name, "position": dev.position,
        **_GEO_BLANK, **over,
    }


class _PinnedScene(_SceneFixture):
    def expected_rack(self):
        """The fixture's rack as the floor-plan scene drew it before its
        geometry moved to api.scene_geo (#248), captured from that code."""
        return {
            "id": str(self.rack.id), "name": "R01", "u_height": 42,
            "starting_unit": 1, "desc_units": False, "width": 19,
            "outer_width_mm": 800, "outer_depth_mm": 1200,
            # Name order; the loose device has no place in the rack.
            "devices": [
                _geo(self.half_l, face="front", rack_side="left", rack_width="half",
                     device_type="Half switch"),
                _geo(self.half_r, face="front", rack_side="right", rack_width="half",
                     device_type="Half switch"),
                _geo(self.pdu_a, face="rear", mount="side_left", mount_offset_mm=100,
                     mount_span_u=38, u_height=0, device_type="Vertical PDU",
                     power_ports=["inlet"], power_outlets=["C13-1", "C13-2"],
                     power_legs={"C13-1": "A", "C13-2": "B"},
                     power_feed_type="redundant"),
                _geo(self.pdu_b, mount="side_right", u_height=0,
                     device_type="Vertical PDU", power_ports=["inlet-b"],
                     power_outlets=["C13-1"], power_legs={"C13-1": ""}),
                # Its PSU is corded to a strip outlet, not a feed: no feed type.
                _geo(self.srv, face="rear", u_height=2, is_full_depth=False,
                     airflow="rear-to-front", device_type="2U Server",
                     power_ports=["PSU1"]),
                _geo(self.sw, vc_position=2, face="front", port_labels="on",
                     airflow="front-to-rear", role_color="#3b82f6", role_name="leaf",
                     device_type="1U Switch",
                     status={"name": "Live", "color": "#10b981"},
                     primary_ip="10.0.0.10", serial_number="SN-1", has_faceplate=True,
                     image_ports=self.dt_switch.image_ports),
            ],
        }


class FloorPlanSceneParityTests(_PinnedScene):
    """The floor-plan scene, pinned key for key as it was before its rack,
    device, feed and cabinet geometry moved to api.scene_geo (#248)."""

    def test_scene_is_unchanged(self):
        tile = {
            "w": 1, "h": 1, "orientation": 0, "status": "", "device_name": "",
            "type_name": "Rack", "color": "#64748b", "is_zone": False,
            "perforated": False, "rack": None, "cabinet": None,
        }
        body = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        self.assertTrue(body.pop("as_of"))
        self.assertEqual(body, {
            "plan": {
                "id": str(self.plan.id), "name": "Hall A", "grid_width": 24,
                "grid_height": 16, "cell_mm": 600, "ceiling_mm": 3000,
                "background_image": None, "background_opacity": 60,
            },
            "tiles": [
                {**tile, "id": str(self.rack_tile.id), "x": 2, "y": 3,
                 "label": "row A", "kind": "rack", "rack": self.expected_rack()},
                {**tile, "id": str(self.cab_tile.id), "x": 6, "y": 3, "label": "",
                 "kind": "cabinet", "cabinet": {
                     "id": str(self.cab.id), "name": "K1", "outer_width_mm": 550,
                     "outer_height_mm": 650, "outer_depth_mm": 200,
                     "device_count": 1,
                 }},
                {**tile, "id": str(self.free_tile.id), "x": 9, "y": 9,
                 "label": "future", "kind": "other"},
            ],
            "trays": [],
            "raised_floors": [],
            "walls": [],
        })


def _grant(user, tenant, types, constraints=None):
    perm = ObjectPermission.objects.create(
        name=f"view {' '.join(types)}", object_types=list(types), actions=["view"],
        constraints=constraints,
    )
    perm.users.add(user)
    perm.tenants.add(tenant)


class _ViewerMixin:
    def _viewer(self, *grants):
        """Log in a tenant member holding ``(types, constraints)`` view grants."""
        user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for types, constraints in grants:
            _grant(user, self.tenant, types, constraints)
        self._login(user)
        return user


class RackSceneTests(_ViewerMixin, _PinnedScene):
    """GET /api/racks/{id}/scene/ - one rack for a 3D view, shaped like the
    floor-plan scene's rack tile."""

    def _scene(self):
        return self.client.get(f"/api/racks/{self.rack.id}/scene/")

    def test_the_rack_is_the_floor_plan_tiles_rack(self):
        resp = self._scene()
        self.assertEqual(resp.status_code, 200, resp.content)
        plan = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        self.assertEqual(resp.json(), plan["tiles"][0]["rack"])
        self.assertEqual(resp.json(), self.expected_rack())

    def test_only_the_devices_the_caller_may_view(self):
        self._viewer((["rack"], None), (["device"], {"name__startswith": "pdu-"}))
        body = self._scene().json()
        self.assertEqual([d["name"] for d in body["devices"]], ["pdu-a", "pdu-b"])
        self.assertEqual(body["devices"][0]["power_feed_type"], "redundant")

    def test_gated_on_rack_view(self):
        self._viewer((["device"], None))
        self.assertEqual(self._scene().status_code, 403)

    def test_another_tenants_rack_is_not_found(self):
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        site = Site.objects.create(tenant=other, name="LON")
        theirs = Rack.objects.create(tenant=other, site=site, name="X01")
        for path in ("scene", "port-state"):
            resp = self.client.get(f"/api/racks/{theirs.id}/{path}/")
            self.assertEqual(resp.status_code, 404, path)


def _set_count_virtual(on: bool) -> None:
    from core.models import DeploymentSettings

    ds = DeploymentSettings.load()
    ds.port_count_virtual = on
    ds.save()


class _PortFixture(_ViewerMixin, _RackBase):
    """Two switches cabled to each other and to a core outside the rack, a
    patch panel and a PDU strip whose outlet cords the first switch."""

    def setUp(self):
        super().setUp()
        self.planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned", color="#f59e0b"
        )
        dt_switch = DeviceType.objects.create(
            tenant=self.tenant, name="48P", u_height=1,
            image_ports={
                "front": [
                    _marker("interface", "Gi1/0/1", 0.1),
                    _marker("interface", "Gi1/0/2", 0.2),
                ],
                "rear": [_marker("power-port", "PSU1", 0.9)],
            },
            # A saved layout that places the console port beside the ports.
            faceplate=_layout(
                front=[("interface", "Gi1/0/1"), ("console-port", "CON")]
            ),
        )
        dt_panel = DeviceType.objects.create(tenant=self.tenant, name="Panel", u_height=1)
        dt_strip = DeviceType.objects.create(tenant=self.tenant, name="Strip", u_height=0)

        def racked(name, dt, **placement):
            return Device.objects.create(
                tenant=self.tenant, name=name, site=self.site, device_type=dt,
                rack=self.rack, **placement,
            )

        self.sw1 = racked("sw-1", dt_switch, position=40, face="front")
        self.sw2 = racked("sw-2", dt_switch, position=39, face="front")
        self.panel = racked("panel-1", dt_panel, position=38, face="front")
        self.pdu = racked("pdu-1", dt_strip, mount="side_left")
        self.core = Device.objects.create(tenant=self.tenant, name="core-1", site=self.site)

        zone = Zone.objects.create(tenant=self.tenant, name="dmz", slug="dmz", color="#ef4444")
        v10 = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="users", zone=zone)
        v20 = VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="voice")
        v30 = VLAN.objects.create(tenant=self.tenant, vlan_id=30, name="mgmt")
        po1 = Interface.objects.create(device=self.sw1, name="Po1", type="lag")
        Interface.objects.create(device=self.sw1, name="Vlan10", virtual=True)
        self.up = Interface.objects.create(
            device=self.sw1, name="Gi1/0/1", type="1000base-t", speed="1G",
            label="uplink", lag=po1, hide_label=True, label_color="#ffffff",
            description="to sw-2", mac_address="00:11:22:33:44:55", mtu=9000,
        )
        self.trunk = Interface.objects.create(
            device=self.sw1, name="Gi1/0/2", speed="10G", mode="tagged", vlan=v10
        )
        self.trunk.tagged_vlans.set([v20, v30])
        held = Interface.objects.create(device=self.sw1, name="Gi1/0/3")
        PortReservation.objects.create(tenant=self.tenant, interface=held)
        Interface.objects.create(device=self.sw1, name="Gi1/0/4", mark_connected=True)
        Interface.objects.create(
            device=self.sw1, name="Gi1/0/5", enabled=False, mode="access", vlan=v10
        )
        peer = Interface.objects.create(device=self.sw2, name="Gi1/0/1", label="from sw-1")
        Interface.objects.create(device=self.sw2, name="Gi1/0/2")
        self._cable({"interface": self.up}, {"interface": peer}, label="L1", type="cat6")
        core_port = Interface.objects.create(device=self.core, name="Te1/1")
        self._cable({"interface": self.trunk}, {"interface": core_port}, type="smf")
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=pfx,
            assigned_device=self.sw1, assigned_interface=self.up,
        )
        self.up.tags.add(
            Tag.objects.create(tenant=self.tenant, name="prod", slug="prod", color="#10b981")
        )
        rear = RearPort.objects.create(device=self.panel, name="RP1", positions=2)
        FrontPort.objects.create(device=self.panel, name="FP1", rear_port=rear)
        FrontPort.objects.create(device=self.panel, name="FP2", rear_port=rear)
        psu = PowerPort.objects.create(device=self.sw1, name="PSU1")
        PowerPort.objects.create(device=self.pdu, name="inlet")
        outlet = PowerOutlet.objects.create(device=self.pdu, name="C13-1")
        self._cable({"power_outlet": outlet}, {"power_port": psu})
        self.console = ConsolePort.objects.create(device=self.sw1, name="CON", type="rj-45")
        self.aux = AuxPort.objects.create(device=self.sw1, name="AUX")
        # A line card in bay "2" whose own layout places an aux port.
        card = ModuleType.objects.create(
            tenant=self.tenant, name="NM-1X",
            faceplate=_layout(front=[("interface", "Te1/{module}/1"), ("aux-port", "AUX")]),
        )
        ModuleInterfaceTemplate.objects.create(
            module_type=card, name="Te1/{module}/1", type="10gbase-x-sfpp"
        )
        bay = ModuleBay.objects.create(device=self.sw1, name="Slot 2", position="2")
        self.module = Module.objects.create(
            device=self.sw1, module_bay=bay, module_type=card, serial_number="M-1"
        )

    def _cable(self, a, b, **kwargs):
        cable = Cable.objects.create(tenant=self.tenant, **kwargs)
        CableTermination.objects.create(cable=cable, end="A", **a)
        CableTermination.objects.create(cable=cable, end="B", **b)
        return cable

    def _state(self, rack=None):
        resp = self.client.get(f"/api/racks/{(rack or self.rack).id}/port-state/")
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()


def _expected_cable_state(row):
    """The frontend's cableState() over an /interfaces/ row."""
    if row["cable"]:
        status = row["cable"]["status"] or {}
        return "reserved" if status.get("slug") == "planned" else "connected"
    if row["mark_connected"]:
        return "marked"
    return "reserved" if row["reservation"] else "free"


class RackPortStateTests(_PortFixture):
    """GET /api/racks/{id}/port-state/ - every port in the rack at once."""

    def test_rack_figures_match_the_rack_page(self):
        body = self._state()
        page = self.client.get(f"/api/racks/{self.rack.id}/").json()
        self.assertEqual(body["rack"], {
            "id": str(self.rack.id), "u_height": 42, "u_used": page["used_units"],
            "u_free": 42 - page["used_units"], "power": page["power"],
            # Gi1/0/1-5 on sw-1, both of sw-2's ports and the panel's two
            # front ports; not the LAG, the SVI or the panel's rear.
            "ports": {"total": 9, "connected": 4, "reserved": 1, "free": 4, "marked": 1},
            "count_virtual": False,
        })
        self.assertEqual(page["used_units"], 3)

    def test_device_rows_match_the_device_cards_and_face_ports(self):
        body = self._state()
        devices = [self.sw1, self.sw2, self.panel, self.pdu]
        self.assertEqual(set(body["devices"]), {str(d.id) for d in devices})
        ids = ",".join(str(d.id) for d in devices)
        face = self.client.get(f"/api/devices/face-ports/?ids={ids}").json()
        for dev in devices:
            row = body["devices"][str(dev.id)]
            card = self.client.get(f"/api/devices/{dev.id}/port-utilization/").json()
            self.assertEqual(row["ports"], card["combined"], dev.name)
            self.assertEqual(row["face"], face[str(dev.id)], dev.name)
        self.assertEqual(
            body["devices"][str(self.pdu.id)]["ports"],
            {"total": 0, "connected": 0, "reserved": 0, "free": 0, "marked": 0},
        )

    def test_interfaces_carry_what_the_faceplate_reads(self):
        """Every value an /interfaces/ row gives the drawn faceplate, for the
        physical ports only - the LAG and the SVI are not drawn."""
        body = self._state()
        listed = body["devices"][str(self.sw1.id)]["interfaces"]
        self.assertEqual(
            [i["name"] for i in listed], ["Gi1/0/1", "Gi1/0/2", "Gi1/0/3", "Gi1/0/4", "Gi1/0/5"]
        )
        rows = {
            r["id"]: r
            for r in self.client.get(f"/api/devices/{self.sw1.id}/interfaces/").json()["results"]
        }
        same = (
            "id", "name", "label", "type", "type_display", "speed", "enabled", "mode",
            "mark_connected", "hide_label", "label_color", "description", "mac_address",
            "mtu", "ip_addresses", "tags",
        )
        for entry in listed:
            row = rows[entry["id"]]
            for key in same:
                self.assertEqual(entry[key], row[key], f"{entry['name']}.{key}")
            self.assertEqual(entry["cable_state"], _expected_cable_state(row), entry["name"])
            cable = row["cable"] or {}
            self.assertEqual(entry["cable_id"], cable.get("id"))
            self.assertEqual(entry["cable_label"], cable.get("label", ""))
            self.assertEqual(entry["cable_type"], cable.get("type", ""))
            self.assertEqual(entry["peer"], row["link_peer"])
            self.assertEqual(entry["tagged_vlan_count"], len(row["tagged_vlans"]))
            lag = row["lag"]
            self.assertEqual(entry["lag"], lag and {"id": lag["id"], "name": lag["name"]})
            vlan = row["vlan"]
            mini = ("id", "vlan_id", "name", "color", "zone")
            self.assertEqual(entry["vlan"], vlan and {k: vlan[k] for k in mini})
        up = listed[0]
        self.assertEqual(
            (up["cable_state"], up["cable_label"], up["peer"], up["lag"]["name"]),
            ("connected", "L1", {"device": "sw-2", "port": "Gi1/0/1", "port_label": "from sw-1"},
             "Po1"),
        )
        self.assertEqual(up["ip_addresses"][0]["ip_address"], "10.0.0.5")
        trunk = listed[1]
        self.assertEqual((trunk["tagged_vlan_count"], trunk["vlan"]["vlan_id"]), (2, 10))
        self.assertEqual(
            [i["cable_state"] for i in listed],
            ["connected", "connected", "reserved", "marked", "free"],
        )

    def test_modules_and_placed_components_as_the_device_page_lists_them(self):
        """What the drawn faceplate composes besides the interfaces - the
        installed modules, and the components its saved layout (or a
        module's) places - as the device page's own requests give them."""
        body = self._state()
        sw1 = body["devices"][str(self.sw1.id)]
        listed = self.client.get(f"/api/modules/?device={self.sw1.id}").json()["results"]
        keys = ("id", "module_bay", "module_type_faceplate", "module_interfaces")
        self.assertEqual(sw1["modules"], [{k: m[k] for k in keys} for m in listed])
        self.assertEqual(
            sw1["modules"][0]["module_interfaces"],
            [{"name": "Te1/2/1", "type": "10gbase-x-sfpp"}],
        )
        for kind, path in (("console-port", "console-ports"), ("aux-port", "aux-ports")):
            rows = self.client.get(f"/api/{path}/?device={self.sw1.id}").json()["results"]
            self.assertEqual(
                sw1["components"][kind],
                [{"id": r["id"], "name": r["name"], "type": r["type"]} for r in rows],
                kind,
            )
        self.assertEqual(sw1["components"]["console-port"][0]["type"], "rj-45")
        # Only the kinds a layout places: sw-1's PSU stays out.
        self.assertEqual(set(sw1["components"]), {"console-port", "aux-port"})
        # sw-2 shares the layout but has no console port; the panel places nothing.
        for dev in (self.sw2, self.panel):
            row = body["devices"][str(dev.id)]
            self.assertEqual((row["modules"], row["components"]), ([], {}), dev.name)

    def test_modules_and_components_follow_their_grants(self):
        user = self._viewer((["rack"], None), (["device"], None), (["interface"], None))
        sw1 = self._state()["devices"][str(self.sw1.id)]
        self.assertEqual((sw1["modules"], sw1["components"]), ([], {}))
        _grant(user, self.tenant, ["module"])
        _grant(user, self.tenant, ["consoleport", "auxport"], {"name": "CON"})
        sw1 = self._state()["devices"][str(self.sw1.id)]
        self.assertEqual([m["id"] for m in sw1["modules"]], [str(self.module.id)])
        self.assertEqual(list(sw1["components"]), ["console-port"])

    def test_observed_says_whose_ports_snmp_may_have_seen(self):
        """A page asks for a device's live port state only where SNMP may
        have seen its ports: polled with interfaces, or a stack member."""
        now = timezone.now()
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.sw1, polled_at=now,
            interfaces=[{"name": "Gi1/0/1", "oper_status": "up"}],
        )
        # Polled, nothing seen; and seen once, never polled since.
        DeviceSnmp.objects.create(tenant=self.tenant, device=self.panel, polled_at=now)
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.pdu, interfaces=[{"name": "inlet"}]
        )
        # A stack member: its stack's poll may describe it.
        self.sw2.virtual_chassis = VirtualChassis.objects.create(
            tenant=self.tenant, name="stack-1"
        )
        self.sw2.vc_position = 2
        self.sw2.save(update_fields=["virtual_chassis", "vc_position"])
        devices = self._state()["devices"]
        self.assertEqual(
            {d.name: devices[str(d.id)]["observed"]
             for d in (self.sw1, self.sw2, self.panel, self.pdu)},
            {"sw-1": True, "sw-2": True, "panel-1": False, "pdu-1": False},
        )

    def test_counting_virtual_interfaces(self):
        _set_count_virtual(True)
        body = self._state()
        self.assertTrue(body["rack"]["count_virtual"])
        # The LAG and the SVI join sw-1's count, both free.
        self.assertEqual(
            body["devices"][str(self.sw1.id)]["ports"],
            {"total": 7, "connected": 3, "reserved": 1, "free": 3, "marked": 1},
        )
        self.assertEqual(body["rack"]["ports"]["total"], 11)
        # Still only the drawn ports in the list.
        self.assertEqual(len(body["devices"][str(self.sw1.id)]["interfaces"]), 5)

    def test_a_viewer_sees_only_what_they_may_view(self):
        self._viewer(
            (["rack"], None), (["device"], {"name__startswith": "sw-"}),
            (["interface", "powerport"], None),
        )
        body = self._state()
        self.assertEqual(set(body["devices"]), {str(self.sw1.id), str(self.sw2.id)})
        # The rack's figures still count every device in it, as U and power do.
        self.assertEqual(body["rack"]["ports"]["total"], 9)
        sw1 = body["devices"][str(self.sw1.id)]
        listed = {i["name"]: i for i in sw1["interfaces"]}
        # sw-2 may be viewed, the core and the PDU may not.
        self.assertEqual(listed["Gi1/0/1"]["peer"]["device"], "sw-2")
        self.assertIsNone(listed["Gi1/0/2"]["peer"])
        self.assertEqual(listed["Gi1/0/2"]["cable_state"], "connected")
        # No IP address grant: the uplink's address is not listed.
        self.assertEqual(listed["Gi1/0/1"]["ip_addresses"], [])
        face = {e["marker"]: e for e in sw1["face"]["front"] + sw1["face"]["rear"]}
        self.assertEqual(face["Gi1/0/1"]["peer"]["device"], "sw-2")
        self.assertIsNone(face["Gi1/0/2"]["peer"])
        self.assertIsNone(face["PSU1"]["peer"])
        self.assertTrue(face["PSU1"]["connected"])

    def test_interfaces_follow_the_interface_grant(self):
        self._viewer(
            (["rack"], None), (["device"], None), (["interface"], {"name": "Gi1/0/1"}),
        )
        sw1 = self._state()["devices"][str(self.sw1.id)]
        self.assertEqual([i["name"] for i in sw1["interfaces"]], ["Gi1/0/1"])
        face = {e["marker"]: e for e in sw1["face"]["front"]}
        self.assertEqual(face["Gi1/0/1"]["id"], str(self.up.id))
        self.assertIsNone(face["Gi1/0/2"]["id"])

    def test_photo_markers_follow_each_ports_grant(self):
        user = self._viewer((["rack"], None), (["device"], None), (["interface"], None))
        sw1, pdu = str(self.sw1.id), str(self.pdu.id)

        def faces():
            rack = self._state()["devices"]
            bulk = self.client.get(f"/api/devices/face-ports/?ids={sw1},{pdu}").json()
            one = self.client.get(f"/api/devices/{sw1}/face-ports/").json()
            return [(rack[sw1]["face"], rack[pdu]["face"]), (bulk[sw1], bulk[pdu]),
                    (one, None)]

        for sw_face, pdu_face in faces():
            psu = next(e for e in sw_face["rear"] if e["marker"] == "PSU1")
            self.assertEqual((psu["id"], psu["cable_id"], psu.get("peer")), (None, None, None))
            if pdu_face is not None:
                self.assertEqual(pdu_face["rear"], [])
        _grant(user, self.tenant, ["powerport", "poweroutlet"])
        for sw_face, pdu_face in faces():
            psu = next(e for e in sw_face["rear"] if e["marker"] == "PSU1")
            self.assertTrue(psu["id"] and psu["cable_id"])
            if pdu_face is not None:
                self.assertEqual({e["name"] for e in pdu_face["rear"]}, {"inlet", "C13-1"})

    def test_gated_on_rack_view(self):
        self._viewer((["device"], None), (["interface"], None))
        resp = self.client.get(f"/api/racks/{self.rack.id}/port-state/")
        self.assertEqual(resp.status_code, 403)

    def test_without_a_device_grant_only_the_rack_figures(self):
        self._viewer((["rack"], None))
        body = self._state()
        self.assertEqual(body["devices"], {})
        self.assertEqual(body["rack"]["ports"]["total"], 9)


class RackPortStateQueryTests(_ViewerMixin, _RackBase):
    """The port-state query count does not grow with the devices in the rack."""

    def setUp(self):
        super().setUp()
        self.planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned", color="#f59e0b"
        )
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="24P", u_height=1,
            image_ports={
                "front": [_marker("interface", f"Gi1/0/{i}", i / 10) for i in range(1, 5)],
                "rear": [_marker("power-port", "PSU1", 0.9)],
            },
            faceplate=_layout(front=[("interface", "Gi1/0/1"), ("console-port", "CON")]),
        )
        self.card = ModuleType.objects.create(
            tenant=self.tenant, name="NM-1X",
            faceplate=_layout(front=[("interface", "Te1/{module}/1"), ("aux-port", "AUX")]),
        )
        for n in (1, 2):
            ModuleInterfaceTemplate.objects.create(
                module_type=self.card, name=f"Te1/{{module}}/{n}", type="10gbase-x-sfpp"
            )
        self.strip = DeviceType.objects.create(tenant=self.tenant, name="Strip", u_height=0)
        self.core = Device.objects.create(tenant=self.tenant, name="core", site=self.site)
        zone = Zone.objects.create(tenant=self.tenant, name="dmz", slug="dmz")
        self.vlans = [
            VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="users", zone=zone),
            VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="voice"),
        ]
        self.tag = Tag.objects.create(tenant=self.tenant, name="prod", slug="prod")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/16")
        self.addresses = 0

    def _cable(self, a, b, **kwargs):
        cable = Cable.objects.create(tenant=self.tenant, **kwargs)
        CableTermination.objects.create(cable=cable, end="A", **a)
        CableTermination.objects.create(cable=cable, end="B", **b)

    def _rack(self, name, n):
        """A rack of ``n`` switches, each with a cabled port in a VLAN, a LAG
        and a tag with an address, a trunk on a planned cable, a held port,
        a PSU corded to the rack's PDU, a console port its layout places and
        a line card whose own layout places an aux port."""
        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name=name)
        pdu = Device.objects.create(
            tenant=self.tenant, name=f"{name}-pdu", site=self.site, device_type=self.strip,
            rack=rack, mount="side_left",
        )
        for i in range(n):
            dev = Device.objects.create(
                tenant=self.tenant, name=f"{name}-sw{i}", site=self.site,
                device_type=self.dt, rack=rack, position=i + 1, face="front",
            )
            lag = Interface.objects.create(device=dev, name="Po1", type="lag")
            ports = [Interface.objects.create(device=dev, name=f"Gi1/0/{p}") for p in range(1, 5)]
            ports[0].vlan, ports[0].lag = self.vlans[0], lag
            ports[0].save(update_fields=["vlan", "lag"])
            ports[0].tags.add(self.tag)
            self.addresses += 1
            IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"10.0.{self.addresses // 250}."
                f"{self.addresses % 250 + 1}", prefix=self.prefix,
                assigned_device=dev, assigned_interface=ports[0],
            )
            ports[1].mode = "tagged"
            ports[1].save(update_fields=["mode"])
            ports[1].tagged_vlans.set(self.vlans)
            far = Interface.objects.create(device=self.core, name=f"{name}-{i}-a")
            self._cable({"interface": ports[0]}, {"interface": far})
            far = Interface.objects.create(device=self.core, name=f"{name}-{i}-b")
            self._cable({"interface": ports[1]}, {"interface": far}, status=self.planned)
            PortReservation.objects.create(tenant=self.tenant, interface=ports[2])
            psu = PowerPort.objects.create(device=dev, name="PSU1")
            outlet = PowerOutlet.objects.create(device=pdu, name=f"C13-{i}")
            self._cable({"power_outlet": outlet}, {"power_port": psu})
            ConsolePort.objects.create(device=dev, name="CON")
            AuxPort.objects.create(device=dev, name="AUX")
            bay = ModuleBay.objects.create(device=dev, name="Slot 1", position="1")
            Module.objects.create(device=dev, module_bay=bay, module_type=self.card)
            if i % 2 == 0:
                DeviceSnmp.objects.create(
                    tenant=self.tenant, device=dev, polled_at=timezone.now(),
                    interfaces=[{"name": "Gi1/0/1", "oper_status": "up"}],
                )
        return rack

    def _counts(self, racks):
        # The first request of a run also loads the session idle timeout.
        self.client.get(f"/api/racks/{racks[0].id}/port-state/")
        counts = []
        for rack in racks:
            with CaptureQueriesContext(connection) as ctx:
                resp = self.client.get(f"/api/racks/{rack.id}/port-state/")
            self.assertEqual(resp.status_code, 200, resp.content)
            counts.append(len(ctx.captured_queries))
        return counts, resp.json()

    def test_flat_for_2_and_12_devices(self):
        racks = (self._rack("small", 2), self._rack("big", 12))
        counts, body = self._counts(racks)
        self.assertEqual(len(body["devices"]), 13)
        self.assertEqual(counts[0], counts[1], counts)
        sw = next(d for d in body["devices"].values() if d["modules"])
        self.assertEqual(set(sw["components"]), {"console-port", "aux-port"})
        self.assertEqual(len(sw["modules"][0]["module_interfaces"]), 2)
        self.assertEqual(sum(d["observed"] for d in body["devices"].values()), 6)

        # And for a viewer whose grants are narrowed by constraints.
        self._viewer(
            (["rack"], None), (["device"], {"name__contains": "-sw"}),
            (["interface"], {"enabled": True}), (["ipaddress"], None),
            (["module"], None), (["consoleport", "auxport"], {"name__in": ["CON", "AUX"]}),
        )
        counts, body = self._counts(racks)
        self.assertEqual(len(body["devices"]), 12)
        self.assertEqual(counts[0], counts[1], counts)


class CapacityHelperTests(_SceneFixture):
    def test_space_matches_the_rack_serializer(self):
        page = self.client.get(f"/api/racks/{self.rack.id}/").json()
        # 1U switch, 2U server, two half-width devices sharing a U; the 0U
        # strips and the loose device take none.
        self.assertEqual(rack_space(self.rack), {"u_height": 42, "u_used": 4, "u_free": 38})
        self.assertEqual(page["used_units"], 4)

    def test_ports_sum_the_devices(self):
        Interface.objects.create(device=self.sw, name="Gi1/0/1")
        Interface.objects.create(device=self.srv, name="eno1")
        Interface.objects.create(device=self.srv, name="eno2", mark_connected=True)
        out = rack_ports(Device.objects.filter(rack=self.rack), count_virtual=False)
        self.assertEqual(out["devices"][self.sw.id]["total"], 1)
        self.assertEqual(
            out["devices"][self.srv.id],
            {"total": 2, "connected": 1, "reserved": 0, "free": 1, "marked": 1},
        )
        self.assertNotIn(self.pdu_a.id, out["devices"])
        self.assertEqual(
            out["total"], {"total": 3, "connected": 1, "reserved": 0, "free": 2, "marked": 1}
        )
