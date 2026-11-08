"""Many devices for one profile: bulk assign with per-item outcomes, and
devices created from a name range (``POST /api/devices/bulk-create/``) with
the profile given to each."""
from __future__ import annotations

from django.contrib.auth.models import User

from api.models import Device, DeviceType, InstalledSoftware, Rack, VirtualMachine
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile

from .models import DeviceProfileAssignment
from .testing import ASSIGN, ProfileBase

CREATE = "/api/devices/bulk-create/"


class BulkMixin:
    def site_editor(self, types, actions=("view", "add", "change", "delete")):
        user = User.objects.create_user("site-ed", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(name="ed", object_types=types,
                                            actions=list(actions))
        p.users.add(user)
        p.tenants.add(self.tenant)
        p.sites.set([self.site_a])
        view = ObjectPermission.objects.create(
            name="cat", object_types=["deviceprofile", "applicationgroup", "application",
                                      "devicetype", "site", "tag"],
            actions=["view"])
        view.users.add(user)
        view.tenants.add(self.tenant)
        self.login(user)
        return user

    FULL = ["deviceprofileassignment", "applicationgroupassignment", "installedsoftware",
            "device", "virtualmachine"]


class BulkAssignTests(BulkMixin, ProfileBase):
    def setUp(self):
        super().setUp()
        self.p = self.profile("RDS-HR", groups_=[self.group], tags=[self.tag_rds],
                              cf={"owner": "HR"}, platform=self.win)

    def bulk(self, **kw):
        return self.client.post(f"{ASSIGN}bulk/", {
            "profile_id": str(self.p.id), "action": "assign", **kw}, format="json")

    def test_each_object_gets_what_a_single_assign_writes(self):
        self.ok(self.client.post(ASSIGN, {"profile_id": str(self.p.id),
                                          "device_id": str(self.dev.id)}, format="json"), 201)
        body = self.ok(self.bulk(device_ids=[str(self.dev.id), str(self.dev_b.id)]))
        self.assertEqual(body["counts"], {"unchanged": 1, "assigned": 1})
        by_id = {r["id"]: r for r in body["results"]}
        self.assertEqual(by_id[str(self.dev.id)]["detail"], "Already assigned.")
        self.assertEqual(by_id[str(self.dev_b.id)]["outcome"], "assigned")
        for d in (self.dev, self.dev_b):
            d = self.fresh(d)
            self.assertEqual(self.tags_of(d), {"rds"})
            self.assertEqual(d.platform_id, self.win.id)
            self.assertEqual(d.custom_fields.get("owner"), "HR")
            self.assertEqual(InstalledSoftware.objects.filter(device=d).count(), 2)

    def test_a_refused_object_names_why(self):
        self.p.applies_to_vms = False
        self.p.save()
        body = self.ok(self.bulk(virtual_machine_ids=[str(self.vm.id)]))
        self.assertEqual(body["counts"], {"refused": 1})
        self.assertIn("not for virtual machines", body["results"][0]["detail"])
        self.assertFalse(DeviceProfileAssignment.objects.filter(virtual_machine=self.vm).exists())

    def test_rbac_and_site_scope_per_object(self):
        self.site_editor(self.FULL)
        body = self.ok(self.bulk(device_ids=[str(self.dev.id), str(self.dev_b.id)]))
        self.assertEqual(body["counts"], {"assigned": 1, "denied": 1})
        denied = next(r for r in body["results"] if r["outcome"] == "denied")
        self.assertEqual(denied["id"], str(self.dev_b.id))
        # Outside the editor's sites: the name stays hidden, the reason shows.
        self.assertEqual(denied["name"], "")
        self.assertIn("Missing permission", denied["detail"])
        self.assertFalse(DeviceProfileAssignment.objects.filter(device=self.dev_b).exists())

    def test_without_assignment_add_the_request_is_refused(self):
        self.site_editor(["device"])
        self.assertEqual(self.bulk(device_ids=[str(self.dev.id)]).status_code, 403)
        self.assertFalse(DeviceProfileAssignment.objects.exists())


class BulkCreateTests(BulkMixin, ProfileBase):
    def setUp(self):
        super().setUp()
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="R650")
        self.p = self.profile("RDS-HR", groups_=[self.group], tags=[self.tag_rds],
                              cf={"owner": "HR"}, platform=self.win)

    def payload(self, name="DK-RDS-[1-10]", **kw):
        return {"name": name, "device_type_id": str(self.dt.id),
                "site_id": str(self.site_a.id), **kw}

    def test_a_range_creates_every_device_with_the_profile(self):
        body = self.ok(self.client.post(CREATE, self.payload(
            tag_ids=[self.tag_hr.id], profile_ids=[str(self.p.id)]), format="json"), 201)
        self.assertEqual(body["count"], 10)
        names = [r["name"] for r in body["results"]]
        self.assertEqual(names, [f"DK-RDS-{i}" for i in range(1, 11)])
        devices = Device.objects.filter(name__startswith="DK-RDS-")
        self.assertEqual(devices.count(), 10)
        for d in devices:
            self.assertEqual(d.site_id, self.site_a.id)
            self.assertEqual(d.device_type_id, self.dt.id)
            self.assertEqual(self.tags_of(d), {"hr", "rds"})
            self.assertEqual(d.platform_id, self.win.id)
            self.assertEqual(d.custom_fields.get("owner"), "HR")
            self.assertTrue(DeviceProfileAssignment.objects.filter(
                profile=self.p, device=d).exists())
        # Audited like ten single creates.
        self.assertEqual(ChangeLogEntry.objects.filter(
            object_type="api.device", action="create",
            object_repr__startswith="DK-RDS-").count(), 10)

    def test_zero_padding_follows_the_start_bound(self):
        body = self.ok(self.client.post(CREATE, self.payload("[0001-0100]"),
                                        format="json"), 201)
        self.assertEqual(body["count"], 100)
        self.assertEqual(body["results"][0]["name"], "0001")
        self.assertEqual(body["results"][-1]["name"], "0100")

    def test_a_taken_name_creates_none(self):
        Device.objects.create(tenant=self.tenant, name="DK-RDS-4", site=self.site_a)
        r = self.client.post(CREATE, self.payload(), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("DK-RDS-4", r.json()["name"])
        self.assertEqual(Device.objects.filter(name__startswith="DK-RDS-").count(), 1)
        self.assertFalse(ChangeLogEntry.objects.filter(
            object_type="api.device", action="create",
            object_repr__in=[f"DK-RDS-{i}" for i in (1, 2, 3, 5)]).exists())

    def test_a_failing_device_rolls_back_the_rest_and_is_named(self):
        self.p.applies_to_devices = False
        self.p.save()
        r = self.client.post(CREATE, self.payload("web-[1-3]", profile_ids=[str(self.p.id)]),
                             format="json")
        self.assertEqual(r.status_code, 400, r.content)
        body = r.json()
        self.assertEqual([f["name"] for f in body["failed"]], ["web-1", "web-2", "web-3"])
        self.assertIn("web-1", body["profile_ids"])
        self.assertIn("Nothing created", body["detail"])
        self.assertFalse(Device.objects.filter(name__startswith="web-").exists())
        self.assertFalse(DeviceProfileAssignment.objects.exists())
        self.assertFalse(ChangeLogEntry.objects.filter(
            object_type="api.device", action="create",
            object_repr__startswith="web-").exists())

    def test_cap_and_shape_of_the_range(self):
        for name in ("sw-[1-129]", "sw-[5-1]", "sw-[1-2]-[1-2]", "sw-{1-4}", "sw-1"):
            r = self.client.post(CREATE, self.payload(name), format="json")
            self.assertEqual(r.status_code, 400, name)
            self.assertIn("name", r.json())
        self.ok(self.client.post(CREATE, self.payload("sw-[1-128]"), format="json"), 201)
        self.assertEqual(Device.objects.filter(name__startswith="sw-").count(), 128)

    def test_per_device_fields_are_refused(self):
        rack = Rack.objects.create(tenant=self.tenant, name="R1", site=self.site_a)
        r = self.client.post(CREATE, self.payload(rack_id=str(rack.id), position=10,
                                                  serial_number="X1"), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(set(r.json()), {"position", "serial_number"})
        # A rack without a unit is shared fine.
        self.ok(self.client.post(CREATE, self.payload("r-[1-3]", rack_id=str(rack.id),
                                                      position=None), format="json"), 201)
        self.assertEqual(Device.objects.filter(rack=rack).count(), 3)

    def test_a_single_create_refuses_a_range(self):
        r = self.client.post("/api/devices/", self.payload(), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("bulk-create", r.json()["name"][0])
        self.assertFalse(Device.objects.filter(name__startswith="DK-").exists())

    def test_rbac_needs_add_on_device_and_its_site(self):
        self.site_editor(["device"], actions=("view", "change"))
        self.assertEqual(self.client.post(CREATE, self.payload(), format="json").status_code,
                         403)
        User.objects.filter(username="site-ed").delete()
        ObjectPermission.objects.all().delete()
        self.site_editor(["device"])
        r = self.client.post(CREATE, self.payload(site_id=str(self.site_b.id)), format="json")
        self.assertEqual(r.status_code, 403)
        self.ok(self.client.post(CREATE, self.payload(), format="json"), 201)
        self.assertEqual(set(Device.objects.filter(name__startswith="DK-RDS-")
                             .values_list("site_id", flat=True)), {self.site_a.id})

    def test_profile_rights_are_checked_and_roll_back(self):
        self.site_editor(["device"])
        r = self.client.post(CREATE, self.payload(profile_ids=[str(self.p.id)]),
                             format="json")
        self.assertEqual(r.status_code, 403)
        self.assertFalse(Device.objects.filter(name__startswith="DK-RDS-").exists())

    def test_foreign_ids_are_refused(self):
        theirs = self.profile("Theirs", tenant=self.other)
        r = self.client.post(CREATE, self.payload(profile_ids=[str(theirs.id)]),
                             format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("profile_ids", r.json())
        self.assertFalse(Device.objects.filter(name__startswith="DK-RDS-").exists())
        self.assertFalse(VirtualMachine.objects.filter(name__startswith="DK-").exists())
