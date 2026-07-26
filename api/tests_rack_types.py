"""Rack type catalog: CRUD + tenancy, the 0U accessory rules, and the
opt-in stamping that turns a rack model's factory PDU strips into real
side-mounted devices (with their outlets materialised) on rack creation."""

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User

from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Device,
    DeviceType,
    Manufacturer,
    PowerOutletTemplate,
    Rack,
    RackType,
    RackTypeAccessory,
    Site,
)


class RackTypeCatalogTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="APC")
        self.dt_pdu = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr,
            name="Rack PDU Advanced", u_height=0,
        )
        self.dt_1u = DeviceType.objects.create(
            tenant=self.tenant, name="R650", u_height=1
        )
        # A second tenant to prove the fences.
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        self.mfr2 = Manufacturer.objects.create(tenant=self.tenant2, name="X")
        self.dt2_pdu = DeviceType.objects.create(
            tenant=self.tenant2, name="Their PDU", u_height=0
        )
        self.rt2 = RackType.objects.create(
            tenant=self.tenant2, name="Their cabinet"
        )
        admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self._login(admin)

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _limited_user(self, name, object_types, actions, sites=None):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"{name}-grant", object_types=object_types, actions=actions
        )
        if sites:
            perm.sites.set(sites)
        perm.users.add(u)
        return u

    def _rack_type(self, name="NetShelter SX 42U", **extra):
        return self.client.post(
            "/api/rack-types/",
            {"name": name, "manufacturer_id": str(self.mfr.id),
             "u_height": 42, "width": 19, "outer_width_mm": 600,
             "outer_depth_mm": 1070, **extra},
            format="json",
        )

    def _accessory(self, rt_id, label="PDU-A", **extra):
        return self.client.post(
            "/api/rack-type-accessories/",
            {"rack_type_id": str(rt_id), "label": label,
             "device_type_id": str(self.dt_pdu.id), "mount": "side_left",
             "mount_offset_mm": 100, "mount_span_u": 38, **extra},
            format="json",
        )

    # ── Catalog CRUD ─────────────────────────────────────────────────────

    def test_rack_type_roundtrips(self):
        r = self._rack_type()
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["manufacturer"]["name"], "APC")
        self.assertEqual(body["u_height"], 42)
        self.assertEqual(body["outer_depth_mm"], 1070)
        self.assertEqual(body["rack_count"], 0)
        self.assertEqual(body["accessories"], [])

    def test_duplicate_name_rejected_cleanly(self):
        self.assertEqual(self._rack_type().status_code, 201)
        r = self._rack_type()
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.json())

    def test_picker_returns_dims_for_prefill(self):
        self._rack_type()
        rows = self.client.get("/api/rack-types/?picker=1").json()["results"]
        self.assertEqual(rows[0]["u_height"], 42)
        self.assertEqual(rows[0]["outer_width_mm"], 600)
        self.assertEqual(rows[0]["manufacturer"]["name"], "APC")

    def test_delete_refused_while_racks_use_it(self):
        rt_id = self._rack_type().json()["id"]
        Rack.objects.create(
            tenant=self.tenant, site=self.site, name="r1",
            rack_type_id=rt_id,
        )
        r = self.client.delete(f"/api/rack-types/{rt_id}/")
        self.assertEqual(r.status_code, 409)

    def test_other_tenants_types_invisible(self):
        self._rack_type()
        rows = self.client.get("/api/rack-types/?page_size=100").json()
        names = [x["name"] for x in rows["results"]]
        self.assertNotIn("Their cabinet", names)

    # ── Accessories ──────────────────────────────────────────────────────

    def test_accessory_requires_zero_u_type(self):
        rt_id = self._rack_type().json()["id"]
        r = self.client.post(
            "/api/rack-type-accessories/",
            {"rack_type_id": rt_id, "label": "shelf",
             "device_type_id": str(self.dt_1u.id), "mount": "side_left"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("device_type_id", r.json())

    def test_accessory_roundtrips_and_lists_by_type(self):
        rt_id = self._rack_type().json()["id"]
        r = self._accessory(rt_id)
        self.assertEqual(r.status_code, 201, r.content)
        self._accessory(rt_id, label="PDU-B", mount="side_right")
        rows = self.client.get(
            f"/api/rack-type-accessories/?rack_type={rt_id}"
        ).json()["results"]
        self.assertEqual([a["label"] for a in rows], ["PDU-A", "PDU-B"])
        self.assertEqual(rows[0]["device_type"]["u_height"], 0)

    def test_cross_tenant_rack_type_rejected(self):
        r = self._accessory(self.rt2.id)
        self.assertEqual(r.status_code, 400)

    def test_cross_tenant_device_type_rejected(self):
        rt_id = self._rack_type().json()["id"]
        r = self.client.post(
            "/api/rack-type-accessories/",
            {"rack_type_id": rt_id, "label": "PDU-A",
             "device_type_id": str(self.dt2_pdu.id), "mount": "side_left"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_cross_tenant_manufacturer_rejected(self):
        r = self._rack_type(manufacturer_id=str(self.mfr2.id))
        self.assertEqual(r.status_code, 400)

    # ── Stamping on rack creation ────────────────────────────────────────

    def _typed(self):
        rt_id = self._rack_type().json()["id"]
        self._accessory(rt_id, label="PDU-A", mount="side_left")
        self._accessory(rt_id, label="PDU-B", mount="side_right")
        return rt_id

    def _post_rack(self, name, rt_id, stamp):
        return self.client.post(
            "/api/racks/",
            {"name": name, "site_id": str(self.site.id),
             "rack_type_id": rt_id, "create_accessories": stamp},
            format="json",
        )

    def test_stamp_creates_mounted_devices_with_outlets(self):
        PowerOutletTemplate.objects.create(
            device_type=self.dt_pdu, name="out1"
        )
        rt_id = self._typed()
        r = self._post_rack("rack-01", rt_id, True)
        self.assertEqual(r.status_code, 201, r.content)
        rack = Rack.objects.get(name="rack-01")
        devs = {d.name: d for d in rack.devices.all()}
        self.assertEqual(set(devs), {"rack-01-PDU-A", "rack-01-PDU-B"})
        a = devs["rack-01-PDU-A"]
        self.assertEqual(a.mount, "side_left")
        self.assertEqual(a.mount_offset_mm, 100)
        self.assertEqual(a.mount_span_u, 38)
        self.assertIsNone(a.position)
        self.assertEqual(a.site_id, rack.site_id)
        # The type's outlet templates materialised — the PDU is a real PDU.
        self.assertEqual(a.power_outlets.count(), 1)
        # And the rack detail carries the type for the UI.
        body = self.client.get(f"/api/racks/{rack.id}/").json()
        self.assertEqual(body["rack_type"]["u_height"], 42)

    def test_stamp_dedupes_names(self):
        rt_id = self._typed()
        Device.objects.create(tenant=self.tenant, name="rack-02-PDU-A")
        self._post_rack("rack-02", rt_id, True)
        names = set(
            Device.objects.filter(tenant=self.tenant)
            .values_list("name", flat=True)
        )
        self.assertIn("rack-02-PDU-A-2", names)
        self.assertIn("rack-02-PDU-B", names)

    def test_no_stamp_unless_asked(self):
        rt_id = self._typed()
        self._post_rack("rack-03", rt_id, False)
        rack = Rack.objects.get(name="rack-03")
        self.assertEqual(rack.devices.count(), 0)
        self.assertEqual(str(rack.rack_type_id), rt_id)

    def test_stamp_without_device_grant_is_403_and_atomic(self):
        rt_id = self._typed()
        self._login(self._limited_user(
            "rackonly", ["rack", "racktype"], ["view", "add"]
        ))
        r = self._post_rack("rack-04", rt_id, True)
        self.assertEqual(r.status_code, 403)
        self.assertFalse(Rack.objects.filter(name="rack-04").exists())
        self.assertFalse(
            Device.objects.filter(name__startswith="rack-04").exists()
        )

    def test_stamp_denied_outside_device_site_scope(self):
        rt_id = self._typed()
        other = Site.objects.create(tenant=self.tenant, name="dc2")
        self._login(self._limited_user(
            "scoped", ["rack", "racktype", "device"], ["view", "add"],
            sites=[other],
        ))
        r = self._post_rack("rack-05", rt_id, True)
        self.assertEqual(r.status_code, 403)
        self.assertFalse(Rack.objects.filter(name="rack-05").exists())

    def test_rack_only_user_can_still_create_untyped_racks(self):
        self._login(self._limited_user("plain", ["rack"], ["view", "add"]))
        r = self.client.post(
            "/api/racks/",
            {"name": "rack-06", "site_id": str(self.site.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)

    # ── Re-syncing an existing rack with its type ────────────────────────

    def test_sync_dry_run_reports_drift_without_touching_anything(self):
        rt_id = self._typed()
        self._post_rack("rack-sync", rt_id, False)
        rack = Rack.objects.get(name="rack-sync")
        rack.u_height = 24
        rack.save(update_fields=["u_height"])

        r = self.client.post(
            f"/api/racks/{rack.id}/sync-from-type/", {}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertFalse(body["applied"])
        self.assertEqual(body["diff"]["dims"]["u_height"],
                         {"rack": 24, "type": 42})
        self.assertEqual(
            sorted(body["diff"]["accessories"]["add"]), ["PDU-A", "PDU-B"]
        )
        rack.refresh_from_db()
        self.assertEqual(rack.u_height, 24)      # dry run changed nothing
        self.assertEqual(rack.devices.count(), 0)

    def test_sync_applies_dims_and_stamps_missing_accessories(self):
        rt_id = self._typed()
        self._post_rack("rack-apply", rt_id, False)
        rack = Rack.objects.get(name="rack-apply")
        rack.u_height = 24
        rack.save(update_fields=["u_height"])

        r = self.client.post(
            f"/api/racks/{rack.id}/sync-from-type/", {"apply": True},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["applied"])
        rack.refresh_from_db()
        self.assertEqual(rack.u_height, 42)
        self.assertEqual(
            set(rack.devices.values_list("name", flat=True)),
            {"rack-apply-PDU-A", "rack-apply-PDU-B"},
        )

    def test_sync_is_idempotent(self):
        rt_id = self._typed()
        self._post_rack("rack-twice", rt_id, True)
        rack = Rack.objects.get(name="rack-twice")
        r = self.client.post(
            f"/api/racks/{rack.id}/sync-from-type/", {"apply": True},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        # Already stamped at create time — a second sync adds nothing.
        self.assertEqual(r.json()["result"]["accessories"], [])
        self.assertEqual(rack.devices.count(), 2)

    def test_sync_retypes_a_strip_when_the_accessory_changed(self):
        # The reported bug: swap the accessory's device type and sync said
        # "already matches" — it only ever asked whether a strip with that
        # label existed, never whether it still agreed with the accessory.
        rt_id = self._rack_type().json()["id"]
        acc_id = self._accessory(rt_id, label="PDU").json()["id"]
        self._post_rack("rack-retype", rt_id, True)
        dev = Device.objects.get(name="rack-retype-PDU")
        self.assertEqual(dev.device_type_id, self.dt_pdu.id)

        newer = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr,
            name="Rack PDU Advanced Gen 2", u_height=0,
        )
        self.client.patch(
            f"/api/rack-type-accessories/{acc_id}/",
            {"device_type_id": str(newer.id), "face": "rear"},
            format="json",
        )

        rack = Rack.objects.get(name="rack-retype")
        r = self.client.post(
            f"/api/racks/{rack.id}/sync-from-type/", {}, format="json"
        )
        changes = r.json()["diff"]["accessories"]["update"][0]["changes"]
        self.assertEqual(changes["device_type"]["type"],
                         "Rack PDU Advanced Gen 2")
        self.assertEqual(changes["face"]["type"], "rear")

        r = self.client.post(
            f"/api/racks/{rack.id}/sync-from-type/", {"apply": True},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["result"]["updated"], ["rack-retype-PDU"])
        dev.refresh_from_db()
        self.assertEqual(dev.device_type_id, newer.id)
        self.assertEqual(dev.face, "rear")
        # Re-pointing a type never duplicates the strip.
        self.assertEqual(rack.devices.count(), 1)

    def test_sync_never_deletes_an_extra_strip(self):
        rt_id = self._typed()
        self._post_rack("rack-extra", rt_id, True)
        rack = Rack.objects.get(name="rack-extra")
        # A strip nobody's type defines any more — real, possibly cabled gear.
        Device.objects.create(
            tenant=self.tenant, name="rack-extra-PDU-Z", site=self.site,
            rack=rack, device_type=self.dt_pdu, mount="side_left",
        )
        r = self.client.post(
            f"/api/racks/{rack.id}/sync-from-type/", {"apply": True},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            r.json()["diff"]["accessories"]["extra"], ["rack-extra-PDU-Z"]
        )
        self.assertTrue(
            Device.objects.filter(name="rack-extra-PDU-Z").exists()
        )

    def test_sync_can_take_dims_only(self):
        rt_id = self._typed()
        self._post_rack("rack-dims", rt_id, False)
        rack = Rack.objects.get(name="rack-dims")
        rack.u_height = 12
        rack.save(update_fields=["u_height"])
        r = self.client.post(
            f"/api/racks/{rack.id}/sync-from-type/",
            {"apply": True, "accessories": False},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        rack.refresh_from_db()
        self.assertEqual(rack.u_height, 42)
        self.assertEqual(rack.devices.count(), 0)

    def test_sync_refused_without_a_type(self):
        rack = Rack.objects.create(
            tenant=self.tenant, site=self.site, name="rack-bare"
        )
        r = self.client.post(
            f"/api/racks/{rack.id}/sync-from-type/", {}, format="json"
        )
        self.assertEqual(r.status_code, 400)

    def test_accessory_face_stamps_onto_the_device(self):
        # The channel an accessory names must reach the stamped device —
        # otherwise every factory PDU lands face-blank and draws on both
        # elevations, which is the thing this field exists to stop.
        rt_id = self._rack_type().json()["id"]
        self._accessory(rt_id, label="PDU-A", mount="side_left", face="rear")
        self._post_rack("rack-face", rt_id, True)
        dev = Device.objects.get(name="rack-face-PDU-A")
        self.assertEqual(dev.face, "rear")
        self.assertEqual(dev.mount, "side_left")

    def test_accessory_face_defaults_to_unspecified(self):
        rt_id = self._rack_type().json()["id"]
        r = self._accessory(rt_id)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["face"], "")

    def test_accessory_audit_entries_carry_the_owning_tenant(self):
        # RackTypeAccessory has no tenant column; the audit trail stamps
        # instance.tenant_id, so the model resolves it through the parent —
        # otherwise these rows would log NULL/NULL and fail closed out of
        # the tenant's own history.
        from audit.models import ChangeLogEntry

        rt_id = self._rack_type().json()["id"]
        self._accessory(rt_id)
        entry = ChangeLogEntry.objects.filter(
            object_type="api.racktypeaccessory"
        ).latest("timestamp")
        self.assertEqual(entry.tenant_id, self.tenant.id)

    def test_accessory_of_foreign_tenant_hidden(self):
        RackTypeAccessory.objects.create(
            rack_type=self.rt2, device_type=self.dt2_pdu,
            label="theirs", mount="side_left",
        )
        rows = self.client.get(
            "/api/rack-type-accessories/?page_size=100"
        ).json()["results"]
        self.assertEqual(rows, [])
