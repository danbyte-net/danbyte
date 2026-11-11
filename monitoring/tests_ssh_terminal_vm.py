"""SshTerminalConsumer for a virtual machine - the same gate as a device.

A VM session (``/ws/ssh/vm/<id>/``) must hold exactly the device path's
guarantees: the deployment opt-in, the VM ``connect`` verb plus ``view``
(site scope included), tenant scoping, the host-key decision against the VM's
own recorded keys, the VM's own primary IP, a credential resolved server-side
and never sent to the browser, and a ``connect`` audit row naming the VM.

asyncssh is replaced by a fake for the one test that gets past the gate, so no
real SSH connection is opened.
"""
from __future__ import annotations

import asyncio
import json
from unittest import mock

import asyncssh
from channels.testing import WebsocketCommunicator
from django.contrib.auth.models import User
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    IPAddress,
    Prefix,
    Site,
    VirtualMachine,
)
from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import ConnectProtocol, DeviceCredential, SSHHostKey, StoredSecret
from .ssh_terminal_consumer import SshTerminalConsumer

SECRET = "vm-pw-s3cret"


def _vm(tenant, name, *, site=None, role=None):
    ct = ClusterType.objects.create(tenant=tenant, name=f"ct-{name}", slug=f"ct-{name}")
    cluster = Cluster.objects.create(tenant=tenant, name=f"c-{name}", type=ct)
    return VirtualMachine.objects.create(
        tenant=tenant, name=name, cluster=cluster, site=site, role=role
    )


class _FakeStdout:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def read(self, _n):
        return self._chunks.pop(0) if self._chunks else b""


class _FakeProc:
    returncode = 0

    def __init__(self):
        self.stdout = _FakeStdout([b"vm$ "])
        self.stdin = mock.Mock()

    def close(self):
        pass

    def change_terminal_size(self, *_a):
        pass


class _FakeConn:
    def get_server_host_key(self):
        return None

    async def create_process(self, **_kw):
        return _FakeProc()

    def close(self):
        pass


