"""The device and VM detail reads answer in a fixed number of queries.

Their tab counts ride the one query that reads the object (api.detail_counts),
so the payload costs the same whatever hangs off the object - not a COUNT per
tab and per BGP instance, as it did. The figures themselves are pinned per
count in tests_tab_counts; here they are checked against the getters' own
queries, which a row read without the annotations still runs.
"""
from __future__ import annotations

import datetime as dt

from django.contrib.auth import get_user_model
from django.contrib.contenttypes.models import ContentType
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from core.models import Organization, Tag, Tenant
from routing.models import BGPInstance, BGPSession, StaticRoute

from .models import (
    ASN,
    VRF,
    Cluster,
    ClusterType,
    ConsolePort,
    Contact,
    ContactAssignment,
    Device,
    DeviceType,
    Document,
    ImageAttachment,
    Interface,
    InventoryItem,
    IPAddress,
    Manufacturer,
    PowerPort,
    Prefix,
    Service,
    Site,
    VirtualChassis,
    VirtualMachine,
    VMInterface,
)
from .serializers import DeviceSerializer, VirtualMachineSerializer

User = get_user_model()

# What one device page read costs, the session's own reads and writes aside:
# the user and the tenant (middleware), the device row with every tab count,
# its tags and device profiles, then the coverage warning days and the
# end-of-life settings.
DEVICE_DETAIL_QUERIES = 7
# The VM's: the user, the tenant, the VM row with its tab counts, then its
# tags, disks and device profiles, and the end-of-life settings.
VM_DETAIL_QUERIES = 7

DEVICE_COUNTS = (
    "interface_count", "ip_count", "hardware_count", "console_count", "power_count",
    "cooling_count", "front_port_count", "rear_port_count", "service_count",
    "routing_count", "image_count", "certificate_count", "contact_count",
    "document_count", "install_count",
)
VM_COUNTS = (
    "interface_count", "ip_count", "disk_count", "service_count", "certificate_count",
    "routing_count", "install_count",
)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="DC1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="SW", name="SW"
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/16")
        self.asn = ASN.objects.create(tenant=self.tenant, asn=65010)
        self.tags = [
            Tag.objects.create(tenant=self.tenant, name=f"t{n}", slug=f"t{n}") for n in range(2)
        ]
        self.client.force_login(User.objects.create_superuser("root", "r@a.c", "pw"))
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.ip_n = 0

    def _ip(self, **kw):
        self.ip_n += 1
        return IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix,
            ip_address=f"10.0.{self.ip_n // 250}.{self.ip_n % 250 + 1}", **kw,
        )

    def _vrf(self):
        """A VRF of its own: one BGP instance per object and VRF."""
        self.ip_n += 1
        return VRF.objects.create(tenant=self.tenant, name=f"vrf{self.ip_n}")

    def _cert(self, label, obj, seed):
        from monitoring.models import Certificate, CertificateAssignment

        now = timezone.now()
        cert = Certificate.objects.create(
            tenant=self.tenant, fingerprint_sha256=(seed * 64)[:64],
            subject_cn=f"{seed}.example", uploaded=True,
            not_before=now - dt.timedelta(days=1), not_after=now + dt.timedelta(days=90),
            pem="-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----\n",
        )
        CertificateAssignment.objects.create(
            tenant=self.tenant, certificate=cert, object_type=label, object_id=str(obj.id),
        )

    def _read(self, path) -> tuple[int, dict]:
        # The first read pays one-off lookups (content types, settings rows).
        self.client.get(path)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(path)
        self.assertEqual(r.status_code, 200, r.content)
        # The session's load and save are the test client's, not the read's.
        self.last_sql = [
            q["sql"][:120] for q in ctx.captured_queries
            if "django_session" not in q["sql"] and "SAVEPOINT" not in q["sql"]
        ]
        return len(self.last_sql), r.json()

    def _getter_counts(self, serializer_cls, obj, fields) -> dict:
        """The counts as the getters compute them on a bare row, one query
        each - what the annotations must agree with."""
        from rest_framework.test import APIRequestFactory

        request = APIRequestFactory().get("/")
        request.user = User.objects.get(username="root")
        ser = serializer_cls(obj, context={"request": request})
        return {f: getattr(ser, f"get_{f}")(obj) for f in fields}


