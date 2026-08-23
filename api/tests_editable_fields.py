"""The editable-field registry.

These tests exist to stop the failure mode the registry was built to end: field
allow-lists maintained by hand in more than one place, drifting apart silently.
The registry derives its metadata, so the tests assert the derivation still
matches the models and still matches what writes actually accept.
"""
from __future__ import annotations

from django.apps import apps
from django.contrib.auth.models import User
from rest_framework.exceptions import ValidationError
from rest_framework.test import APITestCase

from api.editable_fields import (
    DCIM_CHOICE_KEYS,
    coerce_value,
    covered_models,
    field_for,
    fields_for,
    read_value,
    serializer_for,
)
from api.models import (
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    Manufacturer,
    Site,
    Status,
)
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

VALID_KINDS = {
    "text", "int", "bool", "choice", "options", "status", "bytes",
    "vlan", "vrf", "object",
}


class RegistryDerivationTests(APITestCase):
    def test_every_declared_field_exists_on_its_model(self):
        """A typo in a bulk_*/editable_* tuple is otherwise unguarded - it only
        surfaces as a 500 inside bulk_update's flatchoices lookup."""
        missing = []
        for model, spec in covered_models():
            # FK keys carry the "_id" payload suffix; plain fields do not (and
            # InventoryItem.part_id is a real CharField that ends in _id).
            names = [(k, False) for k in (*spec["str"], *spec["bool"], *spec["int"])]
            names += [(k, True) for k in spec["fk"]]
            for key, is_fk in names:
                name = key[:-3] if (is_fk and key.endswith("_id")) else key
                try:
                    model._meta.get_field(name)
                except Exception:
                    missing.append(f"{model._meta.label_lower}.{key}")
        self.assertEqual(missing, [], "Allow-listed fields that don't exist")

    def test_every_declared_field_gets_a_descriptor(self):
        """If a declared field yields no descriptor, the endpoint silently drops
        it and it becomes unplannable - worth failing loudly instead."""
        dropped = []
        for model, spec in covered_models():
            declared = {
                *spec["str"], *spec["bool"], *spec["int"], *spec["fk"].keys()
            }
            described = {d.key for d in fields_for(model)}
            dropped += [
                f"{model._meta.label_lower}.{k}" for k in sorted(declared - described)
            ]
        self.assertEqual(dropped, [], "Declared fields with no editor descriptor")

    def test_kinds_are_all_known(self):
        for model, _spec in covered_models():
            for d in fields_for(model):
                self.assertIn(d.kind, VALID_KINDS, f"{model}.{d.key}")

    def test_choice_fields_reference_a_real_dcim_key_with_matching_values(self):
        """Closes DCIM_CHOICE_KEYS' drift risk from both ends: the key must
        exist in the published payload AND carry the model's own values."""
        self.client.force_login(User.objects.create_superuser("su", "s@x.com", "x"))
        payload = self.client.get("/api/dcim/choices/").json()
        for (label, field_name), key in DCIM_CHOICE_KEYS.items():
            self.assertIn(key, payload, f"{label}.{field_name} → missing {key}")
            published = {c["value"] for c in payload[key]}
            model = apps.get_model(label)
            declared = {
                v for v, _l in model._meta.get_field(field_name).flatchoices
            }
            self.assertTrue(
                declared <= published,
                f"{label}.{field_name}: {sorted(declared - published)} "
                f"missing from /api/dcim/choices/{key}",
            )

    def test_object_kind_always_carries_an_endpoint(self):
        """An `object` field with no endpoint can't render a picker."""
        broken = []
        for model, _spec in covered_models():
            for d in fields_for(model):
                if d.kind == "object" and not d.endpoint:
                    broken.append(f"{model._meta.label_lower}.{d.key}")
        self.assertEqual(broken, [], "object fields with no endpoint")

    def test_every_covered_model_has_a_serializer(self):
        """The planned-change apply path writes through the target's serializer,
        so a covered model without one would fail only at apply time."""
        missing = [
            m._meta.label_lower for m, _s in covered_models()
            if serializer_for(m) is None
        ]
        self.assertEqual(missing, [])

    def test_bytes_kind_is_name_derived(self):
        item = apps.get_model("api", "InventoryItem")
        specs = {d.key: d.kind for d in fields_for(item)}
        for key, kind in specs.items():
            if key.endswith("_bytes"):
                self.assertEqual(kind, "bytes", key)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

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


