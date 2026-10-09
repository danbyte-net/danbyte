"""Real-time presence over WebSockets (Channels consumer)."""
from __future__ import annotations

from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth.models import User
from django.test import TransactionTestCase, override_settings

from api.models import Device
from auth_api.models import ObjectPermission, UserProfile
from core import presence
from core.models import Organization, Tenant


@override_settings(
    CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
)
class PresenceWSTests(TransactionTestCase):
    # TransactionTestCase flushes ALL tables when each test ends - including
    # migration-seeded rows (the RBAC groups/grants from auth_api 0007). The
    # runner always orders these classes last, so within a run nothing is
    # harmed - but under --keepdb the FINAL flush persists into the next run,
    # which then fails on Group.DoesNotExist. Re-seed on the way out.
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.alice = self._user("alice", "Alice", "Adams")
        self.bob = self._user("bob", "Bob", "Brown")
        self.device = Device.objects.create(tenant=self.tenant, name="sw-01")
        view = ObjectPermission.objects.create(
            name="device view", object_types=["device"], actions=["view"]
        )
        view.users.add(self.alice, self.bob)
        self.ot, self.oid = "device", str(self.device.id)

    def tearDown(self):
        presence.leave(self.tenant.id, self.ot, self.oid, user_id=self.alice.id)
        presence.leave(self.tenant.id, self.ot, self.oid, user_id=self.bob.id)

    def _user(self, username, first, last, role="custom"):
        u = User.objects.create_user(username, password="x", first_name=first,
                                     last_name=last)
        p = UserProfile.objects.create(user=u, role=role)
        p.tenants.add(self.tenant)
        p.save()
        return u

    def _comm(self, user, mode, ot=None, oid=None):
        from api.ws_urls import websocket_urlpatterns

        app = URLRouter(websocket_urlpatterns)
        c = WebsocketCommunicator(
            app,
            f"/ws/presence/?object_type={ot or self.ot}&object_id={oid or self.oid}"
            f"&mode={mode}",
        )
        c.scope["user"] = user
        c.scope["session"] = {"current_tenant_id": str(self.tenant.id)}
        return c

    async def test_realtime_presence_flow(self):
        a = self._comm(self.alice, "viewing")
        connected, _ = await a.connect()
        self.assertTrue(connected)
        first = await a.receive_json_from()
        self.assertEqual(first["present"], [])  # alone

        # Bob joins editing → Alice gets pushed an update naming Bob.
        b = self._comm(self.bob, "editing")
        await b.connect()
        await b.receive_json_from()  # Bob's own initial (sees Alice)
        update = await a.receive_json_from()
        self.assertEqual(len(update["present"]), 1)
        self.assertEqual(update["present"][0]["name"], "Bob Brown")
        self.assertEqual(update["present"][0]["mode"], "editing")

        # Bob disconnects → Alice is pushed back to empty.
        await b.disconnect()
        gone = await a.receive_json_from()
        self.assertEqual(gone["present"], [])
        await a.disconnect()

    async def test_rejects_anonymous(self):
        from django.contrib.auth.models import AnonymousUser
        from api.ws_urls import websocket_urlpatterns

        app = URLRouter(websocket_urlpatterns)
        c = WebsocketCommunicator(
            app, f"/ws/presence/?object_type={self.ot}&object_id={self.oid}"
        )
        c.scope["user"] = AnonymousUser()
        c.scope["session"] = {}
        connected, _ = await c.connect()
        self.assertFalse(connected)

    # ─── the same gate as GET /api/presence/ (#323) ─────────────────────
    async def _refused(self, user, ot=None, oid=None):
        c = self._comm(user, "viewing", ot, oid)
        connected, code = await c.connect()
        self.assertFalse(connected)
        self.assertEqual(code, 4403)

    def _eve(self):
        """A member whose only grant is site view - no Device access."""
        eve = self._user("eve", "Eve", "Evans")
        perm = ObjectPermission.objects.create(
            name="site view", object_types=["site"], actions=["view"]
        )
        perm.users.add(eve)
        return eve

    async def test_member_without_type_view_is_refused(self):
        from asgiref.sync import sync_to_async

        alice = self._comm(self.alice, "editing")
        await alice.connect()
        await alice.receive_json_from()
        eve = await sync_to_async(self._eve)()
        await self._refused(eve)
        # Eve was never announced on the device either.
        others = presence.present(self.tenant.id, self.ot, self.oid,
                                  exclude_user_id=self.alice.id)
        self.assertEqual(others, [])
        self.assertTrue(await alice.receive_nothing())
        await alice.disconnect()

    async def test_object_of_another_tenant_is_refused(self):
        from asgiref.sync import sync_to_async

        def foreign():
            other = Tenant.objects.create(org=self.tenant.org, name="T2", slug="t2")
            return str(Device.objects.create(tenant=other, name="x").id)

        oid = await sync_to_async(foreign)()
        await self._refused(self.alice, oid=oid)

    async def test_unknown_or_malformed_object_is_refused(self):
        for oid in ("33333333-3333-3333-3333-333333333333", "not-a-uuid"):
            await self._refused(self.alice, oid=oid)
