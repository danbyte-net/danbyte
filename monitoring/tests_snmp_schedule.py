"""Scheduled SNMP polling from the core (#284 P4b).

``dispatch_snmp_polls`` enqueues the devices a tenant's **Poll devices every**
setting makes due: off by default, one poll per stack, an Outpost's devices
left to it, and each tick taking only its share of the estate so the polls
spread across the interval.
"""
from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, Site, VirtualChassis
from core.models import Organization, ScheduledRun, Tenant
from monitoring import snmp_schedule
from monitoring.engines import set_binding
from monitoring.mac_jobs import lock_key
from monitoring.models import DeviceSnmp, MonitoringEngine, MonitoringSettings

User = get_user_model()


class FakeRedis:
    def __init__(self):
        self.kv = {}

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.kv:
            return False
        self.kv[key] = str(value).encode()
        return True

    def get(self, key):
        return self.kv.get(key)

    def exists(self, key):
        return int(key in self.kv)

    def delete(self, key):
        self.kv.pop(key, None)

    def pipeline(self):
        return FakePipeline(self)


class FakePipeline:
    def __init__(self, redis):
        self.redis, self.ops = redis, []

    def exists(self, key):
        self.ops.append(key)

    def execute(self):
        return [self.redis.exists(k) for k in self.ops]


class FakeQueue:
    def __init__(self):
        self.jobs = []

    def enqueue(self, fn, *args, **kwargs):
        self.jobs.append((fn, args))


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="hq")
        self.redis, self.queue = FakeRedis(), FakeQueue()
        for p in (
            mock.patch("monitoring.snmp_schedule._conn", return_value=self.redis),
            mock.patch("monitoring.snmp_schedule._queue", return_value=self.queue),
            mock.patch("monitoring.mac_jobs._conn", return_value=self.redis),
        ):
            p.start()
            self.addCleanup(p.stop)

    def interval(self, minutes, tenant=None):
        MonitoringSettings.objects.update_or_create(
            tenant=tenant or self.tenant,
            defaults={"snmp_poll_interval_minutes": minutes},
        )

    def device(self, name, **kw):
        return Device.objects.create(tenant=self.tenant, name=name, site=self.site, **kw)

    def polled(self, device, ago_minutes):
        DeviceSnmp.objects.update_or_create(
            tenant=self.tenant, device=device,
            defaults={"polled_at": timezone.now() - timedelta(minutes=ago_minutes)},
        )

    def enqueued(self):
        return [args[0] for _fn, args in self.queue.jobs]


class SettingTests(_Base):
    def test_off_by_default(self):
        self.assertEqual(MonitoringSettings.for_tenant(self.tenant).snmp_poll_interval_minutes, 0)
        self.device("sw1")
        self.assertEqual(snmp_schedule.dispatch()["enabled"], False)
        self.assertEqual(self.queue.jobs, [])

    def test_the_command_logs_a_skip_while_off(self):
        call_command("dispatch_snmp_polls", stdout=mock.Mock())
        run = ScheduledRun.objects.get(name="snmp-poll")
        self.assertEqual(run.status, ScheduledRun.SKIPPED)

    def test_an_inactive_tenant_is_not_polled(self):
        self.interval(15)
        self.device("sw1")
        Tenant.objects.filter(pk=self.tenant.pk).update(is_active=False)
        self.assertEqual(snmp_schedule.dispatch()["enabled"], False)


class SettingApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.client.force_login(User.objects.create_superuser("a", "a@b.c", "pw"))
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_the_interval_round_trips_and_only_offered_values_are_taken(self):
        r = self.client.patch(
            "/api/monitoring/settings/", {"snmp_poll_interval_minutes": 30}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["snmp_poll_interval_minutes"], 30)
        r = self.client.patch(
            "/api/monitoring/settings/", {"snmp_poll_interval_minutes": 7}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("snmp_poll_interval_minutes", r.json())


class SelectionTests(_Base):
    def test_due_devices_are_enqueued_and_fresh_ones_are_not(self):
        self.interval(15)
        stale, fresh, never = self.device("stale"), self.device("fresh"), self.device("never")
        self.polled(stale, 20)
        self.polled(fresh, 3)
        with mock.patch("monitoring.snmp_schedule.tick_budget", return_value=10):
            snmp_schedule.dispatch()
        self.assertEqual(set(self.enqueued()), {str(stale.id), str(never.id)})

    def test_an_outpost_device_is_left_to_its_outpost(self):
        self.interval(15)
        outpost = MonitoringEngine.objects.create(
            tenant=self.tenant, name="op", slug="op", kind="remote", transport="pull",
            token={"secret": "t"},
        )
        branch = Site.objects.create(tenant=self.tenant, name="branch")
        set_binding(self.tenant, "site", branch.id, outpost)
        remote = Device.objects.create(tenant=self.tenant, name="remote", site=branch)
        local = self.device("local")
        snmp_schedule.dispatch()
        self.assertEqual(self.enqueued(), [str(local.id)])
        self.assertNotIn(str(remote.id), self.enqueued())

    def test_a_disabled_outpost_hands_its_devices_back_to_the_core(self):
        self.interval(15)
        outpost = MonitoringEngine.objects.create(
            tenant=self.tenant, name="op", slug="op", kind="remote", transport="pull",
            token={"secret": "t"}, enabled=False,
        )
        dev = self.device("sw")
        set_binding(self.tenant, "device", dev.id, outpost)
        snmp_schedule.dispatch()
        self.assertEqual(self.enqueued(), [str(dev.id)])

    def test_a_zabbix_bound_device_polls_from_the_core(self):
        """A driver engine answers its own check kind only - SNMP stays on the
        core, as Poll now and poll_snmp decide (#325)."""
        self.interval(15)
        zbx = MonitoringEngine.objects.create(
            tenant=self.tenant, name="zbx", slug="zbx", kind="zabbix",
        )
        dev = self.device("sw-zbx")
        with mock.patch(
            "monitoring.engines.engines_for_devices",
            side_effect=lambda tenant, devices: {d.id: zbx for d in devices},
        ):
            snmp_schedule.dispatch()
        self.assertEqual(self.enqueued(), [str(dev.id)])

    def test_a_stack_is_polled_once_on_its_owner(self):
        self.interval(15)
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        master = self.device("m1", virtual_chassis=vc, vc_position=2)
        self.device("m2", virtual_chassis=vc, vc_position=1)
        vc.master = master
        vc.save()
        snmp_schedule.dispatch()
        self.assertEqual(self.enqueued(), [str(master.id)])

    def test_another_tenants_setting_does_not_poll_this_tenant(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.interval(15, tenant=other)
        self.device("ours")
        theirs = Device.objects.create(
            tenant=other, name="theirs", site=Site.objects.create(tenant=other, name="s")
        )
        snmp_schedule.dispatch()
        self.assertEqual(self.enqueued(), [str(theirs.id)])

    def test_a_claimed_device_is_not_enqueued_twice(self):
        self.interval(15)
        self.device("sw")
        snmp_schedule.dispatch()
        snmp_schedule.dispatch()
        self.assertEqual(len(self.queue.jobs), 1)

    def test_a_running_mac_refresh_holds_the_device(self):
        self.interval(15)
        dev = self.device("sw")
        self.redis.set(lock_key(dev.id), "run")
        r = snmp_schedule.dispatch()
        self.assertEqual(self.queue.jobs, [])
        self.assertEqual(r["claimed"], 1)


class StaggerTests(_Base):
    def test_the_budget_is_the_estates_share_of_one_tick(self):
        self.assertEqual(snmp_schedule.tick_budget(1000, 60), 84)
        self.assertEqual(snmp_schedule.tick_budget(1000, 15), 334)
        self.assertEqual(snmp_schedule.tick_budget(3, 60), 1)
        self.assertEqual(snmp_schedule.tick_budget(0, 60), 0)

    def test_switching_on_spreads_the_first_round_across_the_interval(self):
        """Twelve never-polled devices on a 15-minute interval with a 5-minute
        tick: four per tick, never all twelve at once."""
        self.interval(15)
        for i in range(12):
            self.device(f"sw{i:02}")
        seen = []
        for _tick in range(3):
            before = len(self.queue.jobs)
            snmp_schedule.dispatch()
            batch = self.enqueued()[before:]
            self.assertEqual(len(batch), 4)
            seen += batch
        self.assertEqual(len(set(seen)), 12)
        snmp_schedule.dispatch()
        self.assertEqual(len(self.queue.jobs), 12)  # every device claimed

    def test_the_oldest_poll_goes_first(self):
        self.interval(60)
        devices = [self.device(f"sw{i}") for i in range(12)]
        for i, d in enumerate(devices):
            self.polled(d, 61 + i)  # sw11 is the stalest
        snmp_schedule.dispatch()
        self.assertEqual(self.enqueued(), [str(devices[11].id)])

    def test_the_claim_expires_before_the_device_is_next_due(self):
        self.interval(15)
        self.device("sw")
        with mock.patch.object(self.redis, "set", wraps=self.redis.set) as setter:
            snmp_schedule.dispatch()
        ttl = setter.call_args.kwargs["ex"]
        self.assertLess(ttl, 15 * 60)
        self.assertGreater(ttl, 15 * 60 - snmp_schedule.TICK_SECONDS)


class JobTests(_Base):
    def test_the_job_polls_the_device(self):
        self.interval(15)
        dev = self.device("sw")
        state = mock.Mock(reachable=True)
        with mock.patch("monitoring.snmp_poll.poll_device", return_value=(state, None)) as poll:
            self.assertEqual(snmp_schedule.poll_scheduled(str(dev.id), str(self.tenant.id)), "polled")
        self.assertEqual(poll.call_args.args[0].id, dev.id)
        self.assertNotIn(lock_key(dev.id), self.redis.kv)  # released

    def test_the_job_rechecks_the_setting(self):
        dev = self.device("sw")
        with mock.patch("monitoring.snmp_poll.poll_device") as poll:
            self.assertEqual(snmp_schedule.poll_scheduled(str(dev.id), str(self.tenant.id)), "off")
        poll.assert_not_called()

    def test_the_job_ignores_a_device_of_another_tenant(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.interval(15, tenant=other)
        dev = self.device("ours")
        with mock.patch("monitoring.snmp_poll.poll_device") as poll:
            self.assertEqual(snmp_schedule.poll_scheduled(str(dev.id), str(other.id)), "skipped")
        poll.assert_not_called()

    def test_the_job_leaves_a_device_that_moved_to_an_outpost(self):
        self.interval(15)
        dev = self.device("sw")
        outpost = MonitoringEngine.objects.create(
            tenant=self.tenant, name="op", slug="op", kind="remote", transport="pull",
            token={"secret": "t"},
        )
        set_binding(self.tenant, "device", dev.id, outpost)
        with mock.patch("monitoring.snmp_poll.poll_device") as poll:
            self.assertEqual(snmp_schedule.poll_scheduled(str(dev.id), str(self.tenant.id)), "remote")
        poll.assert_not_called()

    def test_the_job_waits_for_a_running_refresh(self):
        self.interval(15)
        dev = self.device("sw")
        self.redis.set(lock_key(dev.id), "other-run")
        with mock.patch("monitoring.snmp_poll.poll_device") as poll:
            self.assertEqual(snmp_schedule.poll_scheduled(str(dev.id), str(self.tenant.id)), "busy")
        poll.assert_not_called()
        self.assertEqual(self.redis.get(lock_key(dev.id)), b"other-run")


class CommandTests(_Base):
    def test_the_command_records_its_run(self):
        self.interval(15)
        self.device("sw")
        call_command("dispatch_snmp_polls", stdout=mock.Mock())
        run = ScheduledRun.objects.get(name="snmp-poll")
        self.assertEqual(run.status, ScheduledRun.OK)
        self.assertEqual(run.detail["enqueued"], 1)