class EndpointTests(_Base):
    def test_lists_covered_models(self):
        r = self.client.get("/api/editable-fields/")
        self.assertEqual(r.status_code, 200, r.content)
        slugs = {m["slug"] for m in r.json()["models"]}
        for expected in ("device", "interface", "prefix", "ipaddress", "vlan"):
            self.assertIn(expected, slugs)

    def test_advertises_exactly_the_allow_list(self):
        for slug in ("interface", "device", "prefix", "ipaddress", "vlan"):
            model = apps.get_model("api", slug)
            r = self.client.get(f"/api/editable-fields/?model={slug}")
            self.assertEqual(r.status_code, 200, r.content)
            served = {f["key"] for f in r.json()["fields"]}
            self.assertEqual(served, {d.key for d in fields_for(model)}, slug)

    def test_accepts_app_label_too(self):
        r = self.client.get("/api/editable-fields/?model=api.interface")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["slug"], "interface")

    def test_unknown_model_404s(self):
        self.assertEqual(
            self.client.get("/api/editable-fields/?model=nope").status_code, 404
        )

    def test_hides_models_the_caller_cannot_change(self):
        """Fail closed: the endpoint is metadata about writes, so it is filtered
        by the write permission, not merely by authentication."""
        viewer = User.objects.create_user("viewer", "v@x.com", "x")
        profile, _ = UserProfile.objects.get_or_create(user=viewer)
        profile.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="iface-view", enabled=True,
            object_types=["interface"], actions=["view"],
        )
        perm.users.add(viewer)
        perm.tenants.add(self.tenant)
        self.client.force_login(viewer)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

        slugs = {m["slug"] for m in self.client.get("/api/editable-fields/").json()["models"]}
        self.assertNotIn("device", slugs)
        self.assertNotIn("interface", slugs)  # view is not change
        self.assertEqual(
            self.client.get("/api/editable-fields/?model=device").status_code, 403
        )


class BulkAgreementTests(_Base):
    """The registry must never advertise a field the write path would reject."""

    def test_bulk_update_accepts_everything_the_registry_advertises(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi1/1")
        samples = {
            "enabled": False,
            "mgmt_only": True,
            "mark_connected": True,
            "mtu": 9000,
            "description": "planned",
            "speed": "10000",
            "type": "10gbase-x-sfpp",
            "mode": "access",
            "duplex": "full",
            "vlan_id": None,
            "vrf_id": None,
        }
        advertised = {d.key for d in fields_for(Interface)}
        self.assertTrue(
            advertised <= set(samples),
            f"No sample value for {sorted(advertised - set(samples))} - extend "
            f"this test when the allow-list grows.",
        )
        for key in sorted(advertised):
            r = self.client.post(
                "/api/interfaces/bulk-update/",
                {"ids": [str(iface.id)], "fields": {key: samples[key]}},
                format="json",
            )
            self.assertEqual(r.status_code, 200, f"{key}: {r.content}")

    def test_registry_is_a_subset_of_the_bespoke_bulk_actions(self):
        """Prefix/IP/VLAN hand-roll their own bulk_update. The registry mirrors
        them by declaration, so assert the mirror is honest."""
        expected = {
            "prefix": {"status_id", "vrf_id", "site_id", "vlan_id", "description"},
            "ipaddress": {"status_id", "role_id", "description"},
            "vlan": {"site_id", "zone_id", "description"},
        }
        for slug, accepted in expected.items():
            model = apps.get_model("api", slug)
            advertised = {d.key for d in fields_for(model)}
            self.assertTrue(
                advertised <= accepted,
                f"{slug} advertises {sorted(advertised - accepted)} which its "
                f"bulk_update does not accept",
            )


class CoerceAndReadTests(_Base):
    """coerce_value/read_value are shared with the planned-change apply path, so
    their behaviour is part of the contract, not an implementation detail."""

    def test_bool_int_and_choice(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi1/1", enabled=True)

        spec = field_for(Interface, "enabled")
        self.assertEqual(coerce_value(Interface, spec, False, tenant=self.tenant),
                         (False, "No"))
        self.assertEqual(read_value(iface, spec), (True, "Yes"))

        spec = field_for(Interface, "mtu")
        self.assertEqual(coerce_value(Interface, spec, 9000, tenant=self.tenant),
                         (9000, "9000"))
        with self.assertRaises(ValidationError):
            coerce_value(Interface, spec, "9000", tenant=self.tenant)

        spec = field_for(Interface, "mode")
        with self.assertRaises(ValidationError):
            coerce_value(Interface, spec, "bogus", tenant=self.tenant)

    def test_status_available_to_is_enforced(self):
        """The bulk FK path only checks the tenant; this path also checks that
        the Status is actually offered for the model being written."""
        dev = self._device()
        spec = field_for(Device, "status_id")
        wrong = Status.objects.create(
            tenant=self.tenant, name="Reserved-for-prefixes", slug="rfp",
            available_to=["prefix"],
        )
        with self.assertRaises(ValidationError):
            coerce_value(Device, spec, str(wrong.id), tenant=self.tenant)

        ok = Status.objects.create(
            tenant=self.tenant, name="Decommissioning", slug="decomm",
            available_to=["device"],
        )
        value, display = coerce_value(Device, spec, str(ok.id), tenant=self.tenant)
        self.assertEqual(value, str(ok.id))
        self.assertEqual(display, "Decommissioning")
        self.assertEqual(read_value(dev, spec)[1], str(dev.status))

    def test_cross_tenant_fk_rejected(self):
        spec = field_for(Device, "site_id")
        foreign = Site.objects.create(tenant=self.other, name="Theirs")
        with self.assertRaises(ValidationError):
            coerce_value(Device, spec, str(foreign.id), tenant=self.tenant)
