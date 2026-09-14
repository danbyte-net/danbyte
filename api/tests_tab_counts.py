"""Detail-page tab counts (#165): every collection tab shows how many rows it
lists, so each detail payload carries a ``*_count`` for it.

One test per count: 0 on a bare object, then the real number once rows exist.
The detail-only counts (device, device type, IP, prefix, VM) also assert the
list path still serves them as 0 - that gate is what keeps those tables free
of a COUNT per row.
"""
from __future__ import annotations

import datetime as dt

from django.contrib.auth.models import User
from django.contrib.contenttypes.models import ContentType
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    VRF,
    Cable,
    CableTermination,
    Circuit,
    Cluster,
    ClusterType,
    Contact,
    ContactAssignment,
    Device,
    DeviceType,
    Document,
    ImageAttachment,
    IPAddress,
    Location,
    Manufacturer,
    PowerFeed,
    PowerPanel,
    PowerPort,
    Prefix,
    Provider,
    ProviderNetwork,
    Rack,
    RouteTarget,
    Site,
    VirtualMachine,
)
from core.models import Organization, Tenant


class TabCountTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="DC1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="SW", name="SW"
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt, site=self.site
        )
        self.client.force_login(
            User.objects.create_superuser("root", "r@a.c", "pw")
        )
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    # ── helpers ──────────────────────────────────────────────────────────

    def _detail(self, path: str) -> dict:
        r = self.client.get(path)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _list_row(self, path: str, obj_id) -> dict:
        r = self.client.get(path)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        rows = body["results"] if isinstance(body, dict) else body
        (row,) = [x for x in rows if x["id"] == str(obj_id)]
        return row

    def _document(self, label: str, obj, name: str = "doc"):
        return Document.objects.create(
            tenant=self.tenant, object_type=label, object_id=obj.id,
            name=name, url=f"https://docs.example/{name}",
        )

    def _certificate(self, seed: str):
        from monitoring.models import Certificate

        now = timezone.now()
        return Certificate.objects.create(
            tenant=self.tenant,
            fingerprint_sha256=(seed * 64)[:64],
            subject_cn=f"{seed}.example",
            not_before=now - dt.timedelta(days=1),
            not_after=now + dt.timedelta(days=90),
            uploaded=True,
            pem="-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----\n",
        )

    def _assign_certificate(self, label: str, obj, seed: str):
        from monitoring.models import CertificateAssignment

        return CertificateAssignment.objects.create(
            tenant=self.tenant, certificate=self._certificate(seed),
            object_type=label, object_id=str(obj.id),
        )

    # ── Site ─────────────────────────────────────────────────────────────

    def test_site_location_count_counts_the_whole_tree(self):
        path = f"/api/sites/{self.site.id}/"
        self.assertEqual(self._detail(path)["location_count"], 0)
        floor = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Floor 1", slug="floor-1"
        )
        Location.objects.create(
            tenant=self.tenant, site=self.site, parent=floor,
            name="Room A", slug="room-a",
        )
        self.assertEqual(self._detail(path)["location_count"], 2)

    def test_site_document_count(self):
        path = f"/api/sites/{self.site.id}/"
        self.assertEqual(self._detail(path)["document_count"], 0)
        self._document("api.site", self.site, "floorplan")
        # A document on another object type with the same id shape stays out.
        self._document("api.device", self.device, "manual")
        self.assertEqual(self._detail(path)["document_count"], 1)

    # ── Device ───────────────────────────────────────────────────────────

    def test_device_image_count(self):
        path = f"/api/devices/{self.device.id}/"
        self.assertEqual(self._detail(path)["image_count"], 0)
        ct = ContentType.objects.get_for_model(Device)
        for n in range(2):
            ImageAttachment.objects.create(
                tenant=self.tenant, content_type=ct, object_id=self.device.pk,
                image=f"image-attachments/{n}.png", name=f"photo {n}",
            )
        self.assertEqual(self._detail(path)["image_count"], 2)

    def test_device_certificate_count_includes_ssh_host_keys(self):
        from monitoring.models import SSHHostKey

        path = f"/api/devices/{self.device.id}/"
        self.assertEqual(self._detail(path)["certificate_count"], 0)
        self._assign_certificate("api.device", self.device, "a")
        SSHHostKey.objects.create(
            tenant=self.tenant, device=self.device, key_type="ssh-ed25519",
            public_key="AAAAC3NzaC1lZDI1NTE5AAAAIExample", uploaded=True,
            fingerprint_sha256="SHA256:" + "k" * 43,
        )
        self.assertEqual(self._detail(path)["certificate_count"], 2)

    def test_device_contact_count(self):
        path = f"/api/devices/{self.device.id}/"
        self.assertEqual(self._detail(path)["contact_count"], 0)
        contact = Contact.objects.create(tenant=self.tenant, name="Ada")
        ContactAssignment.objects.create(
            tenant=self.tenant, contact=contact,
            object_type="api.device", object_id=str(self.device.id),
        )
        self.assertEqual(self._detail(path)["contact_count"], 1)

    def test_device_document_count_is_own_rows_only(self):
        path = f"/api/devices/{self.device.id}/"
        self.assertEqual(self._detail(path)["document_count"], 0)
        self._document("api.device", self.device, "runbook")
        # Inherited from the type: listed under its own heading, not counted.
        self._document("api.devicetype", self.dt, "datasheet")
        self.assertEqual(self._detail(path)["document_count"], 1)

    def test_device_tab_counts_stay_zero_on_the_list(self):
        self._document("api.device", self.device, "runbook")
        contact = Contact.objects.create(tenant=self.tenant, name="Ada")
        ContactAssignment.objects.create(
            tenant=self.tenant, contact=contact,
            object_type="api.device", object_id=str(self.device.id),
        )
        row = self._list_row("/api/devices/", self.device.id)
        for key in ("image_count", "certificate_count", "contact_count",
                    "document_count"):
            self.assertEqual(row[key], 0, key)

    # ── DeviceType ───────────────────────────────────────────────────────

    def test_device_type_sensor_count_is_type_bound_only(self):
        from monitoring.models import SnmpSensor

        path = f"/api/device-types/{self.dt.id}/"
        self.assertEqual(self._detail(path)["sensor_count"], 0)
        SnmpSensor.objects.create(
            tenant=self.tenant, name="Disk", slug="disk", device_type=self.dt,
            oid="1.3.6.1.4.1.1", item_kind="disk", name_template="d{index}",
            value_map={"1": "active"},
        )
        # An all-types sensor is not a row on this type's Sensors tab.
        SnmpSensor.objects.create(
            tenant=self.tenant, name="Fan", slug="fan", device_type=None,
            oid="1.3.6.1.4.1.2", item_kind="fan", name_template="f{index}",
            value_map={"1": "active"},
        )
        self.assertEqual(self._detail(path)["sensor_count"], 1)
        self.assertEqual(
            self._list_row("/api/device-types/", self.dt.id)["sensor_count"], 0
        )

    def test_device_type_document_count(self):
        path = f"/api/device-types/{self.dt.id}/"
        self.assertEqual(self._detail(path)["document_count"], 0)
        self._document("api.devicetype", self.dt, "datasheet")
        self._document("api.devicetype", self.dt, "manual")
        self.assertEqual(self._detail(path)["document_count"], 2)
        self.assertEqual(
            self._list_row("/api/device-types/", self.dt.id)["document_count"], 0
        )

    # ── Rack / Location ──────────────────────────────────────────────────

    def test_rack_document_count(self):
        rack = Rack.objects.create(tenant=self.tenant, name="R1", site=self.site)
        path = f"/api/racks/{rack.id}/"
        self.assertEqual(self._detail(path)["document_count"], 0)
        self._document("api.rack", rack, "elevation")
        self.assertEqual(self._detail(path)["document_count"], 1)

    def test_location_document_count(self):
        loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Room", slug="room"
        )
        path = f"/api/locations/{loc.id}/"
        self.assertEqual(self._detail(path)["document_count"], 0)
        self._document("api.location", loc, "access")
        self.assertEqual(self._detail(path)["document_count"], 1)

    # ── Provider ─────────────────────────────────────────────────────────

    def test_provider_network_count_and_circuit_count_stay_distinct(self):
        prov = Provider.objects.create(tenant=self.tenant, name="Telco", slug="telco")
        path = f"/api/providers/{prov.id}/"
        self.assertEqual(self._detail(path)["network_count"], 0)
        for n in range(2):
            ProviderNetwork.objects.create(
                tenant=self.tenant, provider=prov, name=f"net{n}"
            )
        for n in range(3):
            Circuit.objects.create(tenant=self.tenant, provider=prov, cid=f"C{n}")
        body = self._detail(path)
        # Two reverse joins in one annotation: without distinct these would
        # read 6 and 6.
        self.assertEqual(body["network_count"], 2)
        self.assertEqual(body["circuit_count"], 3)
        row = self._list_row("/api/providers/", prov.id)
        self.assertEqual((row["network_count"], row["circuit_count"]), (2, 3))

    # ── RouteTarget ──────────────────────────────────────────────────────

    def test_route_target_vrf_count_is_distinct_across_import_and_export(self):
        rt = RouteTarget.objects.create(tenant=self.tenant, name="65000:1")
        path = f"/api/route-targets/{rt.id}/"
        self.assertEqual(self._detail(path)["vrf_count"], 0)
        both = VRF.objects.create(tenant=self.tenant, name="both")
        both.import_targets.add(rt)
        both.export_targets.add(rt)
        VRF.objects.create(tenant=self.tenant, name="in").import_targets.add(rt)
        VRF.objects.create(tenant=self.tenant, name="out").export_targets.add(rt)
        body = self._detail(path)
        self.assertEqual(body["import_vrf_count"], 2)
        self.assertEqual(body["export_vrf_count"], 2)
        self.assertEqual(body["vrf_count"], 3)

    # ── PowerFeed ────────────────────────────────────────────────────────

    def test_power_feed_cable_count(self):
        panel = PowerPanel.objects.create(
            tenant=self.tenant, site=self.site, name="PP-1"
        )
        feed = PowerFeed.objects.create(
            tenant=self.tenant, power_panel=panel, name="FEED-A"
        )
        other = PowerFeed.objects.create(
            tenant=self.tenant, power_panel=panel, name="FEED-B"
        )
        path = f"/api/power-feeds/{feed.id}/"
        self.assertEqual(self._detail(path)["cable_count"], 0)
        pdu = Device.objects.create(
            tenant=self.tenant, name="pdu1", device_type=self.dt, site=self.site
        )
        # A feed is cabled at most once, so the count is the cable on this
        # feed and not the one on its neighbour.
        for n, f in enumerate((feed, other)):
            inlet = PowerPort.objects.create(device=pdu, name=f"inlet{n}")
            cable = Cable.objects.create(tenant=self.tenant)
            CableTermination.objects.create(cable=cable, end="A", power_feed=f)
            CableTermination.objects.create(cable=cable, end="B", power_port=inlet)
        self.assertEqual(self._detail(path)["cable_count"], 1)
        self.assertEqual(
            self._list_row("/api/power-feeds/", feed.id)["cable_count"], 1
        )

    # ── IPAddress / VirtualMachine ───────────────────────────────────────

    def test_ip_certificate_count_is_detail_only(self):
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24")
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.10", prefix=prefix
        )
        path = f"/api/ips/{ip.id}/"
        self.assertEqual(self._detail(path)["certificate_count"], 0)
        self._assign_certificate("api.ipaddress", ip, "b")
        self.assertEqual(self._detail(path)["certificate_count"], 1)
        self.assertEqual(self._list_row("/api/ips/", ip.id)["certificate_count"], 0)

    def test_vm_certificate_count(self):
        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="Proxmox", slug="proxmox"
        )
        cluster = Cluster.objects.create(tenant=self.tenant, name="cl1", type=ctype)
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1", cluster=cluster
        )
        path = f"/api/virtual-machines/{vm.id}/"
        self.assertEqual(self._detail(path)["certificate_count"], 0)
        self._assign_certificate("api.virtualmachine", vm, "c")
        self._assign_certificate("api.virtualmachine", vm, "d")
        self.assertEqual(self._detail(path)["certificate_count"], 2)
        self.assertEqual(
            self._list_row("/api/virtual-machines/", vm.id)["certificate_count"], 0
        )

    # ── Prefix (DNS) ─────────────────────────────────────────────────────

    def test_prefix_dns_record_count(self):
        from integrations.models import DnsRecord, DnsZone

        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24")
        other = Prefix.objects.create(tenant=self.tenant, cidr="10.10.0.0/24")
        path = f"/api/prefixes/{prefix.id}/"
        self.assertEqual(self._detail(path)["dns_record_count"], 0)
        zone = DnsZone.objects.create(tenant=self.tenant, name="example.lan")
        for n, pfx in ((1, prefix), (2, prefix), (3, other)):
            ip = IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"{pfx.cidr.split('/')[0][:-1]}{n}",
                prefix=pfx,
            )
            DnsRecord.objects.create(
                zone=zone, name=f"h{n}.example.lan", record_type="A",
                data=ip.ip_address, ip=ip.ip_address, ip_address=ip,
            )
        self.assertEqual(self._detail(path)["dns_record_count"], 2)
        self.assertEqual(
            self._list_row("/api/prefixes/", prefix.id)["dns_record_count"], 0
        )

    # ── WindowsServerConnection ──────────────────────────────────────────

    def test_windows_connection_lease_and_zone_counts(self):
        from integrations.models import (
            DhcpLease,
            DhcpScope,
            DnsZone,
            IntegrationSettings,
            WindowsServerConnection,
        )

        IntegrationSettings.objects.create(
            tenant=self.tenant, dhcp_sync_enabled=True, dns_sync_enabled=True
        )
        conn = WindowsServerConnection.objects.create(
            tenant=self.tenant, name="dc1", host="192.0.2.10", username="svc",
            credentials={"password": "pw"}, dhcp_enabled=True, dns_enabled=True,
        )
        path = f"/api/windows-connections/{conn.id}/"
        body = self._detail(path)
        self.assertEqual((body["lease_count"], body["zone_count"]), (0, 0))
        for s in range(2):
            scope = DhcpScope.objects.create(
                connection=conn, scope_id=f"10.{s}.0.0", name=f"scope{s}"
            )
            for n in range(2):
                DhcpLease.objects.create(scope=scope, ip=f"10.{s}.0.{n + 1}")
        for z in range(3):
            DnsZone.objects.create(connection=conn, name=f"z{z}.lan")
        body = self._detail(path)
        # Two reverse joins in one annotation - distinct keeps 4 and 3 from
        # reading as 12 and 12.
        self.assertEqual((body["lease_count"], body["zone_count"]), (4, 3))
        row = self._list_row("/api/windows-connections/", conn.id)
        self.assertEqual((row["lease_count"], row["zone_count"]), (4, 3))
