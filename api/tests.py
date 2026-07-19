"""API tests."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, IPAddress, Interface, Prefix, ServiceTemplate
from core.models import Organization, Tenant


from api.test_utils import status_for


class VirtualInterfaceTests(APITestCase):
    """Virtual / sub-interface nesting: same-device parent, no cycles."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.dev = Device.objects.create(tenant=self.tenant, name="fw1")
        self.other = Device.objects.create(tenant=self.tenant, name="fw2")
        self.ae = Interface.objects.create(device=self.dev, name="ae1")
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_create_virtual_subinterface(self):
        r = self.client.post(
            "/api/interfaces/",
            {"device_id": str(self.dev.id), "name": "ae1.100",
             "virtual": True, "parent_id": str(self.ae.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(body["virtual"])
        self.assertEqual(body["parent"]["id"], str(self.ae.id))
        # The parent now reports a child.
        self.assertEqual(
            self.client.get(f"/api/interfaces/{self.ae.id}/").json()["child_count"],
            1,
        )

    def test_parent_must_be_same_device(self):
        cross = Interface.objects.create(device=self.other, name="eth9")
        r = self.client.post(
            "/api/interfaces/",
            {"device_id": str(self.dev.id), "name": "sub",
             "parent_id": str(cross.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("parent_id", r.json())

    def test_self_parent_rejected(self):
        r = self.client.patch(
            f"/api/interfaces/{self.ae.id}/",
            {"parent_id": str(self.ae.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_lag_membership(self):
        # A physical port joins the aggregate via `lag`; the
        # aggregate then reports a member count.
        r = self.client.post(
            "/api/interfaces/",
            {"device_id": str(self.dev.id), "name": "eth1",
             "lag_id": str(self.ae.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["lag"]["id"], str(self.ae.id))
        self.assertEqual(
            self.client.get(f"/api/interfaces/{self.ae.id}/").json()[
                "lag_member_count"
            ],
            1,
        )

    def test_lag_cross_device_rejected(self):
        cross = Interface.objects.create(device=self.other, name="ae9")
        r = self.client.post(
            "/api/interfaces/",
            {"device_id": str(self.dev.id), "name": "eth2",
             "lag_id": str(cross.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("lag_id", r.json())


class IpInPrefixValidationTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.10.0/24", status=status_for(self.tenant)
        )
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_rejects_ip_outside_prefix(self):
        r = self.client.post(
            "/api/ips/",
            {"ip_address": "1.1.1.1", "prefix_id": str(self.prefix.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("ip_address", r.json())
        self.assertFalse(IPAddress.objects.filter(ip_address="1.1.1.1").exists())

    def test_accepts_ip_inside_prefix(self):
        r = self.client.post(
            "/api/ips/",
            {"ip_address": "10.0.10.5", "prefix_id": str(self.prefix.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)

    def test_rejects_wrong_family(self):
        r = self.client.post(
            "/api/ips/",
            {"ip_address": "2001:db8::1", "prefix_id": str(self.prefix.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400)


class ServiceTemplateTests(APITestCase):
    """Reusable service-definition catalog: create, list, slug auto-gen,
    ports validation, and tenant scoping."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other_tenant = Tenant.objects.create(
            org=org, name="Beta", slug="beta"
        )
        self.user = get_user_model().objects.create_superuser(
            "admin", "a@b.c", "pw"
        )
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_create_autogenerates_slug(self):
        r = self.client.post(
            "/api/service-templates/",
            {"name": "HTTPS", "protocol": "tcp", "ports": [443]},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["slug"], "https")
        self.assertEqual(body["protocol"], "tcp")
        self.assertEqual(body["protocol_display"], "TCP")
        self.assertEqual(body["ports"], [443])

    def test_list_returns_tenant_objects(self):
        ServiceTemplate.objects.create(
            tenant=self.tenant, name="DNS", slug="dns",
            protocol="udp", ports=[53],
        )
        # Belongs to another tenant — must not appear.
        ServiceTemplate.objects.create(
            tenant=self.other_tenant, name="SSH", slug="ssh",
            protocol="tcp", ports=[22],
        )
        r = self.client.get("/api/service-templates/")
        self.assertEqual(r.status_code, 200, r.content)
        names = [row["name"] for row in r.json()["results"]]
        self.assertIn("DNS", names)
        self.assertNotIn("SSH", names)

    def test_rejects_empty_ports(self):
        r = self.client.post(
            "/api/service-templates/",
            {"name": "Bad", "protocol": "tcp", "ports": []},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_rejects_omitted_ports(self):
        r = self.client.post(
            "/api/service-templates/",
            {"name": "Bad", "protocol": "tcp"},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_rejects_out_of_range_port(self):
        r = self.client.post(
            "/api/service-templates/",
            {"name": "Bad", "protocol": "tcp", "ports": [70000]},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_duplicate_slug_per_tenant_rejected(self):
        ServiceTemplate.objects.create(
            tenant=self.tenant, name="HTTPS", slug="https",
            protocol="tcp", ports=[443],
        )
        r = self.client.post(
            "/api/service-templates/",
            {"name": "HTTPS", "protocol": "tcp", "ports": [443]},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)


class DeviceIPDesignationTests(APITestCase):
    """Device primary / secondary / oob IP designations via the API."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.10.0/24", status=status_for(self.tenant)
        )
        self.dev = Device.objects.create(tenant=self.tenant, name="fw1")
        self.other = Device.objects.create(tenant=self.tenant, name="fw2")
        # IPs assigned to this device.
        self.ip1 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.10.5",
            prefix=self.prefix, assigned_device=self.dev,
        )
        self.ip2 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.10.6",
            prefix=self.prefix, assigned_device=self.dev,
        )
        self.ip3 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.10.7",
            prefix=self.prefix, assigned_device=self.dev,
        )
        # An IP that belongs to a different device.
        self.foreign = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.10.8",
            prefix=self.prefix, assigned_device=self.other,
        )
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_set_primary_ip(self):
        r = self.client.patch(
            f"/api/devices/{self.dev.id}/",
            {"primary_ip_id": str(self.ip1.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["primary_ip"]["id"], str(self.ip1.id))
        self.dev.refresh_from_db()
        self.assertEqual(self.dev.primary_ip_id, self.ip1.id)
        # IPAddress reflects the designation.
        ip = self.client.get(f"/api/ips/{self.ip1.id}/").json()
        self.assertTrue(ip["is_primary_for_device"])
        self.assertFalse(ip["is_secondary_for_device"])
        self.assertFalse(ip["is_oob_for_device"])

    def test_set_secondary_and_oob(self):
        r = self.client.patch(
            f"/api/devices/{self.dev.id}/",
            {"secondary_ip_id": str(self.ip2.id),
             "oob_ip_id": str(self.ip3.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["secondary_ip"]["id"], str(self.ip2.id))
        self.assertEqual(body["oob_ip"]["id"], str(self.ip3.id))
        self.dev.refresh_from_db()
        self.assertEqual(self.dev.secondary_ip_id, self.ip2.id)
        self.assertEqual(self.dev.oob_ip_id, self.ip3.id)
        self.assertTrue(
            self.client.get(f"/api/ips/{self.ip2.id}/").json()[
                "is_secondary_for_device"
            ]
        )
        self.assertTrue(
            self.client.get(f"/api/ips/{self.ip3.id}/").json()["is_oob_for_device"]
        )

    def test_ip_not_assigned_to_device_rejected(self):
        r = self.client.patch(
            f"/api/devices/{self.dev.id}/",
            {"primary_ip_id": str(self.foreign.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("primary_ip_id", r.json())
        self.dev.refresh_from_db()
        self.assertIsNone(self.dev.primary_ip_id)

    def test_clear_primary_ip(self):
        self.dev.primary_ip = self.ip1
        self.dev.save()
        r = self.client.patch(
            f"/api/devices/{self.dev.id}/",
            {"primary_ip_id": None},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["primary_ip"])
        self.dev.refresh_from_db()
        self.assertIsNone(self.dev.primary_ip_id)


class DeviceBuiltinFieldsTests(APITestCase):
    """The promoted built-in Device fields persist and round-trip via the API."""

    def setUp(self):
        from api.models import Cluster, ClusterType, DeviceRole, DeviceType, Location, Site

        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="DC1")
        self.location = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Floor 2", slug="floor-2"
        )
        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="VMware", slug="vmware"
        )
        self.cluster = Cluster.objects.create(
            tenant=self.tenant, name="prod-cluster", type=ctype
        )
        self.dev = Device.objects.create(tenant=self.tenant, name="srv1")
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_patch_builtin_fields_round_trip(self):
        r = self.client.patch(
            f"/api/devices/{self.dev.id}/",
            {
                "comments": "Long-form notes here.",
                "airflow": "front-to-rear",
                "location_id": str(self.location.id),
                "cluster_id": str(self.cluster.id),
                "latitude": "55.676098",
                "longitude": "12.568337",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["comments"], "Long-form notes here.")
        self.assertEqual(body["airflow"], "front-to-rear")
        self.assertEqual(body["location"]["id"], str(self.location.id))
        self.assertEqual(body["location"]["name"], "Floor 2")
        self.assertEqual(body["cluster"]["id"], str(self.cluster.id))
        self.assertEqual(body["cluster"]["name"], "prod-cluster")
        self.assertEqual(str(body["latitude"]), "55.676098")
        self.assertEqual(str(body["longitude"]), "12.568337")

        self.dev.refresh_from_db()
        self.assertEqual(self.dev.comments, "Long-form notes here.")
        self.assertEqual(self.dev.airflow, "front-to-rear")
        self.assertEqual(self.dev.location_id, self.location.id)
        self.assertEqual(self.dev.cluster_id, self.cluster.id)

    def test_create_with_builtin_fields(self):
        r = self.client.post(
            "/api/devices/",
            {
                "name": "srv2",
                "comments": "born with notes",
                "airflow": "rear-to-front",
                "location_id": str(self.location.id),
                "cluster_id": str(self.cluster.id),
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["comments"], "born with notes")
        self.assertEqual(body["airflow"], "rear-to-front")
        self.assertEqual(body["cluster"]["id"], str(self.cluster.id))

    def test_invalid_airflow_rejected(self):
        r = self.client.patch(
            f"/api/devices/{self.dev.id}/",
            {"airflow": "diagonal"},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("airflow", r.json())

    def test_clear_location_and_cluster(self):
        self.dev.location = self.location
        self.dev.cluster = self.cluster
        self.dev.save()
        r = self.client.patch(
            f"/api/devices/{self.dev.id}/",
            {"location_id": None, "cluster_id": None},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["location"])
        self.assertIsNone(r.json()["cluster"])


class CatalogCustomFieldsTests(APITestCase):
    """Custom fields can now target DeviceType and DeviceRole catalog objects."""

    def setUp(self):
        from api.models import DeviceRole, DeviceType

        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="R650")
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Hypervisor", slug="hypervisor"
        )
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _make_cf(self, key, applies_to):
        r = self.client.post(
            "/api/custom-fields/",
            {"key": key, "label": key.title(), "type": "text",
             "applies_to": applies_to},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        return r

    def test_custom_field_accepts_devicetype_target(self):
        self._make_cf("warranty", ["devicetype"])

    def test_custom_field_accepts_devicerole_target(self):
        self._make_cf("tier", ["devicerole"])

    def test_devicetype_custom_fields_round_trip(self):
        self._make_cf("warranty", ["devicetype"])
        r = self.client.patch(
            f"/api/device-types/{self.dt.id}/",
            {"custom_fields": {"warranty": "2027-01-01"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["custom_fields"]["warranty"], "2027-01-01")
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.custom_fields["warranty"], "2027-01-01")

    def test_devicerole_custom_fields_round_trip(self):
        self._make_cf("tier", ["devicerole"])
        r = self.client.patch(
            f"/api/device-roles/{self.role.id}/",
            {"custom_fields": {"tier": "gold"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["custom_fields"]["tier"], "gold")
        self.role.refresh_from_db()
        self.assertEqual(self.role.custom_fields["tier"], "gold")

    def test_devicetype_required_custom_field_enforced(self):
        r = self.client.post(
            "/api/custom-fields/",
            {"key": "owner", "label": "Owner", "type": "text",
             "applies_to": ["devicetype"], "required": True},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.patch(
            f"/api/device-types/{self.dt.id}/",
            {"custom_fields": {}},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)


class DcimChoicesEndpointTests(APITestCase):
    """/api/dcim/choices/ — grouped media taxonomies for the type dropdowns."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)

    def test_choices_carry_groups(self):
        body = self.client.get("/api/dcim/choices/").json()
        for key in ("interface_types", "cable_types"):
            self.assertTrue(body[key], key)
            for row in body[key]:
                self.assertEqual(set(row), {"value", "label", "group"})
        iface_groups = {r["group"] for r in body["interface_types"]}
        self.assertIn("Virtual", iface_groups)
        self.assertIn("Ethernet (pluggable transceivers)", iface_groups)
        cable_groups = {r["group"] for r in body["cable_types"]}
        self.assertIn("Fiber — single-mode", cable_groups)

    def test_grouped_choices_validate_and_display(self):
        # Grouped (optgroup) choices still validate on the model field and
        # resolve through get_type_display().
        dev = Device.objects.create(tenant=self.tenant, name="sw1")
        r = self.client.post(
            "/api/interfaces/",
            {"device_id": str(dev.id), "name": "xe-0/0/0",
             "type": "10gbase-lr"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["type_display"], "10GBASE-LR (10GE)")

    def test_legacy_slugs_survive(self):
        # Every slug shipped before the 2026-07 expansion must still exist —
        # rows in existing databases keep resolving to a label.
        body = self.client.get("/api/dcim/choices/").json()
        iface = {r["value"] for r in body["interface_types"]}
        cable = {r["value"] for r in body["cable_types"]}
        self.assertLessEqual(
            {"virtual", "lag", "1000base-t", "10gbase-x-sfpp",
             "800gbase-x-osfp", "gpon", "other"},
            iface,
        )
        self.assertLessEqual(
            {"cat6", "dac-passive", "mmf-om4", "smf-os2", "aoc", "power"},
            cable,
        )


class RackPlacementTests(APITestCase):
    """Rack position collision rules, incl. half-width (rack_width) devices
    sharing a U on opposite sides (rack_side)."""

    def setUp(self):
        from api.models import DeviceType, Rack, Site

        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        site = Site.objects.create(tenant=self.tenant, name="dc1")
        self.rack = Rack.objects.create(tenant=self.tenant, site=site,
                                        name="rack-01", u_height=42)
        self.dt_full = DeviceType.objects.create(
            tenant=self.tenant, name="R650", u_height=1
        )
        self.dt_half = DeviceType.objects.create(
            tenant=self.tenant, name="SN2010", u_height=1, rack_width="half"
        )
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _post(self, name, dt, position, side="", face=""):
        return self.client.post(
            "/api/devices/",
            {"name": name, "device_type_id": str(dt.id),
             "rack_id": str(self.rack.id), "position": position,
             "face": face, "rack_side": side},
            format="json",
        )

    def test_full_width_overlap_rejected(self):
        self.assertEqual(self._post("a", self.dt_full, 10).status_code, 201)
        r = self._post("b", self.dt_full, 10)
        self.assertEqual(r.status_code, 400)
        self.assertIn("position", r.json())

    def test_half_width_requires_side(self):
        r = self._post("sw1", self.dt_half, 10)
        self.assertEqual(r.status_code, 400)
        self.assertIn("rack_side", r.json())

    def test_two_halves_share_a_unit(self):
        self.assertEqual(
            self._post("sw1", self.dt_half, 10, side="left").status_code, 201
        )
        r = self._post("sw2", self.dt_half, 10, side="right")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["rack_side"], "right")
        self.assertEqual(r.json()["rack_width"], "half")

    def test_same_side_conflicts(self):
        self._post("sw1", self.dt_half, 10, side="left")
        r = self._post("sw2", self.dt_half, 10, side="left")
        self.assertEqual(r.status_code, 400)
        self.assertIn("position", r.json())

    def test_half_conflicts_with_full(self):
        self.assertEqual(self._post("srv", self.dt_full, 10).status_code, 201)
        r = self._post("sw1", self.dt_half, 10, side="left")
        self.assertEqual(r.status_code, 400)

    def test_side_cleared_on_full_width(self):
        r = self._post("srv", self.dt_full, 10, side="left")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["rack_side"], "")

    def test_used_units_counts_shared_unit_once(self):
        self._post("sw1", self.dt_half, 10, side="left")
        self._post("sw2", self.dt_half, 10, side="right")
        r = self.client.get(f"/api/racks/{self.rack.id}/")
        self.assertEqual(r.json()["used_units"], 1)
