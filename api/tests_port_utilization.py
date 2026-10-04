from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Device,
    FrontPort,
    Interface,
    RearPort,
    Status,
)

User = get_user_model()


class PortUtilizationTests(APITestCase):
    """/api/devices/<id>/port-utilization/ (issue #64).

    Connected = port terminates a cable; reserved = that cable's status is
    "planned"; free = no cable.
    """

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

        self.planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned",
            available_to=["cable"],
        )
        self.dev = Device.objects.create(tenant=self.tenant, name="pp-01")
        self.other = Device.objects.create(tenant=self.tenant, name="sw-01")

    def _cable(self, status=None, **term):
        c = Cable.objects.create(tenant=self.tenant, status=status)
        CableTermination.objects.create(cable=c, end="A", **term)
        return c

    def test_counts_connected_reserved_free(self):
        # 3 interfaces: one patched, one planned (reserved), one free.
        i1 = Interface.objects.create(device=self.dev, name="Gi1")
        i2 = Interface.objects.create(device=self.dev, name="Gi2")
        Interface.objects.create(device=self.dev, name="Gi3")
        self._cable(interface=i1)
        self._cable(status=self.planned, interface=i2)
        # 2 front ports: one patched, one free; 1 rear port, free.
        rp = RearPort.objects.create(device=self.dev, name="R1", positions=4)
        f1 = FrontPort.objects.create(
            device=self.dev, name="F1", rear_port=rp, rear_port_position=1
        )
        FrontPort.objects.create(
            device=self.dev, name="F2", rear_port=rp, rear_port_position=2
        )
        self._cable(front_port=f1)

        r = self.client.get(f"/api/devices/{self.dev.id}/port-utilization/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            body["interfaces"],
            {"total": 3, "connected": 1, "reserved": 1, "free": 1, "marked": 0},
        )
        self.assertEqual(
            body["front_ports"],
            {"total": 2, "connected": 1, "reserved": 0, "free": 1, "marked": 0},
        )
        # The rear port is still reported, but it is the back of the front
        # ports, not capacity of its own: the combined total leaves it out.
        self.assertEqual(
            body["rear_ports"],
            {"total": 1, "connected": 0, "reserved": 0, "free": 1, "marked": 0},
        )
        self.assertEqual(
            body["combined"],
            {"total": 5, "connected": 2, "reserved": 1, "free": 2, "marked": 0},
        )
        self.assertIs(body["count_virtual"], False)

    def test_statusless_cable_counts_as_connected(self):
        i = Interface.objects.create(device=self.dev, name="Gi1")
        self._cable(interface=i)
        body = self.client.get(
            f"/api/devices/{self.dev.id}/port-utilization/"
        ).json()
        self.assertEqual(body["interfaces"]["connected"], 1)
        self.assertEqual(body["interfaces"]["reserved"], 0)

    def test_other_devices_ports_do_not_leak_in(self):
        Interface.objects.create(device=self.other, name="Gi1")
        body = self.client.get(
            f"/api/devices/{self.dev.id}/port-utilization/"
        ).json()
        self.assertEqual(body["combined"]["total"], 0)

    def test_marked_counts_as_connected_and_clears_on_cable(self):
        # Two interfaces: one mark_connected (undocumented), one free.
        i1 = Interface.objects.create(
            device=self.dev, name="Gi1", mark_connected=True
        )
        Interface.objects.create(device=self.dev, name="Gi2")
        body = self.client.get(
            f"/api/devices/{self.dev.id}/port-utilization/"
        ).json()
        self.assertEqual(
            body["interfaces"],
            {"total": 2, "connected": 1, "reserved": 0, "free": 1, "marked": 1},
        )
        # Documenting a real cable retires the placeholder flag.
        self._cable(interface=i1)
        i1.refresh_from_db()
        self.assertFalse(i1.mark_connected)
        body = self.client.get(
            f"/api/devices/{self.dev.id}/port-utilization/"
        ).json()
        self.assertEqual(body["interfaces"]["marked"], 0)
        self.assertEqual(body["interfaces"]["connected"], 1)

    def test_excluded_status_ports_leave_the_math(self):
        """A Not-present stack port is not capacity - free or otherwise
        (#105). Only the excludes_capacity flag matters, not the slug."""
        absent = Status.objects.create(
            tenant=self.tenant, name="Not Present", slug="not_present",
            available_to=["interface"], excludes_capacity=True,
        )
        Interface.objects.create(device=self.dev, name="Gi1")
        Interface.objects.create(device=self.dev, name="2/1", status=absent)
        Interface.objects.create(device=self.dev, name="2/2", status=absent)

        r = self.client.get(f"/api/devices/{self.dev.id}/port-utilization/")
        self.assertEqual(r.status_code, 200, r.content)
        combined = r.json()["combined"]
        self.assertEqual(combined["total"], 1)
        self.assertEqual(combined["free"], 1)

        from api.models import Device as D
        from api.port_utilization import device_port_counts

        counts = device_port_counts(
            D.objects.filter(pk=self.dev.pk), count_virtual=False
        )
        self.assertEqual(counts[self.dev.id]["total"], 1)

    def test_rollup_lists_port_devices_fullest_first(self):
        # pp-01: 1 of 2 interfaces cabled (50%); sw-01: 1 of 1 (100%).
        i1 = Interface.objects.create(device=self.dev, name="Gi1")
        Interface.objects.create(device=self.dev, name="Gi2")
        self._cable(interface=i1)
        o1 = Interface.objects.create(device=self.other, name="Gi1")
        self._cable(status=self.planned, interface=o1)
        # A portless device stays out of the roll-up entirely.
        Device.objects.create(tenant=self.tenant, name="cam-01")

        r = self.client.get("/api/devices/port-utilization/")
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["results"]
        self.assertEqual([x["name"] for x in rows], ["sw-01", "pp-01"])
        self.assertEqual(rows[0]["pct"], 100)
        self.assertEqual(rows[0]["reserved"], 1)
        self.assertEqual(rows[1]["pct"], 50)
        self.assertEqual(rows[1]["free"], 1)


