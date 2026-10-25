"""Application groups (#436): named sets of applications assigned to a device
or VM in one step. Assigning records the installs, unassigning and member
changes follow them; the API keeps to the tenant and the caller's sites; the
Ansible inventory names the groups and applications."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api import applications as sync
from api.models import (
    Application,
    ApplicationGroup,
    ApplicationGroupAssignment,
    Cluster,
    ClusterType,
    Device,
    InstalledSoftware,
    Service,
    Site,
    VirtualMachine,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

GROUPS = "/api/application-groups/"
ASSIGN = "/api/application-group-assignments/"
SW = "/api/installed-software/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.dev = Device.objects.create(tenant=self.tenant, name="rds1", site=self.site_a)
        self.dev_b = Device.objects.create(tenant=self.tenant, name="rds2", site=self.site_b)
        ct = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        cl = Cluster.objects.create(tenant=self.tenant, name="C", type=ct)
        self.vm = VirtualMachine.objects.create(tenant=self.tenant, name="vm1", cluster=cl)
        self.rdsh = self.app("RD Session Host", "rdsh")
        self.office = self.app("Office", "office")
        self.av = self.app("Antivirus", "av")
        self.group = ApplicationGroup.objects.create(tenant=self.tenant, name="RDS", slug="rds")
        sync.add_member(self.group, self.rdsh, "2022", 0)
        sync.add_member(self.group, self.office, "365", 1)
        self.admin = User.objects.create_superuser("groups-root", password="x")
        self.login(self.admin)

    def app(self, name, slug, tenant=None):
        return Application.objects.create(tenant=tenant or self.tenant, name=name, slug=slug)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None

    def installs(self, **host):
        host = host or {"device": self.dev}
        return {
            i.application.slug: i
            for i in InstalledSoftware.objects.filter(**host).select_related("application")
        }


class SyncRuleTests(_Base):
    def test_assign_creates_one_install_per_member(self):
        assignment, created = sync.assign_group(self.group, device=self.dev)
        self.assertEqual(len(created), 2)
        got = self.installs()
        self.assertEqual({k: (i.version, i.source, i.group_id) for k, i in got.items()}, {
            "rdsh": ("2022", "group", self.group.pk),
            "office": ("365", "group", self.group.pk),
        })
        self.assertEqual(assignment.tenant_id, self.tenant.pk)

    def test_an_existing_install_is_left_alone(self):
        mine = InstalledSoftware.objects.create(
            tenant=self.tenant, application=self.office, version="2019", device=self.dev)
        _a, created = sync.assign_group(self.group, device=self.dev)
        self.assertEqual([i.application_id for i in created], [self.rdsh.pk])
        mine.refresh_from_db()
        self.assertEqual((mine.version, mine.source, mine.group_id), ("2019", "manual", None))
        sync.unassign_group(ApplicationGroupAssignment.objects.get(device=self.dev))
        self.assertTrue(InstalledSoftware.objects.filter(pk=mine.pk).exists())

    def test_reassigning_makes_no_duplicates(self):
        a, _ = sync.assign_group(self.group, device=self.dev)
        sync.unassign_group(a)
        sync.assign_group(self.group, device=self.dev)
        self.assertEqual(InstalledSoftware.objects.filter(device=self.dev).count(), 2)
        # A second group with the same application adds nothing for it.
        other = ApplicationGroup.objects.create(tenant=self.tenant, name="Desk", slug="desk")
        sync.add_member(other, self.office, "365")
        _a, created = sync.assign_group(other, device=self.dev)
        self.assertEqual(created, [])
        self.assertEqual(InstalledSoftware.objects.filter(device=self.dev).count(), 2)

    def test_unassign_removes_untouched_and_keeps_edited(self):
        a, _ = sync.assign_group(self.group, device=self.dev)
        office = self.installs()["office"]
        office.version = "2024"
        office.save()
        counts = sync.unassign_group(a)
        self.assertEqual(counts, {"removed": 1, "kept": 1, "moved": 0})
        got = self.installs()
        self.assertEqual(list(got), ["office"])
        self.assertIsNone(got["office"].group_id)
        self.assertFalse(ApplicationGroupAssignment.objects.exists())

    def test_a_service_or_a_manual_cycle_counts_as_edited(self):
        a, _ = sync.assign_group(self.group, device=self.dev)
        svc = Service.objects.create(tenant=self.tenant, device=self.dev, name="rdp",
                                     ports=[3389])
        got = self.installs()
        got["rdsh"].service = svc
        got["rdsh"].save()
        got["office"].cycle, got["office"].cycle_manual = "365", True
        got["office"].save()
        self.assertEqual(sync.unassign_group(a)["kept"], 2)

    def test_another_group_on_the_host_takes_the_install_over(self):
        desk = ApplicationGroup.objects.create(tenant=self.tenant, name="Desk", slug="desk")
        sync.add_member(desk, self.office, "365")
        a, _ = sync.assign_group(self.group, device=self.dev)
        sync.assign_group(desk, device=self.dev)
        counts = sync.unassign_group(a)
        self.assertEqual(counts, {"removed": 1, "kept": 0, "moved": 1})
        self.assertEqual(self.installs()["office"].group_id, desk.pk)

    def test_a_new_member_is_installed_on_every_assigned_host(self):
        sync.assign_group(self.group, device=self.dev)
        sync.assign_group(self.group, virtual_machine=self.vm)
        sync.add_member(self.group, self.av, "7")
        self.assertEqual(self.installs()["av"].version, "7")
        self.assertEqual(self.installs(virtual_machine=self.vm)["av"].group_id, self.group.pk)

    def test_a_removed_member_takes_its_untouched_installs(self):
        sync.assign_group(self.group, device=self.dev)
        sync.assign_group(self.group, device=self.dev_b)
        edited = self.installs(device=self.dev_b)["office"]
        edited.version = "2021"
        edited.save()
        sync.remove_member(self.group.members.get(application=self.office))
        self.assertNotIn("office", self.installs())
        kept = self.installs(device=self.dev_b)["office"]
        self.assertEqual((kept.version, kept.group_id), ("2021", None))

    def test_a_new_default_version_moves_the_untouched_installs(self):
        sync.assign_group(self.group, device=self.dev)
        sync.assign_group(self.group, device=self.dev_b)
        edited = self.installs(device=self.dev_b)["rdsh"]
        edited.version = "2019"
        edited.save()
        sync.set_member_version(self.group.members.get(application=self.rdsh), "2025")
        self.assertEqual(self.installs()["rdsh"].version, "2025")
        self.assertEqual(self.installs(device=self.dev_b)["rdsh"].version, "2019")

    def test_set_members_adds_removes_and_orders(self):
        sync.assign_group(self.group, device=self.dev)
        sync.set_members(self.group, [(self.av, "7"), (self.rdsh, "2022")])
        self.assertEqual(
            list(self.group.members.values_list("application__slug", "position")),
            [("av", 0), ("rdsh", 1)],
        )
        self.assertEqual(sorted(self.installs()), ["av", "rdsh"])

    def test_set_host_groups(self):
        desk = ApplicationGroup.objects.create(tenant=self.tenant, name="Desk", slug="desk")
        sync.add_member(desk, self.av, "")
        out = sync.set_host_groups([self.group], device=self.dev)
        self.assertEqual(out, {"assigned": [self.group.pk], "unassigned": []})
        out = sync.set_host_groups([desk], device=self.dev)
        self.assertEqual(out, {"assigned": [desk.pk], "unassigned": [self.group.pk]})
        self.assertEqual(sorted(self.installs()), ["av"])

    def test_deleting_the_host_takes_its_assignments(self):
        sync.assign_group(self.group, device=self.dev)
        self.dev.delete()
        self.assertFalse(ApplicationGroupAssignment.objects.exists())
        self.assertFalse(InstalledSoftware.objects.exists())


class GroupApiTests(_Base):
    def test_crud_with_members(self):
        body = self.ok(self.client.post(GROUPS, {
            "name": "SCADA",
            "members": [{"application_id": str(self.av.id), "version": "7"},
                        {"application_id": str(self.office.id)}],
        }, format="json"), 201)
        self.assertEqual(body["slug"], "scada")
        self.assertEqual([m["application"]["slug"] for m in body["members"]], ["av", "office"])
        self.assertEqual(body["member_count"], 2)
        gid = body["id"]
        body = self.ok(self.client.patch(f"{GROUPS}{gid}/", {
            "members": [{"application_id": str(self.office.id), "version": "365"}],
        }, format="json"))
        self.assertEqual([(m["application"]["slug"], m["version"]) for m in body["members"]],
                         [("office", "365")])
        self.ok(self.client.delete(f"{GROUPS}{gid}/"), 204)

    def test_members_listed_twice_are_refused(self):
        r = self.client.post(GROUPS, {"name": "X", "members": [
            {"application_id": str(self.av.id)}, {"application_id": str(self.av.id)},
        ]}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_counts_and_filters(self):
        sync.assign_group(self.group, device=self.dev)
        other = ApplicationGroup.objects.create(tenant=self.tenant, name="Other", slug="o")
        row = self.ok(self.client.get(f"{GROUPS}{self.group.id}/"))
        self.assertEqual((row["member_count"], row["host_count"], row["install_count"]),
                         (2, 1, 2))
        names = lambda q: [r["name"] for r in self.ok(self.client.get(f"{GROUPS}?{q}"))["results"]]  # noqa: E731
        self.assertEqual(names(f"application={self.office.id}"), ["RDS"])
        self.assertEqual(names(f"device={self.dev.id}"), ["RDS"])
        self.assertEqual(names(f"virtual_machine={self.vm.id}"), [])
        self.assertEqual(names("search=oth"), [other.name])
        picker = self.ok(self.client.get(f"{GROUPS}?picker=1"))["results"]
        self.assertLessEqual({"id", "name", "slug"}, set(picker[0]))
        self.assertNotIn("members", picker[0])

    def test_delete_is_refused_while_assigned(self):
        sync.assign_group(self.group, device=self.dev)
        self.assertEqual(self.client.delete(f"{GROUPS}{self.group.id}/").status_code, 409)
        body = self.ok(self.client.post(f"{GROUPS}bulk-delete/", {"ids": [str(self.group.id)]},
                                        format="json"))
        self.assertTrue(ApplicationGroup.objects.filter(pk=self.group.pk).exists(), body)

    def test_tenant_isolation(self):
        theirs = ApplicationGroup.objects.create(tenant=self.other, name="Theirs", slug="t")
        their_app = self.app("Theirs", "theirs", tenant=self.other)
        names = [r["name"] for r in self.ok(self.client.get(GROUPS))["results"]]
        self.assertNotIn("Theirs", names)
        self.assertEqual(self.client.get(f"{GROUPS}{theirs.id}/").status_code, 404)
        r = self.client.patch(f"{GROUPS}{self.group.id}/", {
            "members": [{"application_id": str(their_app.id)}]}, format="json")
        self.assertEqual(r.status_code, 400)
        their_dev = Device.objects.create(
            tenant=self.other, name="x", site=Site.objects.create(tenant=self.other, name="S"))
        r = self.client.post(ASSIGN, {"group_id": str(self.group.id),
                                      "device_id": str(their_dev.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(ASSIGN, {"group_id": str(theirs.id),
                                      "device_id": str(self.dev.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(InstalledSoftware.objects.exists())

    def test_default_closed(self):
        user = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.client.get(GROUPS).status_code, 403)
        self.assertEqual(self.client.get(ASSIGN).status_code, 403)


class AssignmentApiTests(_Base):
    def test_assign_and_unassign(self):
        body = self.ok(self.client.post(ASSIGN, {
            "group_id": str(self.group.id), "device_id": str(self.dev.id)}, format="json"), 201)
        self.assertEqual((body["group"]["slug"], body["device"]["name"], body["install_count"]),
                         ("rds", "rds1", 2))
        rows = self.ok(self.client.get(f"{SW}?device={self.dev.id}"))["results"]
        self.assertEqual({r["group"]["slug"] for r in rows}, {"rds"})
        self.assertEqual({r["source"] for r in rows}, {"group"})
        r = self.client.post(ASSIGN, {"group_id": str(self.group.id),
                                      "device_id": str(self.dev.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        listed = self.ok(self.client.get(f"{ASSIGN}?device={self.dev.id}"))["results"]
        self.assertEqual(len(listed), 1)
        counts = self.ok(self.client.delete(f"{ASSIGN}{body['id']}/"))
        self.assertEqual(counts, {"removed": 2, "kept": 0, "moved": 0})
        self.assertFalse(InstalledSoftware.objects.exists())

    def test_exactly_one_host(self):
        r = self.client.post(ASSIGN, {"group_id": str(self.group.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(ASSIGN, {"group_id": str(self.group.id),
                                      "device_id": str(self.dev.id),
                                      "virtual_machine_id": str(self.vm.id)}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_set_a_hosts_groups(self):
        desk = ApplicationGroup.objects.create(tenant=self.tenant, name="Desk", slug="desk")
        body = self.ok(self.client.post(f"{ASSIGN}set/", {
            "virtual_machine_id": str(self.vm.id),
            "group_ids": [str(self.group.id), str(desk.id)]}, format="json"))
        self.assertEqual(len(body["results"]), 2)
        body = self.ok(self.client.post(f"{ASSIGN}set/", {
            "virtual_machine_id": str(self.vm.id), "group_ids": [str(desk.id)]}, format="json"))
        self.assertEqual(body["unassigned"], [str(self.group.id)])
        self.assertFalse(InstalledSoftware.objects.filter(virtual_machine=self.vm).exists())

    def _site_editor(self, types):
        user = User.objects.create_user("site-ed", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="ed", object_types=types, actions=["view", "add", "change", "delete"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        p.sites.set([self.site_a])
        view = ObjectPermission.objects.create(
            name="cat", object_types=["applicationgroup", "application"], actions=["view"])
        view.users.add(user)
        view.tenants.add(self.tenant)
        self.login(user)
        return user

    def test_a_site_editor_assigns_in_their_sites_only(self):
        self._site_editor(["applicationgroupassignment", "installedsoftware", "device"])
        self.ok(self.client.post(ASSIGN, {"group_id": str(self.group.id),
                                          "device_id": str(self.dev.id)}, format="json"), 201)
        r = self.client.post(ASSIGN, {"group_id": str(self.group.id),
                                      "device_id": str(self.dev_b.id)}, format="json")
        self.assertIn(r.status_code, (400, 403))
        self.assertFalse(InstalledSoftware.objects.filter(device=self.dev_b).exists())

    def test_assigning_needs_the_right_to_add_software(self):
        self._site_editor(["applicationgroupassignment", "device"])
        r = self.client.post(ASSIGN, {"group_id": str(self.group.id),
                                      "device_id": str(self.dev.id)}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertFalse(ApplicationGroupAssignment.objects.exists())
        self.assertFalse(InstalledSoftware.objects.exists())


def _csv(resp) -> str:
    content = b"".join(resp.streaming_content) if resp.streaming else resp.content
    return content.decode().lstrip("﻿")


class ImportExportTests(_Base):
    def test_group_round_trip(self):
        import csv
        import io

        text = _csv(self.client.get("/api/io/applicationgroup/export/?fmt=csv"))
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual([r["slug"] for r in rows], ["rds"])
        body = self.ok(self.client.post("/api/io/applicationgroup/import/",
                                        {"format": "csv", "content": text}, format="json"))
        self.assertEqual((body["created"], body["errors"]), (0, []))
        self.assertEqual(self.group.members.count(), 2)

    def test_installs_export_their_group_and_assignments_are_export_only(self):
        import csv
        import io

        sync.assign_group(self.group, device=self.dev)
        text = _csv(self.client.get("/api/io/installedsoftware/export/?fmt=csv"))
        self.assertEqual({r["group"] for r in csv.DictReader(io.StringIO(text))}, {"rds"})
        text = _csv(self.client.get("/api/io/applicationgroupassignment/export/?fmt=csv"))
        row = next(csv.DictReader(io.StringIO(text)))
        self.assertEqual((row["group"], row["device"]), ("rds", "rds1"))
        r = self.client.post("/api/io/applicationgroupassignment/import/",
                             {"format": "csv", "content": text}, format="json")
        self.assertGreaterEqual(r.status_code, 400)


class InventoryTests(_Base):
    def test_hosts_carry_groups_and_applications(self):
        sync.assign_group(self.group, device=self.dev)
        sync.assign_group(self.group, virtual_machine=self.vm)
        InstalledSoftware.objects.create(tenant=self.tenant, application=self.av,
                                         version="", device=self.dev)
        inv = self.ok(self.client.get("/api/inventory/ansible/"))
        hv = inv["_meta"]["hostvars"]["rds1"]["danbyte"]
        self.assertEqual(hv["application_groups"], ["rds"])
        self.assertEqual(sorted((a["slug"], a["version"], a["group"]) for a in hv["applications"]), [
            ("av", None, None), ("office", "365", "rds"), ("rdsh", "2022", "rds"),
        ])
        self.assertEqual(set(hv["applications"][0]), {"name", "slug", "version", "group"})
        self.assertEqual(inv["app_group_rds"]["hosts"], ["rds1", "vm1"])
        vm = inv["_meta"]["hostvars"]["vm1"]["danbyte"]
        self.assertEqual(vm["application_groups"], ["rds"])
        self.assertEqual(inv["_meta"]["hostvars"]["rds2"]["danbyte"]["applications"], [])

    def test_per_device_preview(self):
        sync.assign_group(self.group, device=self.dev)
        body = self.ok(self.client.get(f"/api/devices/{self.dev.id}/inventory/"))
        self.assertIn("app_group_rds", body["groups"])
        self.assertEqual(body["hostvars"]["danbyte"]["application_groups"], ["rds"])
