"""Bulk removal from the MAC list (#251).

``POST /api/macs/bulk-remove/`` takes MAC values and removes them from the
places the caller picks. These pin the dry-run counts, the tenant boundary,
the per-source RBAC (grant and site scope) and the change-log entries.
"""

from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.mac_bulk import MAX_BULK_MACS
from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceType,
    Interface,
    IPAddress,
    MACAddress,
    Manufacturer,
    Prefix,
    Site,
    VirtualMachine,
    VMInterface,
)
from api.test_utils import status_for
from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

URL = "/api/macs/bulk-remove/"
A = "aa:bb:cc:00:00:01"
B = "aa:bb:cc:00:00:02"


class MacBulkRemoveTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="T2", slug="t2")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")

        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        ams1 = Device.objects.create(tenant=self.tenant, name="ams1", device_type=dt, site=self.ams)
        lon1 = Device.objects.create(tenant=self.tenant, name="lon1", device_type=dt, site=self.lon)
        # Stored as typed: upper case must still match the list's lower-case row.
        self.if_ams = Interface.objects.create(device=ams1, name="eth0", mac_address=A.upper())
        self.if_lon = Interface.objects.create(device=lon1, name="eth0", mac_address=A)
        ct = ClusterType.objects.create(tenant=self.tenant, name="c", slug="c")
        cl = Cluster.objects.create(tenant=self.tenant, name="C1", type=ct)
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1", cluster=cl, site=self.ams
        )
        self.vmi = VMInterface.objects.create(vm=vm, name="nic0", mac_address=A)
        self.ip_ams = self._ip(self.tenant, "10.1.0.5", self.ams)
        self.ip_lon = self._ip(self.tenant, "10.2.0.5", self.lon)
        self.obj_ams = MACAddress.objects.create(
            tenant=self.tenant, mac_address=A, assigned_interface=self.if_ams
        )
        self.obj_lon = MACAddress.objects.create(
            tenant=self.tenant, mac_address=A, assigned_interface=self.if_lon
        )
        self.obj_b = MACAddress.objects.create(tenant=self.tenant, mac_address=B)

        # The same MAC in another tenant - never touched from this one.
        omfr = Manufacturer.objects.create(tenant=self.other, name="M", slug="m")
        odt = DeviceType.objects.create(tenant=self.other, manufacturer=omfr, model="X")
        odev = Device.objects.create(tenant=self.other, name="x1", device_type=odt)
        self.foreign_if = Interface.objects.create(device=odev, name="eth0", mac_address=A)
        self.foreign_ip = self._ip(self.other, "10.9.0.5")
        self.foreign_obj = MACAddress.objects.create(tenant=self.other, mac_address=A)

        self.admin = User.objects.create_superuser("admin", "a@e.com", "x")
        self._login(self.admin)
        ChangeLogEntry.objects.all().delete()

    # ── helpers ────────────────────────────────────────────────────────────

    def _ip(self, tenant, address, site=None):
        net = address.rsplit(".", 1)[0] + ".0/24"
        prefix = Prefix.objects.create(
            tenant=tenant, cidr=net, site=site, status=status_for(tenant)
        )
        return IPAddress.objects.create(
            tenant=tenant, ip_address=address, prefix=prefix, site=site, mac_address=A
        )

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _user(self, name):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        return u

    def _grant(self, user, types, actions, sites=None):
        p = ObjectPermission.objects.create(
            name=f"{user.username}-{'-'.join(types)}-{'-'.join(actions)}",
            object_types=list(types),
            actions=list(actions),
        )
        p.users.add(user)
        if sites:
            p.sites.set(sites)

    def _post(self, **body):
        body.setdefault("values", [A])
        return self.client.post(URL, body, format="json")

    def _foreign_untouched(self):
        self.foreign_if.refresh_from_db()
        self.foreign_ip.refresh_from_db()
        self.assertEqual(self.foreign_if.mac_address, A)
        self.assertEqual(self.foreign_ip.mac_address, A)
        self.assertTrue(MACAddress.objects.filter(pk=self.foreign_obj.pk).exists())

    # ── dry run ────────────────────────────────────────────────────────────

    def test_dry_run_counts_every_source_and_writes_nothing(self):
        res = self._post(values=[A, B.upper(), A], dry_run=True)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertTrue(body["dry_run"])
        self.assertEqual(body["macs"], 2)
        counts = {k: v["count"] for k, v in body["sources"].items()}
        self.assertEqual(counts, {"objects": 3, "interfaces": 2, "vm_interfaces": 1, "ips": 2})
        for src in body["sources"].values():
            self.assertTrue(src["permitted"])
            self.assertFalse(src["applied"])
            self.assertEqual(src["skipped"], 0)
        self.assertEqual(MACAddress.objects.filter(tenant=self.tenant).count(), 3)
        self.if_ams.refresh_from_db()
        self.assertEqual(self.if_ams.mac_address, A.upper())
        self.assertFalse(ChangeLogEntry.objects.exists())

    # ── writes + change log ────────────────────────────────────────────────

    def test_default_deletes_the_objects_only(self):
        res = self._post()
        self.assertEqual(res.status_code, 200, res.content)
        src = res.json()["sources"]
        self.assertEqual(
            src["objects"],
            {
                "permitted": True,
                "count": 2,
                "skipped": 0,
                "applied": True,
            },
        )
        self.assertFalse(src["interfaces"]["applied"])
        self.assertFalse(src["ips"]["applied"])

        self.assertFalse(MACAddress.objects.filter(tenant=self.tenant, mac_address=A).exists())
        self.assertTrue(MACAddress.objects.filter(pk=self.obj_b.pk).exists())
        self.if_ams.refresh_from_db()
        self.ip_ams.refresh_from_db()
        self.assertEqual(self.if_ams.mac_address, A.upper())
        self.assertEqual(self.ip_ams.mac_address, A)
        self._foreign_untouched()

        # One DELETE entry per object - not two (the delete signal already
        # records each row).
        entries = ChangeLogEntry.objects.filter(
            object_type="api.macaddress", action=ChangeAction.DELETE
        )
        self.assertEqual(
            sorted(e.object_id for e in entries),
            sorted([str(self.obj_ams.pk), str(self.obj_lon.pk)]),
        )
        self.assertEqual({e.user_name for e in entries}, {"admin"})

    def test_clear_and_unpair_blank_the_strings_and_log_each_row(self):
        res = self._post(remove_objects=False, clear_interfaces=True, unpair_ips=True)
        self.assertEqual(res.status_code, 200, res.content)
        counts = {k: (v["count"], v["applied"]) for k, v in res.json()["sources"].items()}
        self.assertEqual(
            counts,
            {
                "objects": (2, False),
                "interfaces": (2, True),
                "vm_interfaces": (1, True),
                "ips": (2, True),
            },
        )
        for row in (self.if_ams, self.if_lon, self.vmi, self.ip_ams, self.ip_lon):
            row.refresh_from_db()
            self.assertEqual(row.mac_address, "")
        # The objects stay: only their strings were cleared.
        self.assertEqual(MACAddress.objects.filter(tenant=self.tenant, mac_address=A).count(), 2)
        self._foreign_untouched()

        updates = ChangeLogEntry.objects.filter(action=ChangeAction.UPDATE)
        by_type = {}
        for e in updates:
            by_type.setdefault(e.object_type, set()).add(e.object_id)
            self.assertEqual(e.changes["mac_address"]["new"], "")
            self.assertEqual(e.user_name, "admin")
        self.assertEqual(
            by_type,
            {
                "api.interface": {str(self.if_ams.pk), str(self.if_lon.pk)},
                "api.vminterface": {str(self.vmi.pk)},
                "api.ipaddress": {str(self.ip_ams.pk), str(self.ip_lon.pk)},
            },
        )
        self.assertFalse(ChangeLogEntry.objects.filter(action=ChangeAction.DELETE).exists())

    def test_a_value_only_another_tenant_holds_matches_nothing(self):
        MACAddress.objects.filter(tenant=self.tenant, mac_address=A).delete()
        Interface.objects.filter(pk__in=[self.if_ams.pk, self.if_lon.pk]).update(mac_address="")
        VMInterface.objects.filter(pk=self.vmi.pk).update(mac_address="")
        IPAddress.objects.filter(tenant=self.tenant).update(mac_address="")
        res = self._post(clear_interfaces=True, unpair_ips=True)
        self.assertEqual(res.status_code, 200, res.content)
        for src in res.json()["sources"].values():
            self.assertEqual(src["count"], 0)
        self._foreign_untouched()

    # ── RBAC ───────────────────────────────────────────────────────────────

    def test_needs_mac_view(self):
        self._login(self._user("nobody"))
        res = self._post(dry_run=True)
        self.assertEqual(res.status_code, 403, res.content)

    def test_an_option_without_its_grant_is_refused_and_writes_nothing(self):
        u = self._user("macs")
        self._grant(u, ["macaddress"], ["view", "delete"])
        self._login(u)
        for option in ("clear_interfaces", "unpair_ips"):
            res = self._post(**{option: True})
            self.assertEqual(res.status_code, 403, (option, res.content))
        self.assertEqual(MACAddress.objects.filter(tenant=self.tenant, mac_address=A).count(), 2)
        self.if_ams.refresh_from_db()
        self.assertEqual(self.if_ams.mac_address, A.upper())

        # The dry run says so, per source, instead of refusing.
        src = self._post(dry_run=True).json()["sources"]
        self.assertTrue(src["objects"]["permitted"])
        self.assertFalse(src["interfaces"]["permitted"])
        self.assertFalse(src["ips"]["permitted"])

        res = self._post()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(MACAddress.objects.filter(tenant=self.tenant, mac_address=A).exists())

    def test_mac_delete_grant_is_needed_for_objects(self):
        u = self._user("viewer")
        self._grant(u, ["macaddress", "ipaddress"], ["view", "change"])
        self._login(u)
        self.assertEqual(self._post().status_code, 403)
        self.assertEqual(MACAddress.objects.filter(tenant=self.tenant, mac_address=A).count(), 2)
        # IP pairings alone are fine for this user.
        res = self._post(remove_objects=False, unpair_ips=True)
        self.assertEqual(res.status_code, 200, res.content)
        self.ip_ams.refresh_from_db()
        self.assertEqual(self.ip_ams.mac_address, "")

    def test_site_scoped_grants_reach_only_their_site(self):
        u = self._user("ams-it")
        self._grant(u, ["macaddress", "interface", "ipaddress"], ["view"])
        self._grant(u, ["macaddress"], ["delete"], sites=[self.ams])
        self._grant(u, ["interface", "ipaddress"], ["change"], sites=[self.ams])
        self._login(u)

        src = self._post(dry_run=True).json()["sources"]
        self.assertEqual(
            {k: (v["permitted"], v["count"], v["skipped"]) for k, v in src.items()},
            {
                "objects": (True, 1, 1),
                "interfaces": (True, 1, 1),
                # No vminterface grant at all: nothing to see, nothing to do.
                "vm_interfaces": (False, 0, 0),
                "ips": (True, 1, 1),
            },
        )

        res = self._post(clear_interfaces=True, unpair_ips=True)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(MACAddress.objects.filter(pk=self.obj_ams.pk).exists())
        self.assertTrue(MACAddress.objects.filter(pk=self.obj_lon.pk).exists())
        for row, expected in (
            (self.if_ams, ""),
            (self.if_lon, A),
            (self.vmi, A),
            (self.ip_ams, ""),
            (self.ip_lon, A),
        ):
            row.refresh_from_db()
            self.assertEqual(row.mac_address, expected, row)
        self._foreign_untouched()

    def test_either_interface_grant_clears_its_own_kind(self):
        u = self._user("vm-ops")
        self._grant(u, ["macaddress", "vminterface"], ["view"])
        self._grant(u, ["vminterface"], ["change"])
        self._login(u)
        res = self._post(remove_objects=False, clear_interfaces=True)
        self.assertEqual(res.status_code, 200, res.content)
        src = res.json()["sources"]
        self.assertEqual(
            (src["vm_interfaces"]["count"], src["vm_interfaces"]["applied"]), (1, True)
        )
        self.assertFalse(src["interfaces"]["permitted"])
        self.assertFalse(src["interfaces"]["applied"])
        self.vmi.refresh_from_db()
        self.if_ams.refresh_from_db()
        self.assertEqual(self.vmi.mac_address, "")
        self.assertEqual(self.if_ams.mac_address, A.upper())

    # ── input ──────────────────────────────────────────────────────────────

    def test_caps_the_batch(self):
        values = [f"02:00:00:00:{i // 256:02x}:{i % 256:02x}" for i in range(MAX_BULK_MACS + 1)]
        res = self._post(values=values, dry_run=True)
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("values", res.json())

    def test_needs_values_and_an_option(self):
        self.assertEqual(self._post(values=[]).status_code, 400)
        res = self._post(remove_objects=False)
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(MACAddress.objects.filter(tenant=self.tenant, mac_address=A).count(), 2)
