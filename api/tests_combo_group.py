"""Combo / shared ports: mutual exclusion + template materialisation."""
from __future__ import annotations

from django.test import TestCase

from api.models import (
    Device,
    DeviceType,
    Interface,
    InterfaceTemplate,
    Manufacturer,
    materialize_device_components,
)
from core.models import Organization, Tenant


class ComboGroupTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.mfr = Manufacturer.objects.create(
            tenant=self.tenant, name="Acme", slug="acme"
        )
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, name="SW-1"
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt
        )

    def _iface(self, name, combo="", enabled=True, **kw):
        return Interface.objects.create(
            device=self.device, name=name, combo_group=combo, enabled=enabled,
            **kw,
        )

    def test_enabling_one_disables_its_combo_siblings(self):
        rj = self._iface("mgmt0", combo="mgmt", enabled=True)
        sfp = self._iface("mgmt0-sfp", combo="mgmt", enabled=False)
        # Enable the SFP → the RJ45 twin turns off.
        sfp.enabled = True
        sfp.save()
        rj.refresh_from_db()
        self.assertFalse(rj.enabled)
        self.assertTrue(Interface.objects.get(pk=sfp.pk).enabled)

    def test_no_cross_group_or_cross_device_effect(self):
        a = self._iface("mgmt0", combo="mgmt", enabled=True)
        other = self._iface("Gi0/1", combo="uplink", enabled=True)
        plain = self._iface("Gi0/2", combo="", enabled=True)
        # Different device, same group name — must be untouched.
        d2 = Device.objects.create(
            tenant=self.tenant, name="sw2", device_type=self.dt
        )
        far = Interface.objects.create(
            device=d2, name="mgmt0", combo_group="mgmt", enabled=True
        )
        a.enabled = True
        a.save()
        for i in (other, plain, far):
            i.refresh_from_db()
            self.assertTrue(i.enabled)

    def test_disabling_leaves_siblings_alone(self):
        a = self._iface("mgmt0", combo="mgmt", enabled=True)
        b = self._iface("mgmt0-sfp", combo="mgmt", enabled=False)
        # Disabling the active one doesn't flip the other on.
        a.enabled = False
        a.save()
        b.refresh_from_db()
        self.assertFalse(b.enabled)

    def test_template_combo_group_materialises_onto_device(self):
        dt2 = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, name="SW-2"
        )
        InterfaceTemplate.objects.create(
            device_type=dt2, name="mgmt0", type="1000base-t",
            combo_group="mgmt", enabled=True,
        )
        InterfaceTemplate.objects.create(
            device_type=dt2, name="mgmt0-sfp", type="1000base-x-sfp",
            combo_group="mgmt", enabled=False,
        )
        dev = Device.objects.create(
            tenant=self.tenant, name="sw-new", device_type=dt2
        )
        materialize_device_components(dev)
        rj = Interface.objects.get(device=dev, name="mgmt0")
        sfp = Interface.objects.get(device=dev, name="mgmt0-sfp")
        self.assertEqual(rj.combo_group, "mgmt")
        self.assertEqual(sfp.combo_group, "mgmt")
        self.assertTrue(rj.enabled)
        self.assertFalse(sfp.enabled)
