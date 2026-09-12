"""The live feed: gated like the API, fed by the writers, silent for the
addresses nobody is watching."""
from __future__ import annotations

import asyncio
import json
from unittest import mock

from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.contrib.auth.models import AnonymousUser, User
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from api.models import IPAddress, Prefix, Site
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import live
from .live_consumer import MonitoringLiveConsumer
from .models import CheckKind, CheckState, CheckTemplate, StateTransition

IN_MEMORY = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        asyncio.set_event_loop(None)
        loop.close()


@override_settings(CHANNEL_LAYERS=IN_MEMORY)
class LiveFeedTests(TransactionTestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.3.0.0/24", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.3.0.1", prefix=prefix, site=self.site_a
        )
        self.ip_b = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.3.0.2", prefix=prefix, site=self.site_b
        )
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind=CheckKind.ICMP
        )
        self.state = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp", status="up",
            last_latency_ms=1.0,
        )
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        # Interest lives in Redis in production; here, a dict.
        self.interest: set = set()
        mock.patch.object(live, "register_interest", side_effect=self.interest.add).start()
        mock.patch.object(
            live, "interested", side_effect=lambda ids: {str(i) for i in ids} & self.interest
        ).start()
        self.addCleanup(mock.patch.stopall)

    def _connect(self, user, ip_id, tenant_id=None):
        async def run():
            comm = WebsocketCommunicator(MonitoringLiveConsumer.as_asgi(), "/ws/monitoring/")
            comm.scope["user"] = user
            comm.scope["session"] = {
                "current_tenant_id": tenant_id if tenant_id is not None else str(self.tenant.id)
            }
            comm.scope["query_string"] = f"ip={ip_id}".encode()
            accepted, code = await comm.connect()
            hello = json.loads(await comm.receive_from()) if accepted else None
            return comm, accepted, code, hello

        return run

    def test_unauthenticated_and_unscoped_are_refused(self):
        async def run():
            comm, accepted, code, _ = await self._connect(AnonymousUser(), self.ip.id)()
            await comm.disconnect()
            return accepted, code

        accepted, code = _run(run())
        self.assertFalse(accepted)
        self.assertEqual(code, 4401)

        viewer = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=viewer, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="a", object_types=["ipaddress"], actions=["view"]
        )
        perm.users.add(viewer)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.site_a)

        async def run_b():
            comm, accepted, code, _ = await self._connect(viewer, self.ip_b.id)()
            await comm.disconnect()
            return accepted, code

        accepted, code = _run(run_b())
        self.assertFalse(accepted)
        self.assertEqual(code, 4404)

    def test_a_watcher_hears_a_write_and_nobody_else_costs_anything(self):
        async def run():
            comm, accepted, _, hello = await self._connect(self.admin, self.ip.id)()
            self.assertTrue(accepted)
            self.assertEqual(hello["ip"], str(self.ip.id))
            # The writer's side: a transition on the watched address.
            tr = StateTransition(
                tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
                from_status="up", to_status="down", at=timezone.now(),
            )
            self.state.status = "down"
            from asgiref.sync import sync_to_async

            sent = await sync_to_async(live.publish)([self.state], [tr])
            self.assertEqual(sent, 1)
            msg = json.loads(await comm.receive_from())
            await comm.disconnect()
            return msg

        msg = _run(run())
        self.assertEqual(msg["type"], "update")
        self.assertEqual(msg["template_id"], str(self.t.id))
        self.assertEqual(msg["status"], "down")
        self.assertEqual(msg["transition"]["to_status"], "down")
        # Nobody watches ip_b: no message, no channel-layer call.
        other = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_b, template=self.t, kind="icmp", status="up"
        )
        with mock.patch.object(get_channel_layer(), "group_send") as gs:
            self.assertEqual(live.publish([other]), 0)
            gs.assert_not_called()

    def test_samples_ride_along_for_the_fast_lane(self):
        self.interest.add(str(self.ip.id))
        with mock.patch("channels.layers.get_channel_layer") as gcl:
            layer = gcl.return_value

            async def group_send(group, message):
                layer.sent = message

            layer.group_send = group_send
            live.publish(
                [self.state], (),
                {str(self.state.id): [
                    {"status": "up", "latency_ms": 1.5, "at": "w"},
                    {"status": "up", "latency_ms": 2.5, "at": "x"},
                ]},
            )
        # The row moves on the newest; the page's ring gets the whole batch.
        self.assertEqual(layer.sent["payload"]["sample"]["latency_ms"], 2.5)
        self.assertEqual([p["at"] for p in layer.sent["payload"]["probes"]], ["w", "x"])
        self.assertEqual(layer.sent["type"], "monitoring.update")