class SshTerminalVmGateTests(TransactionTestCase):
    @classmethod
    def tearDownClass(cls):
        # The final flush wipes the seeded built-in groups from a kept DB.
        super().tearDownClass()
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.hq = Site.objects.create(tenant=self.tenant, name="HQ")
        self.branch = Site.objects.create(tenant=self.tenant, name="Branch")
        self.vm = _vm(self.tenant, "web1", site=self.hq)
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.8.8.0/24")
        ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=prefix, ip_address="10.8.8.8"
        )
        self.vm.primary_ip = ip
        self.vm.save(update_fields=["primary_ip"])
        self.cred = DeviceCredential.objects.create(
            tenant=self.tenant, virtual_machine=self.vm, name="admin",
            kind="ssh_password", username="vmadmin",
            secret_provider="local", secret_path="creds/web1",
        )
        dep = DeploymentSettings.load()
        dep.secrets_provider = "local"
        dep.ssh_terminal_enabled = True
        dep.save(update_fields=["secrets_provider", "ssh_terminal_enabled"])
        StoredSecret.objects.create(
            tenant=self.tenant, ref="creds/web1", value={"password": SECRET}
        )

    @staticmethod
    def _run(coro):
        # A private loop per call (see tests_ssh_terminal._run, #81).
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

    def _grant(self, user, actions, *, sites=None):
        perm = ObjectPermission.objects.create(
            name=f"vm:{','.join(actions)}", object_types=["virtualmachine"],
            actions=actions,
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)

    def _host_key(self, vm=None):
        key = asyncssh.generate_private_key("ssh-ed25519")
        line = key.export_public_key().decode().split()
        from danbyte_checks.ssh_hostkey import parse_public_key_line

        parsed = parse_public_key_line(" ".join(line[:2]))
        return SSHHostKey.objects.create(
            tenant=self.tenant, virtual_machine=vm or self.vm,
            key_type=parsed["key_type"], public_key=parsed["public_key"],
            fingerprint_sha256=parsed["fingerprint"], uploaded=True,
        )

    def _connect(self, *, user, vm_id=None, credential=None, query=None):
        """Drive the consumer and return (accepted, [frames])."""
        vm_id = vm_id or str(self.vm.id)
        cred_id = credential if credential is not None else str(self.cred.id)
        qs = query if query is not None else f"credential={cred_id}"

        async def run():
            comm = WebsocketCommunicator(
                SshTerminalConsumer.as_asgi(), f"/ws/ssh/vm/{vm_id}/"
            )
            comm.scope["user"] = user
            comm.scope["session"] = {"current_tenant_id": str(self.tenant.id)}
            comm.scope["url_route"] = {"kwargs": {"vm_id": vm_id}}
            comm.scope["query_string"] = qs.encode()
            accepted, _ = await comm.connect()
            frames = []
            if accepted:
                while True:
                    try:
                        out = await comm.receive_output(timeout=2)
                    except TimeoutError:
                        break
                    if out.get("type") == "websocket.close":
                        break
                    if out.get("text"):
                        frames.append(out["text"])
                        # The interactive path waits for the login; stop here
                        # (a receive timeout would cancel the consumer).
                        if json.loads(out["text"]).get("t") == "need_auth":
                            break
            await comm.disconnect()
            return accepted, frames

        return self._run(run())

    def _first(self, frames):
        return json.loads(frames[0])

    def test_routing_reaches_the_consumer_for_a_vm(self):
        from api.ws_urls import websocket_urlpatterns

        path = f"ws/ssh/vm/{self.vm.id}/"
        match = next(p.pattern.match(path) for p in websocket_urlpatterns
                     if p.pattern.match(path))
        self.assertEqual(match[2]["vm_id"], str(self.vm.id))

    def test_feature_disabled_fails_closed(self):
        dep = DeploymentSettings.load()
        dep.ssh_terminal_enabled = False
        dep.save(update_fields=["ssh_terminal_enabled"])
        accepted, frames = self._connect(user=self._user("root", superuser=True))
        self.assertTrue(accepted)
        self.assertIn("disabled", self._first(frames)["m"].lower())

    def test_no_connect_verb_is_denied(self):
        u = self._user("viewer")
        self._grant(u, ["view"])
        _, frames = self._connect(user=u)
        msg = self._first(frames)
        self.assertEqual(msg["t"], "error")
        self.assertIn("connect permission for this virtual machine", msg["m"])

    def test_device_connect_does_not_reach_a_vm(self):
        u = self._user("devop")
        perm = ObjectPermission.objects.create(
            name="device:connect", object_types=["device"], actions=["view", "connect"]
        )
        perm.users.add(u)
        perm.tenants.add(self.tenant)
        self._grant(u, ["view"])
        _, frames = self._connect(user=u)
        self.assertIn("connect permission", self._first(frames)["m"])

    def test_connect_without_view_is_denied(self):
        u = self._user("blind")
        self._grant(u, ["connect"])
        _, frames = self._connect(user=u)
        self.assertIn("access to this virtual machine", self._first(frames)["m"])

    def test_grant_at_another_site_is_denied(self):
        u = self._user("branchops")
        self._grant(u, ["view", "connect"], sites=[self.branch])
        _, frames = self._connect(user=u)
        self.assertIn("connect permission", self._first(frames)["m"])

    def test_grant_at_the_vms_site_passes_the_gate(self):
        u = self._user("hqops")
        self._grant(u, ["view", "connect"], sites=[self.hq])
        _, frames = self._connect(user=u)
        # Past authz; stops at the host-key decision.
        self.assertEqual(self._first(frames)["code"], "hostkey_unknown")

    def test_vm_in_other_tenant_not_found(self):
        other = Tenant.objects.create(
            org=Organization.objects.create(name="P", slug="p"), name="Two", slug="two"
        )
        theirs = _vm(other, "theirs")
        _, frames = self._connect(
            user=self._user("root", superuser=True), vm_id=str(theirs.id)
        )
        self.assertEqual(self._first(frames)["m"], "Virtual machine not found.")

    def test_a_device_id_on_the_vm_route_is_not_found(self):
        d = Device.objects.create(tenant=self.tenant, name="sw1")
        _, frames = self._connect(
            user=self._user("root", superuser=True), vm_id=str(d.id)
        )
        self.assertEqual(self._first(frames)["m"], "Virtual machine not found.")

    def test_another_vms_credential_is_refused(self):
        other_vm = _vm(self.tenant, "db1", site=self.hq)
        cred = DeviceCredential.objects.create(
            tenant=self.tenant, virtual_machine=other_vm, name="x",
            kind="ssh_password", username="u", secret_provider="local",
            secret_path="creds/web1",
        )
        _, frames = self._connect(
            user=self._user("root", superuser=True), credential=str(cred.id)
        )
        self.assertIn("Pick an SSH credential", self._first(frames)["m"])

    def test_no_primary_ip_is_refused(self):
        self.vm.primary_ip = None
        self.vm.save(update_fields=["primary_ip"])
        _, frames = self._connect(user=self._user("root", superuser=True))
        self.assertIn("no primary IP", self._first(frames)["m"])

    def test_unknown_host_key_requires_accept_new(self):
        # Another VM's key does not count for this one.
        self._host_key(vm=_vm(self.tenant, "db1"))
        _, frames = self._connect(user=self._user("root", superuser=True))
        msg = self._first(frames)
        self.assertEqual(msg["code"], "hostkey_unknown")
        self.assertIn("virtual machine", msg["m"])
        self.assertNotIn(SECRET, "".join(frames))

    def test_interactive_mode_asks_for_login(self):
        _, frames = self._connect(
            user=self._user("alice", superuser=True), query="mode=interactive"
        )
        msg = self._first(frames)
        self.assertEqual(msg["t"], "need_auth")
        self.assertEqual(msg["username"], "alice")

    def test_session_pins_the_vm_key_and_ip_and_audits_the_vm(self):
        key = self._host_key()
        seen = {}

        async def fake_connect(**kw):
            seen.update(kw)
            return _FakeConn()

        with mock.patch.object(asyncssh, "connect", new=fake_connect):
            _, frames = self._connect(user=self._user("root", superuser=True))

        kinds = [json.loads(f)["t"] for f in frames]
        self.assertIn("ready", kinds)
        # The credential reached asyncssh, never a browser frame.
        self.assertEqual(seen["password"], SECRET)
        self.assertNotIn(SECRET, "".join(frames))
        self.assertEqual(seen["host"], "10.8.8.8")
        self.assertEqual(seen["username"], "vmadmin")
        self.assertEqual(
            seen["known_hosts"],
            f"10.8.8.8 {key.key_type} {key.public_key}\n".encode(),
        )
        entry = ChangeLogEntry.objects.get(action=ChangeAction.CONNECT)
        self.assertEqual(entry.object_type, "api.virtualmachine")
        self.assertEqual(entry.object_id, str(self.vm.id))
        self.assertEqual(entry.object_repr, "web1")
        self.assertEqual(entry.object_site_id, self.hq.id)
        self.assertNotIn(SECRET, json.dumps(entry.changes))


