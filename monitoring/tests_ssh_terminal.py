"""SshTerminalConsumer - the authorization gate.

These exercise every check that must pass *before* an SSH connection is even
attempted: the deployment opt-in, authentication, active tenant, device
tenant-scoping, the ``connect`` verb, and the host-key trust decision. The paths
here all resolve without touching the network (they fail, or stop at the unknown
-host gate), so no live SSH server is needed to prove the gate holds.
"""
from __future__ import annotations

import asyncio
import json

from channels.testing import WebsocketCommunicator
from django.contrib.auth.models import AnonymousUser, User
from django.test import TransactionTestCase

from api.models import Device, IPAddress, Prefix
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import DeviceCredential, StoredSecret
from .ssh_terminal_consumer import SshTerminalConsumer


class SshTerminalGateTests(TransactionTestCase):
    @classmethod
    def tearDownClass(cls):
        # TransactionTestCase's final flush wipes the migration-seeded built-in
        # RBAC groups from a --keepdb database, breaking later suites that rely
        # on them. Reseed after the flush. (See the keepdb-flush gotcha.)
        super().tearDownClass()
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.9.0/24")
        ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=prefix, ip_address="10.9.9.9"
        )
        self.device.primary_ip = ip
        self.device.save(update_fields=["primary_ip"])
        self.cred = DeviceCredential.objects.create(
            tenant=self.tenant, device=self.device, name="admin",
            kind="ssh_password", username="netadmin",
            secret_provider="local", secret_path="creds/sw1",
        )
        dep = DeploymentSettings.load()
        dep.secrets_provider = "local"
        dep.ssh_terminal_enabled = True
        dep.save(update_fields=["secrets_provider", "ssh_terminal_enabled"])
        StoredSecret.objects.create(
            tenant=self.tenant, ref="creds/sw1", value={"password": "pw"}
        )

    @staticmethod
    def _run(coro):
        """Run a coroutine on its OWN event loop.

        ``async_to_sync`` picks up the thread's loop slot, and earlier suites
        that use ``asyncio.run`` can leave a *closed* loop there - so these
        seven tests errored under the full run and passed standalone (#81).
        A private loop per call has no ordering to be sensitive to.
        """
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.run_until_complete(loop.shutdown_asyncgens())
            asyncio.set_event_loop(None)
            loop.close()

    def _user(self, name, superuser=False):
        u = User.objects.create_user(name, password="x", is_superuser=superuser)
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        return u

    def test_interactive_mode_asks_for_login_without_a_credential(self):
        # No credential id, mode=interactive: the consumer authorizes, then asks
        # the client for the operator's own login (defaulting the username to the
        # Danbyte account) before touching the device.
        u = self._user("alice", superuser=True)

        async def run():
            comm = WebsocketCommunicator(
                SshTerminalConsumer.as_asgi(), f"/ws/ssh/{self.device.id}/"
            )
            comm.scope["user"] = u
            comm.scope["session"] = {"current_tenant_id": str(self.tenant.id)}
            comm.scope["url_route"] = {"kwargs": {"device_id": str(self.device.id)}}
            comm.scope["query_string"] = b"mode=interactive"
            accepted, _ = await comm.connect()
            msg = json.loads(await comm.receive_from()) if accepted else None
            await comm.disconnect()
            return accepted, msg

        accepted, msg = self._run(run())
        self.assertTrue(accepted)
        self.assertEqual(msg["t"], "need_auth")
        self.assertEqual(msg["username"], "alice")

    def _connect(self, *, user, device_id=None, tenant_id=None, credential=None,
                 accept_new=False):
        """Drive the consumer through connect() and return (accepted, first_msg).
        first_msg is the parsed error/ready frame, or None when closed pre-accept.
        """
        device_id = device_id or str(self.device.id)
        tenant_id = tenant_id if tenant_id is not None else str(self.tenant.id)
        cred_id = credential if credential is not None else str(self.cred.id)
        query = f"credential={cred_id}" + ("&accept_new=1" if accept_new else "")

        async def run():
            comm = WebsocketCommunicator(
                SshTerminalConsumer.as_asgi(), f"/ws/ssh/{device_id}/"
            )
            comm.scope["user"] = user
            comm.scope["session"] = {"current_tenant_id": tenant_id}
            comm.scope["url_route"] = {"kwargs": {"device_id": device_id}}
            comm.scope["query_string"] = query.encode()
            accepted, _ = await comm.connect()
            msg = None
            if accepted:
                raw = await comm.receive_from()
                msg = json.loads(raw)
            await comm.disconnect()
            return accepted, msg

        return self._run(run())

    def test_unauthenticated_is_rejected_pre_accept(self):
        accepted, _ = self._connect(user=AnonymousUser())
        self.assertFalse(accepted)

    def test_feature_disabled_fails_closed(self):
        dep = DeploymentSettings.load()
        dep.ssh_terminal_enabled = False
        dep.save(update_fields=["ssh_terminal_enabled"])
        accepted, msg = self._connect(user=self._user("root", superuser=True))
        self.assertTrue(accepted)
        self.assertEqual(msg["t"], "error")
        self.assertIn("disabled", msg["m"].lower())

    def test_no_connect_verb_is_denied(self):
        u = self._user("viewer")
        # Grant view on device but NOT the connect verb.
        perm = ObjectPermission.objects.create(
            name="device:view", object_types=["device"], actions=["view"]
        )
        perm.users.add(u)
        perm.tenants.add(self.tenant)
        accepted, msg = self._connect(user=u)
        self.assertTrue(accepted)
        self.assertEqual(msg["t"], "error")
        self.assertIn("connect", msg["m"].lower())

    def test_device_in_other_tenant_not_found(self):
        other_org = Organization.objects.create(name="P", slug="p")
        other = Tenant.objects.create(org=other_org, name="Two", slug="two")
        d2 = Device.objects.create(tenant=other, name="theirs")
        accepted, msg = self._connect(
            user=self._user("root", superuser=True), device_id=str(d2.id)
        )
        self.assertTrue(accepted)
        self.assertEqual(msg["t"], "error")

    def test_unknown_host_key_requires_accept_new(self):
        # Superuser, feature on, valid credential - but no recorded SSH host key
        # and accept_new not set: the consumer refuses before connecting.
        accepted, msg = self._connect(user=self._user("root", superuser=True))
        self.assertTrue(accepted)
        self.assertEqual(msg["t"], "error")
        self.assertEqual(msg["code"], "hostkey_unknown")

    def test_missing_credential_is_rejected(self):
        accepted, msg = self._connect(
            user=self._user("root", superuser=True), credential="",
        )
        self.assertTrue(accepted)
        self.assertEqual(msg["t"], "error")
