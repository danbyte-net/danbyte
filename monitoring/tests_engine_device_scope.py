"""Binding a monitoring engine to one device.

Before this, the finest grain was a site: sending a single switch to a Zabbix
meant moving the whole building, which is not a choice anybody should have to
make. Device beats location beats prefix beats site, and the resolver has to
say so in that order.
"""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, DeviceType, IPAddress, Manufacturer, Prefix, Site
from core.models import Organization, Tenant

from .engines import engine_for_device, engine_for_ip, set_binding
from .models import MonitoringEngine, MonitoringEngineBinding


class DeviceScopeBase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.local = MonitoringEngine.local_for(self.tenant)
        self.other = MonitoringEngine.objects.create(
            tenant=self.tenant, name="remote", slug="remote", kind="remote"
        )
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        vendor = Manufacturer.objects.create(tenant=self.tenant, name="V", slug="v")
        dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=vendor, model="M"
        )
        role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/24", site=self.site
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dtype, role=role,
            site=self.site,
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.5/24", prefix=self.prefix,
            assigned_device=self.device,
        )
        self.device.primary_ip = self.ip
        self.device.save(update_fields=["primary_ip"])


class ResolutionTests(DeviceScopeBase):
    def test_a_device_binding_wins_over_its_site(self):
        set_binding(self.tenant, MonitoringEngineBinding.SCOPE_SITE,
                    self.site.id, self.local)
        set_binding(self.tenant, MonitoringEngineBinding.SCOPE_DEVICE,
                    self.device.id, self.other)
        self.assertEqual(engine_for_device(self.device), self.other)
        self.assertEqual(engine_for_ip(self.ip), self.other)

    def test_a_device_binding_wins_over_its_prefix(self):
        set_binding(self.tenant, MonitoringEngineBinding.SCOPE_PREFIX,
                    self.prefix.id, self.local)
        set_binding(self.tenant, MonitoringEngineBinding.SCOPE_DEVICE,
                    self.device.id, self.other)
        self.assertEqual(engine_for_ip(self.ip), self.other)

    def test_without_a_device_binding_the_site_still_decides(self):
        set_binding(self.tenant, MonitoringEngineBinding.SCOPE_SITE,
                    self.site.id, self.other)
        self.assertEqual(engine_for_ip(self.ip), self.other)
        self.assertEqual(engine_for_device(self.device), self.other)

    def test_a_binding_on_another_device_does_not_leak(self):
        set_binding(self.tenant, MonitoringEngineBinding.SCOPE_DEVICE,
                    self.device.id, self.other)
        loose = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.6/24", prefix=self.prefix,
        )
        self.assertEqual(engine_for_ip(loose), self.local)

    def test_clearing_a_device_binding_falls_back(self):
        set_binding(self.tenant, MonitoringEngineBinding.SCOPE_SITE,
                    self.site.id, self.local)
        set_binding(self.tenant, MonitoringEngineBinding.SCOPE_DEVICE,
                    self.device.id, self.other)
        set_binding(self.tenant, MonitoringEngineBinding.SCOPE_DEVICE,
                    self.device.id, None)
        self.assertEqual(engine_for_ip(self.ip), self.local)


class OrphanDispatchTests(DeviceScopeBase):
    """A driver engine answers its own kind. Everything else on that target
    still has to run, or binding a device to Zabbix silently blinds its ping."""

    def setUp(self):
        super().setUp()
        from monitoring.models import CheckTemplate

        self.zbx_engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="zbx", slug="zbx", kind="zabbix"
        )
        set_binding(self.tenant, MonitoringEngineBinding.SCOPE_DEVICE,
                    self.device.id, self.zbx_engine)
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind="icmp",
            interval_seconds=300
        )

    def _state(self, kind, template):
        from django.utils import timezone

        from monitoring.models import CheckState

        return CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=template,
            engine=self.zbx_engine, kind=kind, interval_seconds=300,
            next_run=timezone.now() - timedelta(seconds=60),
        )

    def test_a_ping_on_a_zabbix_engine_is_still_dispatched(self):
        from monitoring.scheduler import _unclaimed_driver_states

        state = self._state("icmp", self.ping)
        orphans = _unclaimed_driver_states(timezone.now())
        self.assertEqual([s.id for s in orphans], [state.id])

    def test_the_drivers_own_kind_is_left_to_the_driver(self):
        from monitoring.models import CheckTemplate
        from monitoring.scheduler import _unclaimed_driver_states

        tpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="Zbx", slug="zbx-tpl", kind="zabbix",
            interval_seconds=300
        )
        self._state("zabbix", tpl)
        self.assertEqual(_unclaimed_driver_states(timezone.now()), [])


class ApiTests(DeviceScopeBase):
    def setUp(self):
        super().setUp()
        self.user = get_user_model().objects.create_superuser("a", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def url(self, scope, oid):
        return f"/api/monitoring/engine-binding/{scope}/{oid}/"

    def test_the_device_scope_is_accepted(self):
        r = self.client.put(
            self.url("device", self.device.id),
            {"engine_id": str(self.other.id)}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data["engine_id"], str(self.other.id))
        r = self.client.get(self.url("device", self.device.id))
        self.assertEqual(r.data["engine_id"], str(self.other.id))

    def test_an_unknown_scope_is_still_refused(self):
        r = self.client.get(self.url("rack", self.device.id))
        self.assertEqual(r.status_code, 400)