class StackPortUtilizationTests(PortUtilizationTests):
    """/api/virtual-chassis/<id>/port-utilization/ sums the members."""

    def test_stack_sums_its_members(self):
        from .models import VirtualChassis

        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk__in=[self.dev.pk, self.other.pk]).update(virtual_chassis=vc)
        i1 = Interface.objects.create(device=self.dev, name="Gi1")
        Interface.objects.create(device=self.dev, name="Gi2")
        i3 = Interface.objects.create(device=self.other, name="Gi1")
        Interface.objects.create(device=self.other, name="Gi2", mark_connected=True)
        self._cable(interface=i1)
        self._cable(status=self.planned, interface=i3)
        Device.objects.create(tenant=self.tenant, name="loner")  # not in the stack
        body = self.client.get(f"/api/virtual-chassis/{vc.id}/port-utilization/").json()
        self.assertEqual(
            body["interfaces"],
            {"total": 4, "connected": 2, "reserved": 1, "free": 1, "marked": 1},
        )
        self.assertEqual(body["combined"]["total"], 4)
        # The per-device card is unchanged by the refactor.
        one = self.client.get(f"/api/devices/{self.dev.id}/port-utilization/").json()
        self.assertEqual(one["interfaces"]["connected"], 1)



def _set_count_virtual(on: bool) -> None:
    from core.models import DeploymentSettings

    ds = DeploymentSettings.load()
    ds.port_count_virtual = on
    ds.save()


