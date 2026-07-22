"""NetBox importer — driven by a fake client returning canned NetBox JSON.

The importer had zero tests, which is how the tag-tenancy regression (tags
became tenant-scoped; the importer still created them global) shipped
unnoticed. These pin the correctness fixes and the high-value coverage.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase

from api import models as m
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tag, Tenant
from integrations.management.commands.import_netbox import (
    Command,
    NetBoxClient,
    _Importer,
)


class FakeClient:
    """Serves canned NetBox rows keyed by API path; no network."""

    def __init__(self, data: dict):
        self.data = data

    def list(self, path: str, on_page=None) -> list[dict]:
        rows = self.data.get(path.strip("/"), [])
        if on_page is not None:
            on_page(len(rows))
        return rows

    def get_bytes(self, url: str) -> bytes:
        return b""


def _quiet_cmd():
    cmd = Command()
    cmd.stdout = type("S", (), {"write": lambda self, m="": None})()
    return cmd


def run_import(tenant, data, **opts):
    base = {
        "only": set(), "skip": set(), "with_images": False,
        "dry_run": False, "update_existing": False,
    }
    base.update(opts)
    imp = _Importer(_quiet_cmd(), FakeClient(data), tenant, base)
    imp.run()
    return imp


# A small but cross-referential NetBox graph.
GRAPH = {
    "dcim/manufacturers": [{"id": 1, "name": "Cisco", "slug": "cisco"}],
    "dcim/sites": [{
        "id": 1, "name": "HQ", "physical_address": "1 Main St",
        "tags": [{"name": "prod", "slug": "prod", "color": "ff0000"}],
    }],
    "dcim/device-types": [{
        "id": 1, "model": "C9300", "manufacturer": {"id": 1}, "u_height": 1,
        "airflow": "front-to-rear", "weight": 5.0, "weight_unit": "kg",
        "subdevice_role": "", "exclude_from_utilization": False,
    }],
    "dcim/devices": [{
        "id": 1, "name": "sw1", "device_type": {"id": 1}, "site": {"id": 1},
        "airflow": "front-to-rear", "latitude": "55.6", "longitude": "12.5",
        "tags": [{"name": "prod", "slug": "prod"}],
    }],
    "dcim/interfaces": [
        {"id": 1, "name": "Po1", "device": {"id": 1}, "type": {"value": "lag"}},
        {"id": 2, "name": "Gi0/1", "device": {"id": 1},
         "type": {"value": "1000base-t"}, "lag": {"id": 1},
         "speed": 1000000, "duplex": {"value": "full"}, "mgmt_only": False},
        {"id": 3, "name": "Gi0/1.100", "device": {"id": 1},
         "type": {"value": "virtual"}, "parent": {"id": 2}},
    ],
    "dcim/power-panels": [{"id": 1, "name": "PP1", "site": {"id": 1}}],
    "dcim/power-feeds": [{
        "id": 1, "name": "Feed A", "power_panel": {"id": 1},
        "phase": {"value": "three-phase"}, "voltage": 400, "amperage": 32,
    }],
    "dcim/console-server-ports": [
        {"id": 1, "name": "con0", "device": {"id": 1}, "type": {"value": "rj-45"}},
    ],
    "dcim/mac-addresses": [
        {"id": 1, "mac_address": "AA:BB:CC:DD:EE:FF",
         "assigned_object_type": "dcim.interface", "assigned_object_id": 2},
    ],
    "ipam/services": [{
        "id": 1, "name": "ssh", "device": {"id": 1},
        "protocol": {"value": "tcp"}, "ports": [22],
    }],
    "virtualization/cluster-types": [{"id": 1, "name": "vmw", "slug": "vmw"}],
    "virtualization/clusters": [{"id": 1, "name": "C1", "type": {"id": 1}}],
    "virtualization/virtual-machines": [
        {"id": 1, "name": "vm1", "cluster": {"id": 1}},
    ],
    "virtualization/interfaces": [
        {"id": 1, "name": "eth0", "virtual_machine": {"id": 1}},
    ],
    "ipam/ip-addresses": [{
        "id": 1, "address": "10.0.0.5/24",
        "assigned_object_type": "virtualization.vminterface",
        "assigned_object_id": 1, "assigned_object": {"id": 1},
    }],
    "dcim/cables": [{
        "id": 1, "a_terminations": [
            {"object_type": "dcim.interface", "object_id": 2}],
        "b_terminations": [
            {"object_type": "dcim.consoleserverport", "object_id": 1}],
        "type": "cat6", "description": "patch",
    }],
}


class ImporterBase(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        seed_builtin_statuses(self.tenant)


class CorrectnessTests(ImporterBase):
    def test_interface_lag_and_parent_wired(self):
        run_import(self.tenant, GRAPH)
        po = m.Interface.objects.get(name="Po1")
        gi = m.Interface.objects.get(name="Gi0/1")
        sub = m.Interface.objects.get(name="Gi0/1.100")
        self.assertEqual(gi.lag_id, po.id)
        self.assertEqual(sub.parent_id, gi.id)
        self.assertEqual(gi.speed, "1000000")
        self.assertEqual(gi.duplex, "full")
        self.assertTrue(sub.virtual)

    def test_dropped_fields_now_mapped(self):
        run_import(self.tenant, GRAPH)
        d = m.Device.objects.get(name="sw1")
        self.assertEqual(d.airflow, "front-to-rear")
        self.assertEqual(float(d.latitude), 55.6)
        dt = m.DeviceType.objects.get(name="C9300")
        self.assertEqual(dt.airflow, "front-to-rear")
        self.assertEqual(float(dt.weight), 5.0)
        self.assertEqual(m.Site.objects.get(name="HQ").location, "1 Main St")

    def test_power_chain_and_phase_mapping(self):
        run_import(self.tenant, GRAPH)
        feed = m.PowerFeed.objects.get(name="Feed A")
        self.assertEqual(feed.phase, "three")  # NetBox "three-phase" → "three"
        self.assertEqual(feed.power_panel.name, "PP1")

    def test_assigned_vm_set(self):
        run_import(self.tenant, GRAPH)
        ip = m.IPAddress.objects.get(ip_address="10.0.0.5")
        self.assertEqual(ip.assigned_vm.name, "vm1")

    def test_cable_idempotent_across_reruns(self):
        run_import(self.tenant, GRAPH)
        self.assertEqual(m.Cable.objects.count(), 1)
        self.assertEqual(m.Cable.objects.first().description, "patch")
        imp2 = run_import(self.tenant, GRAPH)
        self.assertEqual(m.Cable.objects.count(), 1)  # not duplicated
        self.assertEqual(imp2.stats["cables"]["existed"], 1)
        self.assertEqual(imp2.stats["cables"]["failed"], 0)

    def test_new_types_imported(self):
        run_import(self.tenant, GRAPH)
        self.assertTrue(m.ConsoleServerPort.objects.filter(name="con0").exists())
        self.assertEqual(m.Service.objects.get(name="ssh").ports, [22])
        self.assertTrue(
            m.MACAddress.objects.filter(mac_address="aa:bb:cc:dd:ee:ff").exists()
        )

    def test_whole_import_is_idempotent(self):
        run_import(self.tenant, GRAPH)
        imp2 = run_import(self.tenant, GRAPH)
        total_created = sum(s["created"] for s in imp2.stats.values())
        total_failed = sum(s["failed"] for s in imp2.stats.values())
        self.assertEqual(total_created, 0)
        self.assertEqual(total_failed, 0)


class TagTenancyTests(ImporterBase):
    def test_tags_land_scoped_to_the_target_tenant(self):
        run_import(self.tenant, GRAPH)
        tags = Tag.objects.filter(name="prod")
        self.assertEqual(tags.count(), 1)
        self.assertEqual(tags.first().tenant_id, self.tenant.id)
        self.assertFalse(Tag.objects.filter(tenant__isnull=True).exists())

    def test_another_tenants_tag_is_not_reused(self):
        other = Tenant.objects.create(org=self.org, name="U", slug="u")
        other_prod = Tag.objects.create(name="prod", slug="prod", tenant=other)
        run_import(self.tenant, GRAPH)
        mine = Tag.objects.get(name="prod", tenant=self.tenant)
        self.assertNotEqual(mine.id, other_prod.id)  # distinct rows per tenant

    def test_tag_failure_does_not_fail_the_device(self):
        # A pre-existing tag with the same slug but a DIFFERENT name collides on
        # (tenant, slug). The tag is skipped; the device must still import.
        Tag.objects.create(name="Production", slug="prod", tenant=self.tenant)
        imp = run_import(self.tenant, GRAPH)
        self.assertTrue(m.Device.objects.filter(name="sw1").exists())
        self.assertEqual(imp.stats["devices"]["failed"], 0)


class UpdateExistingTests(ImporterBase):
    def test_off_leaves_existing_untouched(self):
        run_import(self.tenant, GRAPH)
        d = m.Device.objects.get(name="sw1")
        d.description = "hand-edited"
        d.save()
        run_import(self.tenant, GRAPH)  # default: no update
        d.refresh_from_db()
        self.assertEqual(d.description, "hand-edited")

    def test_on_reapplies_netbox_values(self):
        run_import(self.tenant, GRAPH)
        d = m.Device.objects.get(name="sw1")
        d.description = "hand-edited"
        d.save()
        imp = run_import(self.tenant, GRAPH, update_existing=True)
        d.refresh_from_db()
        self.assertEqual(d.description, "")  # NetBox had no description
        self.assertGreater(imp.stats["devices"]["updated"], 0)


class FilterTests(ImporterBase):
    def test_only_and_skip(self):
        imp = run_import(self.tenant, GRAPH, only={"sites", "manufacturers"})
        self.assertTrue(m.Site.objects.exists())
        self.assertFalse(m.Device.objects.exists())
        imp = run_import(self.tenant, GRAPH, skip={"devices"})
        self.assertFalse(m.Device.objects.filter(name="sw1").exists())


class ApiTests(ImporterBase):
    """The tenant-admin-gated endpoints: launch, poll, SSRF refusal, token
    hygiene. Runs inline (Redis not required in tests)."""

    def setUp(self):
        super().setUp()
        from auth_api.models import ObjectPermission, UserProfile

        self.admin = User.objects.create_user("adm", password="x")
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="tenant-admin", object_types=["user"], actions=["change"]
        )
        p.users.add(self.admin)
        p.tenants.set([self.tenant])
        self.member = User.objects.create_user("mem", password="x")
        UserProfile.objects.create(user=self.member).tenants.add(self.tenant)

    def _login(self, user):
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_member_cannot_launch(self):
        self._login(self.member)
        res = self.client.post(
            "/api/netbox-import/",
            {"url": "https://nb.example.com", "token": "t"}, format="json",
        )
        self.assertEqual(res.status_code, 403)

    def test_ssrf_url_refused(self):
        self._login(self.admin)
        for url in ("http://169.254.169.254", "http://127.0.0.1:8000",
                    "http://[::1]/"):
            res = self.client.post(
                "/api/netbox-import/",
                {"url": url, "token": "t"}, format="json",
            )
            self.assertEqual(res.status_code, 400, url)

    def test_launch_hides_token_in_response(self):
        # The launch response (and the serializer generally) must never carry
        # the token back. Force the inline path (mock RQ away) so no worker is
        # needed, and bypass the URL SSRF resolve (no DNS in the sandbox).
        from unittest import mock

        self._login(self.admin)
        with mock.patch("core.ssrf.assert_public_url"), mock.patch(
            "django_rq.get_queue", side_effect=RuntimeError("no redis")
        ):
            res = self.client.post(
                "/api/netbox-import/",
                {"url": "https://netbox.example.com", "token": "SECRET123",
                 "dry_run": True},
                format="json",
            )
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertNotIn("SECRET123", str(body))
        self.assertNotIn("token", body)

    def test_run_clears_the_token_when_finished(self):
        # The worker entry point wipes the credential on any terminal state —
        # a migration token must not outlive the migration.
        from unittest import mock

        from integrations.models import NetBoxImportRun
        from integrations.netbox_tasks import run_netbox_import

        run = NetBoxImportRun.objects.create(
            tenant=self.tenant, url="https://netbox.example.com",
            status="queued", dry_run=True, secrets={"token": "SECRET123"},
        )
        with mock.patch("core.ssrf.assert_public_url"):
            run_netbox_import(str(run.id))  # fails at connect; that's fine
        run.refresh_from_db()
        self.assertEqual(run.secrets, {})
        self.assertIn(run.status, ("failed", "success"))

    def test_detail_is_tenant_scoped(self):
        from integrations.models import NetBoxImportRun

        other = Tenant.objects.create(org=self.org, name="U", slug="u")
        run = NetBoxImportRun.objects.create(
            tenant=other, url="https://x", status="queued"
        )
        self._login(self.admin)
        res = self.client.get(f"/api/netbox-import/{run.id}/")
        self.assertEqual(res.status_code, 404)  # not this admin's tenant


class InsecureFlagTests(ImporterBase):
    """'Allow self-signed certificate' must reach the RUN, not just the test —
    the bug was verify=True hardcoded in the worker while the connection test
    honored the flag, so testing succeeded and every fetch then failed."""

    def test_insecure_persisted_and_used(self):
        from unittest import mock

        from integrations.models import NetBoxImportRun
        from integrations.netbox_tasks import run_netbox_import

        run = NetBoxImportRun.objects.create(
            tenant=self.tenant, url="https://nb.example.com", status="queued",
            dry_run=True, insecure=True, secrets={"token": "t"},
        )
        captured = {}

        def fake_client(url, token, verify=True, guard=False):
            captured["verify"] = verify
            raise RuntimeError("stop here")

        with mock.patch(
            "integrations.management.commands.import_netbox.NetBoxClient",
            side_effect=fake_client,
        ):
            run_netbox_import(str(run.id))
        self.assertFalse(captured["verify"])  # insecure flowed to the client

    def test_with_images_flows_to_importer(self):
        # The web-UI run used to hardcode with_images=False, so images never
        # downloaded no matter the request. It must reach the importer opts.
        from unittest import mock

        from integrations.models import NetBoxImportRun
        from integrations.netbox_tasks import run_netbox_import

        run = NetBoxImportRun.objects.create(
            tenant=self.tenant, url="https://nb.example.com", status="queued",
            dry_run=True, with_images=True, secrets={"token": "t"},
        )
        captured = {}

        class FakeImp:
            def __init__(self, cmd, client, tenant, opts, on_progress=None):
                captured["with_images"] = opts.get("with_images")
                raise RuntimeError("stop here")

        with mock.patch(
            "integrations.management.commands.import_netbox.NetBoxClient",
            lambda *a, **k: object(),
        ), mock.patch(
            "integrations.management.commands.import_netbox._Importer",
            FakeImp,
        ):
            run_netbox_import(str(run.id))
        self.assertTrue(captured["with_images"])

    def test_all_fetches_failed_is_a_failed_run(self):
        # A client whose every list() raises → 0 fetched + fetch-failure notes
        # → the run must report FAILED, not a green "0 fetched" success.
        from integrations.models import NetBoxImportRun
        from integrations.netbox_tasks import run_netbox_import
        from unittest import mock

        class BrokenClient:
            def __init__(self, *a, **k): pass
            def list(self, path, on_page=None): raise RuntimeError("certificate verify failed")
            def get_bytes(self, url): raise RuntimeError("nope")

        run = NetBoxImportRun.objects.create(
            tenant=self.tenant, url="https://nb.example.com", status="queued",
            dry_run=True, secrets={"token": "t"},
        )
        with mock.patch(
            "integrations.management.commands.import_netbox.NetBoxClient",
            BrokenClient,
        ):
            run_netbox_import(str(run.id))
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIn("certificate verify failed", run.error)


class DryRunReportTests(ImporterBase):
    """Pins the fixes for the owner's first real dry run: 493 module bays
    failing on a nonexistent `type` field, 18 service templates failing on
    `custom_fields`, planned cables counted as failures, and whole types
    (front_ports) vanishing from the report because every skipped row was a
    silent `continue`."""

    PATCH_GRAPH = {
        "dcim/manufacturers": [{"id": 1, "name": "Acme", "slug": "acme"}],
        "dcim/sites": [{"id": 1, "name": "HQ"}],
        "dcim/device-types": [
            {"id": 1, "model": "PP-24", "manufacturer": {"id": 1}, "u_height": 1},
        ],
        "dcim/rear-port-templates": [
            {"id": 10, "name": "Rear1", "device_type": {"id": 1},
             "type": {"value": "lc"}, "positions": 1},
        ],
        "dcim/front-port-templates": [
            {"id": 20, "name": "Front1", "device_type": {"id": 1},
             "rear_port": {"id": 10}, "rear_port_position": 1,
             "type": {"value": "lc"}},
        ],
        "dcim/devices": [
            {"id": 1, "name": "pp1", "device_type": {"id": 1}, "site": {"id": 1}},
        ],
        "dcim/rear-ports": [
            {"id": 30, "name": "Rear1", "device": {"id": 1},
             "type": {"value": "lc"}, "positions": 1},
        ],
        "dcim/front-ports": [
            {"id": 40, "name": "Front1", "device": {"id": 1},
             "rear_port": {"id": 30}, "rear_port_position": 1,
             "type": {"value": "lc"}},
            # rear port never imported → must be a counted skip, not invisible
            {"id": 41, "name": "Orphan", "device": {"id": 1},
             "rear_port": {"id": 999}},
        ],
        "dcim/module-bays": [
            {"id": 50, "name": "FAN 1", "device": {"id": 1}, "position": "1"},
        ],
        "ipam/service-templates": [
            {"id": 60, "name": "HTTPS", "protocol": {"value": "tcp"},
             "ports": [443], "custom_fields": {"owner": "it"},
             "tags": [{"name": "prod", "slug": "prod"}]},
        ],
        "dcim/cables": [
            # planned cable, no endpoints yet — a skip, not a failure
            {"id": 70, "a_terminations": [], "b_terminations": []},
            {"id": 71,
             "a_terminations": [
                 {"object_type": "dcim.frontport", "object_id": 40}],
             "b_terminations": [
                 {"object_type": "dcim.rearport", "object_id": 30}]},
        ],
    }

    def test_module_bays_have_no_type_field(self):
        imp = run_import(self.tenant, self.PATCH_GRAPH)
        self.assertEqual(imp.stats["module_bays"]["created"], 1)
        self.assertEqual(imp.stats["module_bays"]["failed"], 0)
        self.assertTrue(
            m.ModuleBay.objects.filter(name="FAN 1", position="1").exists()
        )

    def test_service_templates_carry_custom_fields_and_tags(self):
        imp = run_import(self.tenant, self.PATCH_GRAPH)
        self.assertEqual(imp.stats["service_templates"]["failed"], 0)
        st = m.ServiceTemplate.objects.get(tenant=self.tenant, slug="https")
        self.assertEqual(st.custom_fields.get("owner"), "it")
        self.assertEqual(
            sorted(t.slug for t in st.tags.all()), ["prod"]
        )

    def test_front_ports_import_and_orphans_are_counted_skips(self):
        imp = run_import(self.tenant, self.PATCH_GRAPH)
        report = imp.report()
        fp = imp.stats["front_ports"]
        self.assertEqual(fp["created"], 1)
        self.assertEqual(fp["skipped"], 1)
        self.assertEqual(fp["fetched"], 2)  # skips still count as fetched
        self.assertTrue(
            any("front_ports: 1 skipped — rear port not imported" in n
                for n in report["notes"]),
            report["notes"],
        )
        self.assertEqual(imp.stats["front_port_templates"]["created"], 1)

    def test_planned_cable_is_a_skip_not_a_failure(self):
        imp = run_import(self.tenant, self.PATCH_GRAPH)
        c = imp.stats["cables"]
        self.assertEqual(c["created"], 1)
        self.assertEqual(c["failed"], 0)
        self.assertEqual(c["skipped"], 1)
        self.assertFalse(any("[cables]" in f for f in imp.failures))

    def test_fetch_failure_is_visible_in_the_report_table(self):
        class HalfBrokenClient(FakeClient):
            def list(self, path, on_page=None):
                if path.strip("/") == "dcim/front-ports":
                    raise RuntimeError("boom: gateway timeout")
                return super().list(path, on_page=on_page)

        base = {
            "only": set(), "skip": set(), "with_images": False,
            "dry_run": False, "update_existing": False,
        }
        imp = _Importer(
            _quiet_cmd(), HalfBrokenClient(self.PATCH_GRAPH), self.tenant, base
        )
        imp.run()
        # The failed fetch shows as a failure row, not only a buried note.
        self.assertEqual(imp.stats["front_ports"]["failed"], 1)
        self.assertTrue(
            any(f.startswith("[front_ports] fetch failed") for f in imp.failures)
        )
        self.assertTrue(
            any("front_ports: fetch failed" in n for n in imp.notes)
        )


class FloorplanImportTests(ImporterBase):
    """netbox-map plugin import: floorplans + tiles → FloorPlan/FloorPlanTile,
    tile-type strings minted as tenant FloorTileTypes, links resolved via the
    idmap, camera FOV carried over."""

    MAP_GRAPH = {
        "dcim/manufacturers": [{"id": 1, "name": "Cisco", "slug": "cisco"}],
        "dcim/sites": [{"id": 1, "name": "Nr Vium"}],
        "dcim/device-types": [
            {"id": 1, "model": "AP", "manufacturer": {"id": 1}, "u_height": 1},
        ],
        "dcim/devices": [
            {"id": 1741, "name": "AP-128", "device_type": {"id": 1},
             "site": {"id": 1}},
        ],
        "dcim/racks": [{"id": 6, "name": "A18", "site": {"id": 1}}],
        "plugins/map/floorplans": [
            {"id": 1, "name": "1. etage", "site": {"id": 1}, "location": None,
             "grid_width": 150, "grid_height": 250,
             "background_image": None},
            {"id": 3, "name": "Stueplan", "site": {"id": 1}, "location": None,
             "grid_width": 250, "grid_height": 350, "background_image": None},
        ],
        "plugins/map/floorplan-tiles": [
            {"id": 4, "floorplan": {"id": 1}, "x_position": 77,
             "y_position": 40, "width": 1, "height": 1,
             "assigned_object_type": "dcim.device", "assigned_object_id": 1741,
             "label": "128", "tile_type": "ap", "status": "active",
             "orientation": 0, "linked_floorplan": None,
             "fov_direction": 0, "fov_angle": 90, "fov_distance": 5},
            {"id": 262, "floorplan": {"id": 1}, "x_position": 67,
             "y_position": 50, "width": 1, "height": 1,
             "assigned_object_type": "dcim.rack", "assigned_object_id": 6,
             "label": "", "tile_type": "empty", "status": "active",
             "orientation": 0, "linked_floorplan": None},
            {"id": 190, "floorplan": {"id": 1}, "x_position": 102,
             "y_position": 51, "width": 10, "height": 10,
             "assigned_object_type": None, "assigned_object_id": None,
             "label": "Til stuen", "tile_type": "floorplan_link",
             "status": "active", "orientation": 0,
             "linked_floorplan": {"id": 3}},
            {"id": 192, "floorplan": {"id": 1}, "x_position": 5,
             "y_position": 0, "width": 1, "height": 1,
             "assigned_object_type": "dcim.device", "assigned_object_id": 9999,
             "label": "KA65", "tile_type": "camera", "status": "active",
             "orientation": 0, "linked_floorplan": None,
             "fov_direction": 270, "fov_angle": 35, "fov_distance": 5},
        ],
    }

    def test_plans_land_in_a_per_site_fallback_location(self):
        imp = run_import(self.tenant, self.MAP_GRAPH)
        self.assertEqual(imp.stats["floor_plans"]["created"], 2)
        fp = m.FloorPlan.objects.get(tenant=self.tenant, name="1. etage")
        self.assertEqual(fp.grid_width, 150)
        self.assertEqual(fp.grid_height, 250)
        self.assertEqual(fp.location.slug, "imported-floor-plans")
        self.assertEqual(fp.location.site.name, "Nr Vium")

    def test_tiles_resolve_device_rack_and_nested_plan_links(self):
        imp = run_import(self.tenant, self.MAP_GRAPH)
        self.assertEqual(imp.stats["floor_plan_tiles"]["created"], 4)
        fp = m.FloorPlan.objects.get(tenant=self.tenant, name="1. etage")
        ap = fp.tiles.get(label="128")
        self.assertEqual(ap.link_kind, "device")
        self.assertEqual(ap.device.name, "AP-128")
        self.assertEqual(ap.tile_type.slug, "ap")
        rack = fp.tiles.get(x=67, y=50)
        self.assertEqual(rack.link_kind, "rack")
        self.assertEqual(rack.rack.name, "A18")
        nav = fp.tiles.get(label="Til stuen")
        self.assertEqual(nav.link_kind, "floorplan")
        self.assertEqual(nav.linked_floor_plan.name, "Stueplan")
        self.assertEqual((nav.width, nav.height), (10, 10))

    def test_camera_keeps_fov_and_unresolved_link_is_noted(self):
        imp = run_import(self.tenant, self.MAP_GRAPH)
        cam = m.FloorPlanTile.objects.get(
            floor_plan__tenant=self.tenant, label="KA65"
        )
        self.assertEqual(
            (cam.fov_deg, cam.fov_direction, cam.fov_distance), (35, 270, 5)
        )
        self.assertTrue(cam.tile_type.has_fov)
        self.assertIsNone(cam.linked_object)  # device 9999 never imported
        report = imp.report()
        self.assertTrue(
            any("without their link" in n for n in report["notes"]),
            report["notes"],
        )
        # Non-camera tiles must not grow cones from the plugin's defaults.
        ap = m.FloorPlanTile.objects.get(
            floor_plan__tenant=self.tenant, label="128"
        )
        self.assertIsNone(ap.fov_deg)

    def test_tile_types_are_tenant_data(self):
        run_import(self.tenant, self.MAP_GRAPH)
        slugs = set(
            m.FloorTileType.objects.filter(tenant=self.tenant)
            .values_list("slug", flat=True)
        )
        self.assertEqual(slugs, {"ap", "empty", "floorplan_link", "camera"})

    def test_rerun_is_idempotent(self):
        run_import(self.tenant, self.MAP_GRAPH)
        imp2 = run_import(self.tenant, self.MAP_GRAPH)
        self.assertEqual(imp2.stats["floor_plans"]["existed"], 2)
        self.assertEqual(imp2.stats["floor_plan_tiles"]["existed"], 4)
        self.assertEqual(
            m.FloorPlanTile.objects.filter(floor_plan__tenant=self.tenant).count(),
            4,
        )

    def test_missing_plugin_is_a_note_not_a_failure(self):
        class NoPluginClient(FakeClient):
            def list(self, path, on_page=None):
                if path.strip("/").startswith("plugins/map/"):
                    raise RuntimeError("404 Not Found")
                return super().list(path, on_page=on_page)

        base = {
            "only": set(), "skip": set(), "with_images": False,
            "dry_run": False, "update_existing": False,
        }
        graph = {k: v for k, v in self.MAP_GRAPH.items()
                 if not k.startswith("plugins/")}
        imp = _Importer(_quiet_cmd(), NoPluginClient(graph), self.tenant, base)
        imp.run()
        self.assertEqual(imp.stats["floor_plans"]["failed"], 0)
        self.assertFalse(any("floor_plans" in f for f in imp.failures))
        self.assertTrue(
            any("floor_plans: not imported — optional endpoint" in n
                for n in imp.notes),
            imp.notes,
        )


class NetBox44ShapeTests(ImporterBase):
    """The user's second real dry run (NetBox 4.4): front ports use a
    `rear_ports` mapping list, services use a generic parent, dangling
    one-ended cables aren't failures, and filtered paths must not 301."""

    GRAPH = {
        "dcim/manufacturers": [{"id": 1, "name": "Acme", "slug": "acme"}],
        "dcim/sites": [{"id": 1, "name": "HQ"}],
        "dcim/device-types": [
            {"id": 1, "model": "PP-24", "manufacturer": {"id": 1}, "u_height": 1},
        ],
        "dcim/rear-port-templates": [
            {"id": 10, "name": "Rear1", "device_type": {"id": 1},
             "type": {"value": "lc"}, "positions": 1},
        ],
        # 4.4 template shape: rear_ports mapping list, no rear_port key
        "dcim/front-port-templates": [
            {"id": 20, "name": "Front1", "device_type": {"id": 1},
             "type": {"value": "lc"},
             "rear_ports": [
                 {"position": 1, "rear_port": 10, "rear_port_position": 1}]},
        ],
        "dcim/devices": [
            {"id": 1, "name": "pp1", "device_type": {"id": 1}, "site": {"id": 1}},
        ],
        "dcim/interfaces": [
            {"id": 1, "name": "Gi0/1", "device": {"id": 1},
             "type": {"value": "1000base-t"}},
        ],
        "dcim/rear-ports": [
            {"id": 30, "name": "Rear1", "device": {"id": 1},
             "type": {"value": "lc"}, "positions": 2},
        ],
        "dcim/front-ports": [
            {"id": 40, "name": "Front1", "device": {"id": 1},
             "type": {"value": "lc"}, "positions": 1,
             "rear_ports": [
                 {"position": 1, "rear_port": 30, "rear_port_position": 2}]},
        ],
        # 4.3+ service shape: generic parent, no device/virtual_machine keys
        "ipam/services": [
            {"id": 1, "name": "ssh", "protocol": {"value": "tcp"},
             "ports": [22], "parent_object_type": "dcim.device",
             "parent_object_id": 1, "parent": {"id": 1, "name": "pp1"}},
        ],
        # dangling cable: one connected end, valid in NetBox
        "dcim/cables": [
            {"id": 1,
             "a_terminations": [
                 {"object_type": "dcim.interface", "object_id": 1}],
             "b_terminations": []},
        ],
    }

    def test_front_ports_resolve_the_mapping_list(self):
        imp = run_import(self.tenant, self.GRAPH)
        self.assertEqual(imp.stats["front_ports"]["created"], 1, imp.notes)
        fp = m.FrontPort.objects.get(name="Front1", device__name="pp1")
        self.assertEqual(fp.rear_port.name, "Rear1")
        self.assertEqual(fp.rear_port_position, 2)
        self.assertEqual(imp.stats["front_port_templates"]["created"], 1)
        tpl = m.FrontPortTemplate.objects.get(name="Front1")
        self.assertEqual(tpl.rear_port_template.name, "Rear1")

    def test_service_generic_parent_resolves(self):
        imp = run_import(self.tenant, self.GRAPH)
        self.assertEqual(imp.stats["services"]["created"], 1, imp.notes)
        svc = m.Service.objects.get(tenant=self.tenant, name="ssh")
        self.assertEqual(svc.device.name, "pp1")

    def test_dangling_cable_is_a_skip(self):
        imp = run_import(self.tenant, self.GRAPH)
        c = imp.stats["cables"]
        self.assertEqual((c["failed"], c["skipped"], c["fetched"]), (0, 1, 1))
        report = imp.report()
        self.assertTrue(
            any("only one end connected" in n for n in report["notes"]),
            report["notes"],
        )

    def test_list_url_splices_query_before_limit(self):
        from unittest import mock

        with mock.patch("httpx.Client"):
            client = NetBoxClient("https://nb.example.com", "t")
        self.assertEqual(
            client.list_url("dcim/interface-templates?module_type_id__isnull=false"),
            "https://nb.example.com/api/dcim/interface-templates/"
            "?module_type_id__isnull=false&limit=250",
        )
        self.assertEqual(
            client.list_url("dcim/devices"),
            "https://nb.example.com/api/dcim/devices/?limit=250",
        )