class DeviceDetailQueryTests(_Base):
    def _grow(self, device, n: int):
        """``n`` of every kind of row a device tab counts."""
        for i in range(n):
            iface = Interface.objects.create(device=device, name=f"eth{self.ip_n}-{i}")
            self._ip(assigned_interface=iface)
            InventoryItem.objects.create(device=device, name=f"part{self.ip_n}-{i}")
            ConsolePort.objects.create(device=device, name=f"con{self.ip_n}-{i}")
            PowerPort.objects.create(device=device, name=f"psu{self.ip_n}-{i}")
            Service.objects.create(
                tenant=self.tenant, device=device, name=f"svc{self.ip_n}-{i}",
                protocol="tcp", ports=[22],
            )
            StaticRoute.objects.create(
                tenant=self.tenant, device=device, prefix=f"192.0.{self.ip_n % 250}.{i}/32",
                next_hop="10.9.0.1",
            )
            bgp = BGPInstance.objects.create(
                tenant=self.tenant, device=device, asn=self.asn, vrf=self._vrf(),
            )
            for k in range(2):
                BGPSession.objects.create(
                    tenant=self.tenant, instance=bgp,
                    remote_address=f"10.1.{self.ip_n % 250}.{i * 2 + k + 1}", remote_asn=65000,
                )
            ImageAttachment.objects.create(
                tenant=self.tenant, content_type=ContentType.objects.get_for_model(Device),
                object_id=device.pk, name=f"img{self.ip_n}-{i}", image="x.png",
            )
            self._cert("api.device", device, f"{self.ip_n}{i}a")
            ContactAssignment.objects.create(
                tenant=self.tenant, object_type="api.device", object_id=str(device.id),
                contact=Contact.objects.create(tenant=self.tenant, name=f"c{self.ip_n}-{i}"),
            )
            Document.objects.create(
                tenant=self.tenant, object_type="api.device", object_id=device.id,
                name=f"doc{self.ip_n}-{i}", url="https://docs.example/x",
            )

    def test_detail_cost_is_flat_and_counts_match_the_getters(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt, site=self.site,
            virtual_chassis=vc, vc_position=1,
        )
        Device.objects.create(
            tenant=self.tenant, name="sw2", device_type=self.dt, site=self.site,
            virtual_chassis=vc, vc_position=2,
        )
        device.tags.set(self.tags)
        path = f"/api/devices/{device.id}/"

        self._grow(device, 1)
        small, _ = self._read(path)
        self._grow(device, 3)
        big, body = self._read(path)

        self.assertEqual(small, big, "more rows on the tabs must not cost more queries")
        self.assertEqual(big, DEVICE_DETAIL_QUERIES, "\n".join(self.last_sql))
        bare = Device.objects.get(pk=device.pk)
        expected = self._getter_counts(DeviceSerializer, bare, DEVICE_COUNTS)
        self.assertEqual({f: body[f] for f in DEVICE_COUNTS}, expected)
        self.assertEqual(body["ip_count"], 4)
        self.assertEqual(body["routing_count"], 4 + 4 + 8)
        self.assertEqual(body["virtual_chassis"]["member_count"], 2)

    def test_a_device_route_reads_its_row_by_index(self):
        """Every route under one device reads the row with the address count
        by index - the list's join form hashed every interface there is."""
        device = Device.objects.create(tenant=self.tenant, name="sw1", device_type=self.dt)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(f"/api/devices/{device.id}/interfaces/")
        self.assertEqual(r.status_code, 200, r.content)
        row = next(q["sql"] for q in ctx.captured_queries
                   if q["sql"].startswith('SELECT "api_device"."created_at"'))
        self.assertIn('."assigned_interface_id" IN (SELECT', row)


class VmDetailQueryTests(_Base):
    def test_detail_cost_is_flat_and_counts_match_the_getters(self):
        ct = ClusterType.objects.create(tenant=self.tenant, name="kvm", slug="kvm")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="vm1", cluster=cluster)
        path = f"/api/virtual-machines/{vm.id}/"

        def grow(n):
            for i in range(n):
                iface = VMInterface.objects.create(vm=vm, name=f"ens{self.ip_n}-{i}")
                self._ip(assigned_vm_interface=iface)
                Service.objects.create(
                    tenant=self.tenant, virtual_machine=vm, name=f"svc{self.ip_n}-{i}",
                    protocol="tcp", ports=[443],
                )
                bgp = BGPInstance.objects.create(
                    tenant=self.tenant, virtual_machine=vm, asn=self.asn, vrf=self._vrf(),
                )
                BGPSession.objects.create(
                    tenant=self.tenant, instance=bgp,
                    remote_address=f"10.2.{self.ip_n % 250}.{i + 1}", remote_asn=65000,
                )
                self._cert("api.virtualmachine", vm, f"{self.ip_n}{i}v")

        grow(1)
        small, _ = self._read(path)
        grow(3)
        big, body = self._read(path)

        self.assertEqual(small, big, "more rows on the tabs must not cost more queries")
        self.assertEqual(big, VM_DETAIL_QUERIES, "\n".join(self.last_sql))
        bare = VirtualMachine.objects.get(pk=vm.pk)
        expected = self._getter_counts(VirtualMachineSerializer, bare, VM_COUNTS)
        self.assertEqual({f: body[f] for f in VM_COUNTS}, expected)
        self.assertEqual(body["routing_count"], 4 + 4)
