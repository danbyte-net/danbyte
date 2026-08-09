"""Integrity of the reference-model registry itself.

Every entry in the registry is a promise that `resolve_labels()` can scope that
model to a tenant and render a label for it. Nothing validated that promise, so
`interface` shipped registered with the default `tenant_field="tenant"` while
`api.Interface` has no tenant FK (its tenancy runs through `device.tenant`) —
`filter(tenant=…)` raised FieldError, the endpoint 500'd, and every linked
interface in the UI read "Unavailable".

The walk below is the guard: it covers entries that don't exist yet, which a
per-model test can't.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.exceptions import FieldError
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, DeviceType, Interface, Manufacturer, Site
from api.test_utils import status_for
from core.models import Organization, Tenant

from .object_registry import reference_models, resolve_labels

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _device(self, tenant=None, name="sw-01"):
        tenant = tenant or self.tenant
        site = Site.objects.create(tenant=tenant, name=f"S-{name}")
        mfr, _ = Manufacturer.objects.get_or_create(
            tenant=tenant, slug="m", defaults={"name": "M"}
        )
        dtype, _ = DeviceType.objects.get_or_create(
            tenant=tenant, model="X", defaults={"manufacturer": mfr}
        )
        role = DeviceRole.objects.create(
            tenant=tenant, name=f"R-{name}", slug=f"r-{name}"
        )
        return Device.objects.create(
            tenant=tenant, name=name, device_type=dtype, site=site, role=role,
            status=status_for(tenant),
        )


class RegistryIntegrityTests(_Base):
    def test_every_reference_model_tenant_filter_is_valid(self):
        """The walk. Django resolves a lookup path at filter() time, before any
        SQL, so an unresolvable `tenant_field` raises here — cheaply, for every
        entry including ones added later."""
        broken = []
        for slug, ref in reference_models().items():
            if not ref.tenant_field:
                continue
            try:
                ref.model.objects.filter(**{ref.tenant_field: self.tenant})
            except FieldError as exc:
                broken.append(f"{slug} (tenant_field={ref.tenant_field!r}): {exc}")
        self.assertEqual(broken, [], "Reference models with an invalid tenant path")

    def test_every_reference_model_label_field_exists(self):
        missing = [
            slug
            for slug, ref in reference_models().items()
            if ref.label_field
            and not hasattr(ref.model, ref.label_field)
            and ref.label_field not in {
                f.name for f in ref.model._meta.get_fields()
            }
        ]
        self.assertEqual(missing, [], "Reference models with a bogus label_field")

    def test_every_reference_model_select_related_is_valid(self):
        broken = []
        for slug, ref in reference_models().items():
            if not ref.select_related:
                continue
            try:
                list(ref.model.objects.select_related(*ref.select_related)[:0])
            except FieldError as exc:
                broken.append(f"{slug}: {exc}")
        self.assertEqual(broken, [], "Reference models with an invalid select_related")


class InterfaceLabelTests(_Base):
    def test_interface_labels_resolve(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1")
        rows = resolve_labels("interface", [str(iface.id)], tenant=self.tenant)
        self.assertEqual(len(rows), 1, "interface labels must resolve at all")
        self.assertEqual(rows[0]["route"], f"/interfaces/{iface.id}")

    def test_interface_label_is_device_qualified(self):
        """"Gi2/1" is unique only per device, so the bare name is useless in a
        task chip. The registry asks for __str__, which qualifies it."""
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1")
        rows = resolve_labels("interface", [str(iface.id)], tenant=self.tenant)
        self.assertIn("sw-01", rows[0]["label"])
        self.assertIn("Gi2/1", rows[0]["label"])

    def test_object_labels_endpoint_serves_interfaces(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1")
        r = self.client.get(
            f"/api/customization/object-labels/?model=interface&ids={iface.id}"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["results"]), 1)

    def test_cross_tenant_interface_is_dropped(self):
        """The reason the fix is `device__tenant` and not `tenant_field=None`:
        None would have stopped the crash by turning it into a label leak."""
        foreign = Interface.objects.create(
            device=self._device(tenant=self.other, name="theirs"), name="Gi0/1"
        )
        self.assertEqual(
            resolve_labels("interface", [str(foreign.id)], tenant=self.tenant), []
        )
        r = self.client.get(
            f"/api/customization/object-labels/?model=interface&ids={foreign.id}"
        )
        self.assertEqual(r.json()["results"], [])
