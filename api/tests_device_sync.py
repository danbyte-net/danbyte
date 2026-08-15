"""Sync a device to its device type's current component templates —
``diff_device_components`` / ``sync_device_components`` and the
``/api/devices/{id}/sync-from-type/`` action."""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    Device,
    DeviceType,
    Interface,
    InterfaceTemplate,
    IPAddress,
    Prefix,
    diff_device_components,
    materialize_device_components,
    sync_device_components,
)
from api.tests import status_for
from core.models import Organization, Tenant


class DeviceSyncTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="SW-24")
        InterfaceTemplate.objects.create(
            device_type=self.dt, name="Gi0/1", type="1000base-t"
        )
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt
        )
        materialize_device_components(self.dev)  # → Gi0/1
        self.user = get_user_model().objects.create_superuser(
            "admin", "a@b.c", "pw"
        )
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_diff_reports_added_and_extra(self):
        # Type gains Gi0/2; device has an extra hand-added Gi9/9.
        InterfaceTemplate.objects.create(
            device_type=self.dt, name="Gi0/2", type="1000base-t"
        )
        Interface.objects.create(device=self.dev, name="Gi9/9")
        diff = diff_device_components(self.dev)
        self.assertEqual(diff["interfaces"]["add"], ["Gi0/2"])
        self.assertEqual(diff["interfaces"]["extra"], ["Gi9/9"])

    def test_apply_adds_missing_without_removing(self):
        InterfaceTemplate.objects.create(
            device_type=self.dt, name="Gi0/2", type="1000base-t"
        )
        Interface.objects.create(device=self.dev, name="Gi9/9")
        sync_device_components(self.dev, remove_extra=False)
        names = set(self.dev.interfaces.values_list("name", flat=True))
        self.assertEqual(names, {"Gi0/1", "Gi0/2", "Gi9/9"})

    def test_remove_extra_deletes_untemplated(self):
        Interface.objects.create(device=self.dev, name="Gi9/9")
        sync_device_components(self.dev, remove_extra=True)
        names = set(self.dev.interfaces.values_list("name", flat=True))
        self.assertEqual(names, {"Gi0/1"})

    def test_endpoint_preview_does_not_mutate(self):
        Interface.objects.create(device=self.dev, name="Gi9/9")
        r = self.client.post(
            f"/api/devices/{self.dev.id}/sync-from-type/", {}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["applied"])
        self.assertEqual(r.json()["diff"]["interfaces"]["extra"], ["Gi9/9"])
        # Nothing removed.
        self.assertTrue(self.dev.interfaces.filter(name="Gi9/9").exists())

    def test_endpoint_apply_remove_reports_risk(self):
        prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant)
        )
        extra = Interface.objects.create(device=self.dev, name="Gi9/9")
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=prefix,
            assigned_device=self.dev, assigned_interface=extra,
        )
        r = self.client.post(
            f"/api/devices/{self.dev.id}/sync-from-type/",
            {"apply": True, "remove_extra": True}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["risk"]["interfaces_with_ips"], 1)
        self.assertFalse(self.dev.interfaces.filter(name="Gi9/9").exists())

    def test_no_device_type_is_400(self):
        d = Device.objects.create(tenant=self.tenant, name="bare")
        r = self.client.post(
            f"/api/devices/{d.id}/sync-from-type/", {"apply": True},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)


class MarkerStampTests(DeviceSyncTests):
    """Faceplate slots and photo markers count as expectations: syncing stamps
    the components they reference even when no template defines them (#150)."""

    def _mark(self):
        self.dt.faceplate = {
            "v": 1,
            "front": [{
                "id": "g1", "rows": 1, "bank": 0,
                "slots": [{"t": "port", "kind": "interface", "name": "Gi0/9"}],
            }],
            "rear": [],
        }
        self.dt.image_ports = {
            "front": [
                {"kind": "inventory-item", "name": "Disk 1",
                 "x": 0.1, "y": 0.5, "w": 0.05, "h": 0.4},
                # Front ports need a rear-port mapping a marker can't express —
                # deliberately ignored rather than half-created.
                {"kind": "front-port", "name": "FP1",
                 "x": 0.2, "y": 0.5, "w": 0.05, "h": 0.4},
            ],
            "rear": [],
        }
        self.dt.save(update_fields=["faceplate", "image_ports"])

    def test_diff_counts_marker_names_as_expected(self):
        self._mark()
        diff = diff_device_components(self.dev)
        self.assertEqual(diff["interfaces"]["add"], ["Gi0/9"])
        self.assertEqual(diff["inventory_items"]["add"], ["Disk 1"])
        self.assertNotIn("front_ports", diff)

    def test_sync_stamps_bare_components_for_markers(self):
        self._mark()
        result = sync_device_components(self.dev)
        self.assertEqual(result["added"].get("interfaces"), 1)
        self.assertEqual(result["added"].get("inventory_items"), 1)
        iface = self.dev.interfaces.get(name="Gi0/9")
        self.assertEqual(iface.type, "other")
        self.assertTrue(self.dev.inventory_items.filter(name="Disk 1").exists())
        # Idempotent, and the marked components never read as "extra".
        again = sync_device_components(self.dev, remove_extra=True)
        self.assertEqual(again["added"], {})
        self.assertEqual(again["removed"], {})
        self.assertTrue(self.dev.interfaces.filter(name="Gi0/9").exists())
