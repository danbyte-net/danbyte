"""An all-digit query matches numid - the short id printed on labels finds
its object, including cables (which have no name to search by)."""
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Cable, Device


class NumidSearchTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        admin = User.objects.create_superuser("nsr", "n@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _hit_ids(self, group, q):
        r = self.client.get(f"/api/search/?q={q}")
        self.assertEqual(r.status_code, 200, r.content)
        return [h["id"] for h in r.json()["groups"][group]]

    def test_device_found_by_short_id(self):
        dev = Device.objects.create(tenant=self.tenant, name="edge-fw")
        dev.refresh_from_db()
        self.assertIsNotNone(dev.numid)
        self.assertIn(str(dev.id), self._hit_ids("devices", dev.numid))

    def test_cable_found_by_short_id(self):
        cable = Cable.objects.create(tenant=self.tenant)
        cable.refresh_from_db()
        self.assertIsNotNone(cable.numid)
        self.assertIn(str(cable.id), self._hit_ids("cables", cable.numid))

    def test_digits_in_names_still_match(self):
        dev = Device.objects.create(tenant=self.tenant, name="rack42-sw")
        self.assertIn(str(dev.id), self._hit_ids("devices", "42"))


class ContainedInFilterTests(APITestCase):
    """?contained_in=<cidr> narrows the prefix list to networks inside it -
    the aggregate page's Prefixes tab (#133)."""

    def setUp(self):
        org = Organization.objects.create(name="O2", slug="o2")
        self.tenant = Tenant.objects.create(org=org, name="T2", slug="t2")
        admin = User.objects.create_superuser("cif", "c@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_only_contained_prefixes_return(self):
        from .models import Prefix

        inside = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/16")
        deeper = Prefix.objects.create(tenant=self.tenant, cidr="10.1.2.0/24")
        outside = Prefix.objects.create(tenant=self.tenant, cidr="192.168.0.0/24")
        r = self.client.get("/api/prefixes/?contained_in=10.0.0.0/8")
        ids = [p["id"] for p in r.json()["results"]]
        self.assertIn(str(inside.id), ids)
        self.assertIn(str(deeper.id), ids)
        self.assertNotIn(str(outside.id), ids)

    def test_bad_cidr_returns_nothing(self):
        from .models import Prefix

        Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/16")
        r = self.client.get("/api/prefixes/?contained_in=not-a-net")
        self.assertEqual(r.json()["results"], [])


class IpSearchRankingTests(APITestCase):
    """Searching the IP list puts the closest address first: exact, then
    prefix, then substring - .13 above .130-.139."""

    def test_exact_and_prefix_rank_first(self):
        from api.models import IPAddress, Prefix

        org = Organization.objects.create(name="O3", slug="o3")
        tenant = Tenant.objects.create(org=org, name="T3", slug="t3")
        admin = User.objects.create_superuser("ipr", "i@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()
        pfx = Prefix.objects.create(tenant=tenant, cidr="10.196.192.0/24")
        for host in (137, 131, 13, 136, 139, 132):
            IPAddress.objects.create(
                tenant=tenant, prefix=pfx, ip_address=f"10.196.192.{host}"
            )
        r = self.client.get("/api/ips/?search=10.196.192.13")
        addrs = [row["ip_address"] for row in r.json()["results"]]
        self.assertEqual(addrs[0], "10.196.192.13")  # exact first
        # prefix matches follow in numeric order
        self.assertEqual(
            addrs[1:],
            ["10.196.192.131", "10.196.192.132", "10.196.192.136",
             "10.196.192.137", "10.196.192.139"],
        )


class MarkerRenameTests(APITestCase):
    """Renaming a component template follows into the type's photo markers
    and faceplate slots - they reference components by name."""

    def setUp(self):
        from .models import DeviceType, InterfaceTemplate

        org = Organization.objects.create(name="O4", slug="o4")
        self.tenant = Tenant.objects.create(org=org, name="T4", slug="t4")
        admin = User.objects.create_superuser("mrn", "m@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="MRK-1",
            image_ports={
                "front": [
                    {"kind": "interface", "name": "eth0",
                     "x": 0.1, "y": 0.5, "w": 0.05, "h": 0.4},
                    {"kind": "interface", "name": "eth1",
                     "x": 0.2, "y": 0.5, "w": 0.05, "h": 0.4},
                ],
                "rear": [],
            },
            faceplate={
                "front": [
                    {"slots": [{"t": "port", "kind": "interface",
                                "name": "eth0"}]},
                ],
            },
        )
        self.tmpl = InterfaceTemplate.objects.create(
            device_type=self.dt, name="eth0"
        )

    def test_template_rename_follows_into_markers(self):
        r = self.client.patch(
            f"/api/interface-templates/{self.tmpl.id}/",
            {"name": "gi0"}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.dt.refresh_from_db()
        names = [m["name"] for m in self.dt.image_ports["front"]]
        self.assertEqual(names, ["gi0", "eth1"])  # only the renamed one moved
        self.assertEqual(
            self.dt.faceplate["front"][0]["slots"][0]["name"], "gi0"
        )

    def test_other_kinds_untouched(self):
        from .models import ConsolePortTemplate

        self.dt.image_ports["front"].append(
            {"kind": "console-port", "name": "eth0",
             "x": 0.3, "y": 0.5, "w": 0.05, "h": 0.4}
        )
        self.dt.save(update_fields=["image_ports"])
        cp = ConsolePortTemplate.objects.create(
            device_type=self.dt, name="con0"
        )
        cp.name = "con1"
        cp.save()
        self.dt.refresh_from_db()
        # the console-port marker named eth0 stays: kind must match too
        kinds = {(m["kind"], m["name"]) for m in self.dt.image_ports["front"]}
        self.assertIn(("console-port", "eth0"), kinds)


class SnmpProfileOptionsTests(APITestCase):
    """#125 resurfaced: a site-only user could write a binding but was 403'd
    off the profile list, so the saved binding rendered as an empty select.
    The options endpoint serves id/name/version to the binding vocabulary."""

    def setUp(self):
        from auth_api.models import ObjectPermission, UserProfile
        from monitoring.models import SnmpProfile

        org = Organization.objects.create(name="O5", slug="o5")
        self.tenant = Tenant.objects.create(org=org, name="T5", slug="t5")
        SnmpProfile.objects.create(
            tenant=self.tenant, name="core-v2", slug="core-v2", version="v2c",
            secret_params={"community": "sekrit"},
        )
        self.user = User.objects.create_user("siteonly5", password="x")
        prof = UserProfile.objects.create(user=self.user, role="custom")
        prof.tenants.add(self.tenant)
        op = ObjectPermission.objects.create(
            name="site-only-5", object_types=["site"],
            actions=["view", "change"],
        )
        op.users.add(self.user)
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_site_only_user_gets_options_without_secrets(self):
        r = self.client.get("/api/monitoring/snmp-profile-options/")
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["results"]
        self.assertEqual(
            rows, [{"id": rows[0]["id"], "name": "core-v2", "version": "v2c"}]
        )
        self.assertNotIn("sekrit", r.content.decode())

    def test_unrelated_user_is_refused(self):
        from auth_api.models import UserProfile

        stranger = User.objects.create_user("nogrants5", password="x")
        UserProfile.objects.create(user=stranger, role="custom").tenants.add(
            self.tenant
        )
        self.client.force_login(stranger)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.client.get("/api/monitoring/snmp-profile-options/")
        self.assertEqual(r.status_code, 403)


class VmInterfaceKindTests(APITestCase):
    """#140: VM interfaces carry a kind - a tunnel (wg/gre/tun) is not a
    virtual NIC and has no meaningful MAC or speed."""

    def test_kind_roundtrips(self):
        from api.models import Cluster, ClusterType, VirtualMachine

        org = Organization.objects.create(name="O6", slug="o6")
        tenant = Tenant.objects.create(org=org, name="T6", slug="t6")
        admin = User.objects.create_superuser("vmk", "v@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()
        ct = ClusterType.objects.create(tenant=tenant, name="KVM", slug="kvm")
        cluster = Cluster.objects.create(tenant=tenant, name="c1", type=ct)
        vm = VirtualMachine.objects.create(
            tenant=tenant, name="gw01", cluster=cluster
        )
        r = self.client.post("/api/vm-interfaces/", {
            "vm_id": str(vm.id), "name": "wg0", "kind": "tunnel",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["kind"], "tunnel")
        r = self.client.get(f"/api/vm-interfaces/?vm={vm.id}")
        self.assertEqual(r.json()["results"][0]["kind"], "tunnel")
        # bad kind is a clean 400, not a 500
        r = self.client.post("/api/vm-interfaces/", {
            "vm_id": str(vm.id), "name": "x0", "kind": "quantum",
        }, format="json")
        self.assertEqual(r.status_code, 400)


class VmInterfaceParentTests(APITestCase):
    """Nesting: wg0 rides on eth0. Same-VM only, and never a loop."""

    def setUp(self):
        from api.models import Cluster, ClusterType, VirtualMachine

        org = Organization.objects.create(name="O7", slug="o7")
        self.tenant = Tenant.objects.create(org=org, name="T7", slug="t7")
        admin = User.objects.create_superuser("vmp", "p@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        ct = ClusterType.objects.create(tenant=self.tenant, name="K", slug="k")
        cl = Cluster.objects.create(tenant=self.tenant, name="c", type=ct)
        self.vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="gw", cluster=cl
        )
        self.other_vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="other", cluster=cl
        )

    def _mk(self, name, **extra):
        r = self.client.post(
            "/api/vm-interfaces/",
            {"vm_id": str(self.vm.id), "name": name, **extra},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def test_parent_roundtrips_and_stays_in_the_vm(self):
        eth0 = self._mk("eth0")
        wg0 = self._mk("wg0", kind="tunnel", parent_id=eth0["id"])
        self.assertEqual(wg0["parent"], {"id": eth0["id"], "name": "eth0"})
        # an interface on another VM is refused as parent
        r = self.client.post("/api/vm-interfaces/", {
            "vm_id": str(self.other_vm.id), "name": "eth9",
        }, format="json")
        foreign = r.json()["id"]
        r = self.client.post("/api/vm-interfaces/", {
            "vm_id": str(self.vm.id), "name": "bad0", "parent_id": foreign,
        }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_loops_are_refused(self):
        eth0 = self._mk("eth0")
        wg0 = self._mk("wg0", parent_id=eth0["id"])
        r = self.client.patch(
            f"/api/vm-interfaces/{eth0['id']}/",
            {"parent_id": wg0["id"]}, format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        # self-parent refused too
        r = self.client.patch(
            f"/api/vm-interfaces/{eth0['id']}/",
            {"parent_id": eth0["id"]}, format="json",
        )
        self.assertEqual(r.status_code, 400)


class MacDetailVmSightingTests(APITestCase):
    """#139: a MAC seen only in a VM's SNMP state 500'd the detail view -
    the sighting walker read state.device.name on a VM row."""

    def test_vm_sighting_returns_200_with_vm_owner(self):
        from api.models import Cluster, ClusterType, VirtualMachine
        from monitoring.models import DeviceSnmp

        org = Organization.objects.create(name="O8", slug="o8")
        tenant = Tenant.objects.create(org=org, name="T8", slug="t8")
        admin = User.objects.create_superuser("mvs", "s@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()
        ct = ClusterType.objects.create(tenant=tenant, name="K8", slug="k8")
        cl = Cluster.objects.create(tenant=tenant, name="c8", type=ct)
        vm = VirtualMachine.objects.create(tenant=tenant, name="vr01", cluster=cl)
        DeviceSnmp.objects.create(
            tenant=tenant, vm=vm,
            arp=[{"mac": "b4:7a:f1:ff:b2:7b", "ip": "10.0.0.9"}],
        )
        r = self.client.get("/api/macs/b4%3A7a%3Af1%3Aff%3Ab2%3A7b/")
        self.assertEqual(r.status_code, 200, r.content)
        seen = r.json()["seen"]
        self.assertEqual(seen[0]["vm"]["name"], "vr01")
        self.assertNotIn("device", seen[0])


class BadFitConstraintTests(APITestCase):
    """#125 follow-up: one ObjectPermission may span several object types, so
    a device-shaped constraint can reach the site model - that must fail
    closed per grant, never 500, and never sink a good sibling grant."""

    def setUp(self):
        from auth_api.models import ObjectPermission, UserProfile

        org = Organization.objects.create(name="O9", slug="o9")
        self.tenant = Tenant.objects.create(org=org, name="T9", slug="t9")
        from api.models import Site

        self.site = Site.objects.create(tenant=self.tenant, name="S9")
        self.user = User.objects.create_user("mixed9", password="x")
        prof = UserProfile.objects.create(user=self.user, role="custom")
        prof.tenants.add(self.tenant)
        # The foot-gun: device+site in one grant, device-shaped constraint.
        self.bad = ObjectPermission.objects.create(
            name="mixed-bad", object_types=["device", "site"],
            actions=["view", "change"],
            constraints={"site_id": [str(self.site.id)]},
        )
        self.bad.users.add(self.user)
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_misfit_grant_denies_cleanly(self):
        r = self.client.get(f"/api/sites/{self.site.id}/")
        self.assertIn(r.status_code, (403, 404), r.content)  # not 500

    def test_good_grant_survives_a_bad_sibling(self):
        from auth_api.models import ObjectPermission

        good = ObjectPermission.objects.create(
            name="site-good", object_types=["site"], actions=["view", "change"]
        )
        good.users.add(self.user)
        r = self.client.get(f"/api/sites/{self.site.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        from auth_api import rbac

        self.assertTrue(
            rbac.can_act_on(self.user, self.tenant, "site", "view", self.site)
        )


class PortLabelTests(APITestCase):
    """Ports keep template-matching names (photo markers resolve) and carry
    the printed name in `label` - X1-P1 on "Port 1"."""

    def test_label_roundtrips_on_all_three_kinds(self):
        from api.models import Device, FrontPort, RearPort

        org = Organization.objects.create(name="OL", slug="ol")
        tenant = Tenant.objects.create(org=org, name="TL", slug="tl")
        admin = User.objects.create_superuser("lbl", "l@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()
        dev = Device.objects.create(tenant=tenant, name="panel-l")
        r = self.client.post("/api/interfaces/", {
            "device_id": str(dev.id), "name": "Port 1", "label": "X1-P1",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["label"], "X1-P1")
        rp = RearPort.objects.create(device=dev, name="Rear 1", type="8p8c")
        r = self.client.post("/api/front-ports/", {
            "device_id": str(dev.id), "name": "Port F1", "label": "X1-F1",
            "rear_port_id": str(rp.id), "rear_port_position": 1,
            "type": "8p8c",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["label"], "X1-F1")
        r = self.client.patch(f"/api/rear-ports/{rp.id}/", {
            "label": "X1-R1",
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["label"], "X1-R1")
        # face-ports carries the label for the photo hover
        dev.device_type_id = None
        from api.models import DeviceType

        dt = DeviceType.objects.create(
            tenant=tenant, name="LT",
            image_ports={"front": [
                {"kind": "front-port", "name": "Port F1",
                 "x": 0.2, "y": 0.5, "w": 0.05, "h": 0.2},
            ], "rear": []},
        )
        dev.device_type = dt
        dev.save(update_fields=["device_type"])
        r = self.client.get(f"/api/devices/{dev.id}/face-ports/")
        entry = r.json()["front"][0]
        self.assertEqual(entry["label"], "X1-F1")