class VmConnectVerbTests(TestCase):
    def test_connect_is_a_vm_capability_verb(self):
        from auth_api.object_types import ACTIONS, CAPABILITY_VERBS, registry_payload

        self.assertIn("connect", ACTIONS)
        self.assertIn("connect", CAPABILITY_VERBS["virtualmachine"])
        vm = next(t for t in registry_payload() if t["slug"] == "virtualmachine")
        self.assertIn("connect", vm["actions"])

    def test_no_builtin_role_carries_connect(self):
        # Same as the device verb: never seeded, granted only by name.
        from auth_api.builtin_groups import BUILTINS, ensure_builtin_groups

        for _name, _desc, actions, _types in BUILTINS:
            self.assertNotIn("connect", actions)
        ensure_builtin_groups()
        self.assertFalse(
            ObjectPermission.objects.filter(actions__contains=["connect"]).exists()
        )

    def test_operator_role_cannot_connect_to_a_vm(self):
        from django.contrib.auth.models import Group

        from auth_api import rbac
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()
        tenant = Tenant.objects.create(
            org=Organization.objects.create(name="O", slug="o"), name="T", slug="t"
        )
        vm = _vm(tenant, "v")
        u = User.objects.create_user("op", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(tenant)
        for name in ("Administrator", "Operator"):
            u.groups.add(Group.objects.get(name=name))
        self.assertTrue(rbac.can_act_on(u, tenant, "virtualmachine", "change", vm))
        self.assertFalse(rbac.can_act_on(u, tenant, "virtualmachine", "connect", vm))


class VmConnectProtocolFilterTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.linux = DeviceRole.objects.create(tenant=self.tenant, name="Linux", slug="linux")
        self.switch = DeviceRole.objects.create(tenant=self.tenant, name="Sw", slug="sw")
        self.vm = _vm(self.tenant, "web1", role=self.linux)
        su = User.objects.create_user("root", password="x", is_superuser=True)
        UserProfile.objects.create(user=su, role="custom").tenants.add(self.tenant)
        self.client.force_login(su)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        ConnectProtocol.objects.filter(tenant=self.tenant).delete()

    def _proto(self, name, roles=()):
        p = ConnectProtocol.objects.create(
            tenant=self.tenant, name=name, url_template="ssh://{host}"
        )
        p.roles.set(roles)
        return p

    def names(self, vm_id):
        r = self.client.get(
            f"/api/monitoring/connect-protocols/?enabled=1&virtual_machine={vm_id}"
        )
        self.assertEqual(r.status_code, 200, r.content)
        return sorted(row["name"] for row in r.json()["results"])

    def test_untargeted_and_role_matched_only(self):
        self._proto("SSH")
        self._proto("Linux SSH", roles=[self.linux])
        self._proto("Switch SSH", roles=[self.switch])
        self.assertEqual(self.names(self.vm.id), ["Linux SSH", "SSH"])

    def test_other_tenant_or_bad_id_yields_nothing(self):
        self._proto("SSH")
        other = Tenant.objects.create(
            org=Organization.objects.create(name="P", slug="p"), name="Two", slug="two"
        )
        self.assertEqual(self.names(_vm(other, "x").id), [])
        self.assertEqual(self.names("not-a-uuid"), [])
