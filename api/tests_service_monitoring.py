"""Service monitoring - the `monitored` flag, device-type materialisation, and
check reconciliation. See docs/architecture/service-monitoring.md."""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    Device,
    DeviceType,
    DeviceTypeService,
    IPAddress,
    Prefix,
    Service,
    materialize_device_components,
)
from api.tests import status_for
from core.models import Organization, Tenant
from monitoring.models import CheckAssignment
from monitoring.service_checks import sync_service_checks


class ServiceMonitoringTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="FW-100")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant)
        )
        self.user = get_user_model().objects.create_superuser(
            "admin", "a@b.c", "pw"
        )
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _device_with_ip(self, name="fw1"):
        dev = Device.objects.create(tenant=self.tenant, name=name)
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix,
            assigned_device=dev,
        )
        dev.primary_ip = ip
        dev.save(update_fields=["primary_ip"])
        return dev, ip

    # ── device-type materialisation ──────────────────────────────────────────
    def test_service_template_materialises_onto_new_device(self):
        DeviceTypeService.objects.create(
            device_type=self.dt, name="HTTPS", protocol="tcp", ports=[443],
            monitor=True,
        )
        DeviceTypeService.objects.create(
            device_type=self.dt, name="SSH", protocol="tcp", ports=[22],
            monitor=False,
        )
        dev = Device.objects.create(
            tenant=self.tenant, name="fw1", device_type=self.dt
        )
        materialize_device_components(dev)

        svcs = {s.name: s for s in dev.services.all()}
        self.assertEqual(set(svcs), {"HTTPS", "SSH"})
        self.assertTrue(svcs["HTTPS"].monitored)
        self.assertFalse(svcs["SSH"].monitored)
        # No primary IP yet → monitored service parks at zero checks.
        self.assertEqual(
            CheckAssignment.objects.filter(service=svcs["HTTPS"]).count(), 0
        )

    def test_materialisation_is_idempotent_by_name(self):
        DeviceTypeService.objects.create(
            device_type=self.dt, name="HTTPS", protocol="tcp", ports=[443],
        )
        dev = Device.objects.create(
            tenant=self.tenant, name="fw1", device_type=self.dt
        )
        materialize_device_components(dev)
        materialize_device_components(dev)
        self.assertEqual(dev.services.filter(name="HTTPS").count(), 1)

    # ── reconciliation ───────────────────────────────────────────────────────
    def test_monitored_service_spawns_checks(self):
        dev, ip = self._device_with_ip()
        svc = Service.objects.create(
            tenant=self.tenant, device=dev, name="HTTPS", protocol="tcp",
            ports=[443, 8443], monitored=True,
        )
        sync_service_checks(svc)
        a = CheckAssignment.objects.filter(service=svc)
        self.assertEqual(a.count(), 2)
        self.assertTrue(all(x.ip_address_id == ip.id for x in a))

    def test_toggle_off_removes_owned_checks(self):
        dev, _ = self._device_with_ip()
        svc = Service.objects.create(
            tenant=self.tenant, device=dev, name="HTTPS", protocol="tcp",
            ports=[443], monitored=True,
        )
        sync_service_checks(svc)
        self.assertEqual(CheckAssignment.objects.filter(service=svc).count(), 1)
        svc.monitored = False
        svc.save(update_fields=["monitored"])
        sync_service_checks(svc)
        self.assertEqual(CheckAssignment.objects.filter(service=svc).count(), 0)

    def test_removing_a_port_drops_its_check(self):
        dev, _ = self._device_with_ip()
        svc = Service.objects.create(
            tenant=self.tenant, device=dev, name="HTTPS", protocol="tcp",
            ports=[443, 8443], monitored=True,
        )
        sync_service_checks(svc)
        self.assertEqual(CheckAssignment.objects.filter(service=svc).count(), 2)
        svc.ports = [443]
        svc.save(update_fields=["ports"])
        sync_service_checks(svc)
        slugs = set(
            CheckAssignment.objects.filter(service=svc).values_list(
                "template__slug", flat=True
            )
        )
        self.assertEqual(slugs, {"tcp-443"})

    # ── API surface ──────────────────────────────────────────────────────────
    def test_patch_monitored_reconciles_and_reports_check_count(self):
        dev, _ = self._device_with_ip()
        svc = Service.objects.create(
            tenant=self.tenant, device=dev, name="HTTPS", protocol="tcp",
            ports=[443], monitored=False,
        )
        r = self.client.patch(
            f"/api/services/{svc.id}/", {"monitored": True}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["monitored"])
        self.assertEqual(r.json()["check_count"], 1)

    def test_setting_primary_ip_activates_waiting_service(self):
        dev = Device.objects.create(tenant=self.tenant, name="fw1")
        svc = Service.objects.create(
            tenant=self.tenant, device=dev, name="HTTPS", protocol="tcp",
            ports=[443], monitored=True,
        )
        sync_service_checks(svc)  # no IP → parks
        self.assertEqual(CheckAssignment.objects.filter(service=svc).count(), 0)

        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.9", prefix=self.prefix,
            assigned_device=dev,
        )
        r = self.client.patch(
            f"/api/devices/{dev.id}/", {"primary_ip_id": str(ip.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(CheckAssignment.objects.filter(service=svc).count(), 1)


class MixedProtocolServiceTests(ServiceMonitoringTests):
    """A service may answer on several protocols at once - DNS is TCP 53 *and*
    UDP 53 - so ports carry their own protocol instead of the service having
    exactly one."""

    def test_each_port_is_checked_with_its_own_protocol(self):
        dev, ip = self._device_with_ip()
        svc = Service.objects.create(
            tenant=self.tenant, device=dev, name="DNS",
            protocol_ports={"tcp": [53, 443], "udp": [53, 445]},
            monitored=True,
        )
        sync_service_checks(svc)
        slugs = set(
            CheckAssignment.objects.filter(service=svc).values_list(
                "template__slug", flat=True
            )
        )
        self.assertEqual(slugs, {"tcp-53", "tcp-443", "udp-53", "udp-445"})
        kinds = dict(
            CheckAssignment.objects.filter(service=svc).values_list(
                "template__slug", "template__kind"
            )
        )
        self.assertEqual(kinds["udp-53"], "udp")
        self.assertEqual(kinds["tcp-53"], "tcp")

    def test_single_protocol_service_is_unchanged(self):
        dev, ip = self._device_with_ip()
        svc = Service.objects.create(
            tenant=self.tenant, device=dev, name="HTTPS", protocol="tcp",
            ports=[443], monitored=True,
        )
        sync_service_checks(svc)
        self.assertEqual(svc.port_map(), {"tcp": [443]})
        self.assertEqual(
            CheckAssignment.objects.filter(service=svc).count(), 1
        )

    def test_legacy_pair_mirrors_the_first_block(self):
        # Readers that predate protocol_ports still see a coherent service.
        svc = Service.objects.create(
            tenant=self.tenant, name="DNS",
            protocol_ports={"udp": [53], "tcp": [53, 853]},
        )
        svc.refresh_from_db()
        self.assertEqual(svc.protocol, "tcp")
        self.assertEqual(svc.ports, [53, 853])

    def test_dropping_a_protocol_removes_only_its_checks(self):
        dev, ip = self._device_with_ip()
        svc = Service.objects.create(
            tenant=self.tenant, device=dev, name="DNS",
            protocol_ports={"tcp": [53], "udp": [53]}, monitored=True,
        )
        sync_service_checks(svc)
        self.assertEqual(CheckAssignment.objects.filter(service=svc).count(), 2)
        svc.protocol_ports = {"udp": [53]}
        svc.save()
        sync_service_checks(svc)
        slugs = set(
            CheckAssignment.objects.filter(service=svc).values_list(
                "template__slug", flat=True
            )
        )
        self.assertEqual(slugs, {"udp-53"})

    def test_api_round_trip_and_validation(self):
        dev, ip = self._device_with_ip()
        r = self.client.post(
            "/api/services/",
            {"name": "DNS", "device_id": str(dev.id), "ports": [53],
             "protocol_ports": {"tcp": [53], "udp": [53]}},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["protocol_ports"], {"tcp": [53], "udp": [53]})
        # Junk protocol and out-of-range ports are refused.
        for bad in (
            {"sctp": [53]},
            {"tcp": [0]},
            {"tcp": []},
            "nonsense",
        ):
            r = self.client.post(
                "/api/services/",
                {"name": "bad", "device_id": str(dev.id), "ports": [53],
                 "protocol_ports": bad},
                format="json",
            )
            self.assertEqual(r.status_code, 400, f"{bad}: {r.content}")

    def test_device_type_service_materialises_every_protocol(self):
        DeviceTypeService.objects.create(
            device_type=self.dt, name="DNS",
            protocol_ports={"tcp": [53], "udp": [53]}, monitor=True,
        )
        dev = Device.objects.create(
            tenant=self.tenant, name="dns1", device_type=self.dt
        )
        materialize_device_components(dev)
        svc = Service.objects.get(device=dev, name="DNS")
        self.assertEqual(svc.port_map(), {"tcp": [53], "udp": [53]})
        # bulk_create skips save(), so the legacy pair is mirrored explicitly.
        self.assertEqual(svc.protocol, "tcp")
        self.assertEqual(svc.ports, [53])
