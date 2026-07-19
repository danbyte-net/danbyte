"""Real-time presence over WebSockets (Channels consumer)."""
from __future__ import annotations

from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth.models import User
from django.test import TransactionTestCase, override_settings

from auth_api.models import UserProfile
from core import presence
from core.models import Organization, Tenant


@override_settings(
    CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
)
class PresenceWSTests(TransactionTestCase):
    # TransactionTestCase flushes ALL tables when each test ends — including
    # migration-seeded rows (the RBAC groups/grants from auth_api 0007). The
    # runner always orders these classes last, so within a run nothing is
    # harmed — but under --keepdb the FINAL flush persists into the next run,
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
        self.ot, self.oid = "device", "11111111-1111-1111-1111-111111111111"

    def tearDown(self):
        presence.leave(self.tenant.id, self.ot, self.oid, user_id=self.alice.id)
        presence.leave(self.tenant.id, self.ot, self.oid, user_id=self.bob.id)

    def _user(self, username, first, last):
        u = User.objects.create_user(username, password="x", first_name=first,
                                     last_name=last)
        p = UserProfile.objects.create(user=u)
        p.tenants.add(self.tenant)
        p.save()
        return u

    def _comm(self, user, mode):
        from api.ws_urls import websocket_urlpatterns

        app = URLRouter(websocket_urlpatterns)
        c = WebsocketCommunicator(
            app,
            f"/ws/presence/?object_type={self.ot}&object_id={self.oid}&mode={mode}",
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