@override_settings(CHANNEL_LAYERS=IN_MEMORY)
class ProbeRingTests(TransactionTestCase):
    """The last minutes of raw probes for a watched fast check - a ring in
    Redis, newest first, gone when nobody looks."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.4.0.0/24", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.4.0.1", prefix=prefix)
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="Fast", slug="fast", kind=CheckKind.ICMP, interval_ms=1000
        )
        self.state = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp", status="up",
            interval_ms=1000,
        )
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()
        # A fake ring: lists in a dict, with the same three calls.
        self.store: dict[str, list] = {}
        fake = mock.MagicMock()

        class Pipe:
            def __init__(inner):
                inner.ops = []

            def lpush(inner, key, *values):
                for value in values:
                    inner.ops.append(("lpush", key, value))

            def ltrim(inner, key, start, stop):
                inner.ops.append(("ltrim", key, start, stop))

            def expire(inner, key, ttl):
                pass

            def execute(inner):
                for op in inner.ops:
                    if op[0] == "lpush":
                        self.store.setdefault(op[1], []).insert(0, op[2])
                    elif op[0] == "ltrim":
                        self.store[op[1]] = self.store.get(op[1], [])[: op[3] + 1]

        fake.pipeline.side_effect = Pipe
        fake.lrange.side_effect = lambda key, a, b: self.store.get(key, [])[a : b + 1]
        mock.patch.object(live, "_redis", return_value=fake).start()
        self.addCleanup(mock.patch.stopall)

    def test_push_and_read_newest_first_capped(self):
        sid = str(self.state.id)
        for i in range(live.PROBES_KEEP + 5):
            live.push_probes({sid: [{"status": "up", "latency_ms": float(i), "at": f"t{i}"}]})
        ring = live.recent_probes(sid)
        self.assertEqual(len(ring), live.PROBES_KEEP)
        self.assertEqual(ring[0]["at"], f"t{live.PROBES_KEEP + 4}")
        # A 200 ms check hands over five per flush; the batch keeps its
        # order, newest at the head.
        live.push_probes({sid: [{"status": "up", "latency_ms": 1.0, "at": "b1"},
                                {"status": "up", "latency_ms": 2.0, "at": "b2"}]})
        ring = live.recent_probes(sid)
        self.assertEqual(len(ring), live.PROBES_KEEP)
        self.assertEqual([p["at"] for p in ring[:2]], ["b2", "b1"])
        r = self.client.get(f"/api/monitoring/ips/{self.ip.id}/probes/?template={self.t.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["fast"])
        self.assertEqual(len(r.json()["probes"]), live.PROBES_KEEP)

    def test_a_slow_check_has_no_ring(self):
        slow = CheckTemplate.objects.create(
            tenant=self.tenant, name="Slow", slug="slow", kind=CheckKind.ICMP
        )
        CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=slow, kind="icmp", status="up"
        )
        r = self.client.get(f"/api/monitoring/ips/{self.ip.id}/probes/?template={slow.id}")
        self.assertEqual(r.json(), {"probes": [], "kept_seconds": live.PROBES_TTL, "fast": False})