class CountingRuleTests(APITestCase):
    """One counting rule (0.17): physical interfaces and front ports count,
    virtual interfaces only with the setting on, rear ports never - and
    every consumer reads the same numbers."""

    def setUp(self):
        from .models import Rack, Site

        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned",
            available_to=["cable"],
        )
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.rack = Rack.objects.create(tenant=self.tenant, name="R1", site=self.site)
        # sw-01: 4 physical ports (one mgmt-only, one disabled), 1 cabled,
        # 1 planned; 3 virtual ones - an SVI flagged virtual, a LAG, and a
        # legacy "virtual"-typed row whose flag was never set.
        self.sw = Device.objects.create(
            tenant=self.tenant, name="sw-01", site=self.site, rack=self.rack
        )
        g1 = Interface.objects.create(device=self.sw, name="Gi1")
        g2 = Interface.objects.create(device=self.sw, name="Gi2")
        Interface.objects.create(device=self.sw, name="mgmt0", mgmt_only=True)
        Interface.objects.create(device=self.sw, name="Gi4", enabled=False)
        self._cable(interface=g1)
        self._cable(status=self.planned, interface=g2)
        svi = Interface.objects.create(device=self.sw, name="Vlan10", virtual=True)
        self._cable(interface=svi)  # odd, but it must stay out of the count
        Interface.objects.create(device=self.sw, name="Po1", type="lag")
        legacy = Interface.objects.create(device=self.sw, name="Lo0", type="virtual")
        Interface.objects.filter(pk=legacy.pk).update(virtual=False)

    def _cable(self, status=None, **term):
        c = Cable.objects.create(tenant=self.tenant, status=status)
        CableTermination.objects.create(cable=c, end="A", **term)
        return c

    def _card(self, device=None):
        r = self.client.get(f"/api/devices/{(device or self.sw).id}/port-utilization/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _rollup(self):
        r = self.client.get("/api/devices/port-utilization/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_setting_off_counts_physical_ports_only(self):
        body = self._card()
        self.assertIs(body["count_virtual"], False)
        self.assertEqual(
            body["combined"],
            {"total": 4, "connected": 1, "reserved": 1, "free": 2, "marked": 0},
        )
        self.assertEqual(body["interfaces"]["total"], 4)
        # Reported for information, whatever the setting.
        self.assertEqual(
            body["virtual"],
            {"total": 3, "connected": 1, "reserved": 0, "free": 2, "marked": 0},
        )

    def test_setting_on_counts_virtual_interfaces_too(self):
        _set_count_virtual(True)
        body = self._card()
        self.assertIs(body["count_virtual"], True)
        self.assertEqual(
            body["combined"],
            {"total": 7, "connected": 2, "reserved": 1, "free": 4, "marked": 0},
        )
        # The kinds stay disjoint: "interfaces" is the physical ones.
        self.assertEqual(body["interfaces"]["total"], 4)
        self.assertEqual(body["virtual"]["total"], 3)

    def test_rollup_equals_the_device_card(self):
        from .models import FrontPort, RearPort

        panel = Device.objects.create(tenant=self.tenant, name="pp-01")
        rp = RearPort.objects.create(device=panel, name="R1", positions=24)
        fronts = [
            FrontPort.objects.create(
                device=panel, name=f"F{n}", rear_port=rp, rear_port_position=n
            )
            for n in range(1, 25)
        ]
        self._cable(interface=None, front_port=fronts[0])
        fronts[1].mark_connected = True
        fronts[1].save()
        for on in (False, True):
            with self.subTest(count_virtual=on):
                _set_count_virtual(on)
                rows = {r["name"]: r for r in self._rollup()["results"]}
                for dev in (self.sw, panel):
                    card = self._card(dev)["combined"]
                    row = rows[dev.name]
                    self.assertEqual(
                        {k: row[k] for k in card}, card, dev.name
                    )
                # A 24-port panel reads /24: its rear port is not capacity.
                self.assertEqual(rows["pp-01"]["total"], 24)

    def test_rollup_carries_rack_and_basis_and_drops_virtual_only_devices(self):
        router = Device.objects.create(tenant=self.tenant, name="vr-01")
        Interface.objects.create(device=router, name="lo0", virtual=True)
        body = self._rollup()
        self.assertIs(body["count_virtual"], False)
        rows = {r["name"]: r for r in body["results"]}
        self.assertNotIn("vr-01", rows)  # nothing counted, no fill level
        self.assertEqual(
            rows["sw-01"]["rack"], {"id": str(self.rack.id), "name": "R1"}
        )
        self.assertEqual(rows["sw-01"]["site"]["name"], "HQ")
        self.assertEqual(rows["sw-01"]["pct"], 50)
        _set_count_virtual(True)
        body = self._rollup()
        rows = {r["name"]: r for r in body["results"]}
        self.assertIs(body["count_virtual"], True)
        self.assertEqual(rows["vr-01"]["total"], 1)
        self.assertIsNone(rows["vr-01"]["rack"])

    def test_counts_stay_flat_in_queries(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from .port_utilization import device_port_counts

        def counted(n_devices):
            for i in range(n_devices):
                d = Device.objects.create(tenant=self.tenant, name=f"x-{n_devices}-{i}")
                Interface.objects.create(device=d, name="Gi1")
                Interface.objects.create(device=d, name="Vlan1", virtual=True)
            with CaptureQueriesContext(connection) as ctx:
                self._rollup()
            return len(ctx.captured_queries)

        with self.assertNumQueries(12):
            device_port_counts(Device.objects.filter(tenant=self.tenant), count_virtual=False)
        self._rollup()  # warm the once-per-process lookups (RBAC, content types)
        self.assertEqual(counted(1), counted(6))

    def test_used_pct_is_none_without_a_counted_port(self):
        from .port_utilization import used_pct

        self.assertIsNone(used_pct({"total": 0, "connected": 0, "reserved": 0}))
        self.assertEqual(used_pct({"total": 3, "connected": 1, "reserved": 1}), 67)

    def test_excluded_status_virtual_port_leaves_every_count(self):
        absent = Status.objects.create(
            tenant=self.tenant, name="Not Present", slug="not_present",
            available_to=["interface"], excludes_capacity=True,
        )
        Interface.objects.create(
            device=self.sw, name="Vlan99", virtual=True, status=absent
        )
        self.assertEqual(self._card()["virtual"]["total"], 3)


class VirtualFlagTests(APITestCase):
    """Every write path flags virtual / bridge / lag interfaces virtual, so
    the count agrees with what the faceplate draws."""

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.dev = Device.objects.create(tenant=self.tenant, name="sw-01")

    def test_save_flags_virtual_types(self):
        for t in ("virtual", "bridge", "lag"):
            with self.subTest(type=t):
                i = Interface.objects.create(device=self.dev, name=f"x-{t}", type=t)
                self.assertTrue(i.virtual)
        phys = Interface.objects.create(device=self.dev, name="Gi1", type="1000base-t")
        self.assertFalse(phys.virtual)

    def test_bulk_edit_flags_virtual_types(self):
        i = Interface.objects.create(device=self.dev, name="br0")
        r = self.client.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(i.id)], "fields": {"type": "bridge"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        i.refresh_from_db()
        self.assertTrue(i.virtual)

    def test_template_and_module_installs_flag_virtual_types(self):
        from .models import (
            DeviceType,
            InterfaceTemplate,
            Manufacturer,
            Module,
            ModuleBay,
            ModuleInterfaceTemplate,
            ModuleType,
            install_module,
            materialize_device_components,
        )

        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="SW")
        InterfaceTemplate.objects.create(device_type=dt, name="Gi1", type="1000base-t")
        InterfaceTemplate.objects.create(device_type=dt, name="Po1", type="lag")
        InterfaceTemplate.objects.create(device_type=dt, name="br0", type="bridge")
        dev = Device.objects.create(tenant=self.tenant, name="sw-02", device_type=dt)
        materialize_device_components(dev)
        flags = dict(dev.interfaces.values_list("name", "virtual"))
        self.assertEqual(flags, {"Gi1": False, "Po1": True, "br0": True})

        mt = ModuleType.objects.create(tenant=self.tenant, name="NM")
        ModuleInterfaceTemplate.objects.create(module_type=mt, name="Te{module}/1")
        ModuleInterfaceTemplate.objects.create(
            module_type=mt, name="Vl{module}", type="virtual"
        )
        bay = ModuleBay.objects.create(device=self.dev, name="Slot 1", position="1")
        module = Module.objects.create(device=self.dev, module_bay=bay, module_type=mt)
        install_module(module)
        flags = dict(self.dev.interfaces.values_list("name", "virtual"))
        self.assertEqual(flags, {"Te1/1": False, "Vl1": True})


class VirtualTypeBackfillTests(APITestCase):
    """api 0193: rows of a virtual type written before save() set the flag."""

    def test_flags_virtual_types_once(self):
        import importlib

        from django.apps import apps

        mig = importlib.import_module("api.migrations.0193_interface_virtual_types")
        org = Organization.objects.create(name="Acme", slug="acme")
        tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        dev = Device.objects.create(tenant=tenant, name="sw-01")
        rows = {
            t: Interface.objects.create(device=dev, name=t or "blank", type=t)
            for t in ("virtual", "bridge", "lag", "1000base-t", "")
        }
        Interface.objects.filter(device=dev).update(virtual=False)
        for _ in range(2):  # idempotent
            mig.flag_virtual_types(apps, None)
        flags = {t: Interface.objects.get(pk=i.pk).virtual for t, i in rows.items()}
        self.assertEqual(
            flags,
            {"virtual": True, "bridge": True, "lag": True, "1000base-t": False, "": False},
        )


class PortCountSettingTests(APITestCase):
    """B0b: the deployment-wide "Count virtual interfaces" switch."""

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_defaults_off_and_saves_through_deployment_settings(self):
        from core.effective_settings import port_count_virtual

        self.assertIs(port_count_virtual(self.tenant), False)
        r = self.client.get("/api/deployment/email/")
        self.assertIs(r.json()["port_count_virtual"], False)
        r = self.client.put(
            "/api/deployment/email/", {"port_count_virtual": True}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIs(r.json()["port_count_virtual"], True)
        self.assertIs(port_count_virtual(self.tenant), True)

    def test_only_deployment_managers_change_it(self):
        user = User.objects.create_user("viewer", "v@example.com", "x")
        self.client.force_login(user)
        r = self.client.put(
            "/api/deployment/email/", {"port_count_virtual": True}, format="json"
        )
        self.assertEqual(r.status_code, 403)
        from core.effective_settings import port_count_virtual

        self.assertIs(port_count_virtual(self.tenant), False)

    def test_change_is_audited(self):
        from audit.models import ChangeLogEntry
        from core.models import DeploymentSettings

        DeploymentSettings.load()  # the row exists before the change
        self.client.put(
            "/api/deployment/email/", {"port_count_virtual": True}, format="json"
        )
        entry = ChangeLogEntry.objects.filter(
            object_type="core.deploymentsettings", action="update"
        ).order_by("-timestamp").first()
        self.assertIsNotNone(entry)
        self.assertEqual(
            entry.changes.get("port_count_virtual"), {"old": False, "new": True}
        )
