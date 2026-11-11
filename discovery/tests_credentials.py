"""Discovery at scale (#451): shared credentials in a run, the host-key
review, accepting keys on first use, and the run outcome wording."""
from __future__ import annotations

import json
from unittest import mock

from django.contrib.auth.models import User
from django.test import SimpleTestCase, override_settings

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from danbyte_checks import inventory as inv
from monitoring.models import DeviceCredential, SharedCredential, SSHHostKey

from . import outposts, runner, scope
from .models import DiscoverySettings, InventoryHostResult
from .tests_discovery import KEY, SECRET, ApiBase, Base, FakeCollector, result

OTHER_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOtherKeyOtherKeyOtherKeyOtherKeyOt"
TAKEN = {"key_type": "ssh-ed25519", "public_key": KEY, "fingerprint": "SHA256:taken"}


def secrets(self):
    return {"password": SECRET}


class FirstUseCollector(FakeCollector):
    """Hands back the key the handshake took when asked for first use."""

    async def collect(self, host, *, port=22, timeout=60.0, **cred):
        out = await super().collect(host, port=port, timeout=timeout, **cred)
        if cred.get("first_use"):
            out.host_key = dict(TAKEN)
        return out


@mock.patch.object(DeviceCredential, "resolve_secret", secrets)
@mock.patch.object(SharedCredential, "resolve_secret", secrets)
class SharedInRunTests(Base):
    def setUp(self):
        self.a = self.host("a", "10.0.0.1", site=self.site, cred=None)
        self.b = self.host("b", "10.0.0.2", site=self.site)
        self.p = self.profile()
        self.p.sites.add(self.site)

    def go(self, results, collector=FakeCollector, **start):
        with mock.patch.object(runner, "enqueue"):
            run = runner.start(self.p, user=start.pop("user", self.su), **start)
        fake = collector(results)
        runner.execute(str(run.pk), collect=fake.collect, observe=fake.observe)
        run.refresh_from_db()
        return run, fake

    def test_host_credential_first_then_shared(self):
        s = SharedCredential.objects.create(tenant=self.tenant, name="ops", kind="ssh_password",
                                            username="ops", all_hosts=True,
                                            secret_managed=False, secret_path="ext/ops")
        run, fake = self.go({"10.0.0.1": result, "10.0.0.2": result})
        self.assertEqual(run.status, "ok")
        src = dict(InventoryHostResult.objects.filter(run=run).values_list(
            "device__name", "credential_source"))
        self.assertEqual(src, {"a": "shared: ops", "b": "host"})
        users = {c[0]: c[2]["username"] for c in fake.calls}
        self.assertEqual(users, {"10.0.0.1": "ops", "10.0.0.2": "inv"})
        blob = json.dumps(list(InventoryHostResult.objects.values()), default=str)
        blob += json.dumps(run.counts)
        self.assertNotIn(SECRET, blob)
        # A pinned credential comes before the matching ones.
        pinned = SharedCredential.objects.create(
            tenant=self.tenant, name="pinned", kind="ssh_password", username="pin",
            secret_managed=False, secret_path="ext/p")
        self.p.shared_credential = pinned
        self.p.save()
        run, fake = self.go({"10.0.0.1": result, "10.0.0.2": result})
        self.assertEqual(InventoryHostResult.objects.get(run=run, device=self.a)
                         .credential_source, "shared: pinned")
        self.assertTrue(s)

    def test_a_refused_login_falls_through_only_when_allowed(self):
        SharedCredential.objects.create(tenant=self.tenant, name="1", kind="ssh_password",
                                        username="one", all_hosts=True, weight=1,
                                        secret_managed=False, secret_path="ext/1")
        SharedCredential.objects.create(tenant=self.tenant, name="2", kind="ssh_password",
                                        username="two", all_hosts=True, weight=2,
                                        secret_managed=False, secret_path="ext/2")
        refused = inv.InventoryResult(inv.AUTH_FAILED, "The host refused the credential.")
        SSHHostKey.objects.filter(device=self.b).delete()
        run, fake = self.go({"10.0.0.1": refused})
        self.assertEqual([c[2]["username"] for c in fake.calls], ["one"])
        SharedCredential.objects.filter(name="1").update(fall_through=True)
        answers = iter([refused, result()])
        run, fake = self.go({"10.0.0.1": lambda: next(answers)})
        self.assertEqual([c[2]["username"] for c in fake.calls], ["one", "two"])
        self.assertEqual(InventoryHostResult.objects.get(run=run, device=self.a)
                         .credential_source, "shared: 2")

    def test_nothing_read_is_not_failed(self):
        SSHHostKey.objects.filter(device=self.b).delete()
        run, fake = self.go({})
        self.assertEqual(run.status, "nothing_read")
        self.assertEqual(fake.calls, [])
        self.assertEqual(runner.summary(run.counts),
                         "1 without a credential, 1 without an accepted host key")
        # The hosts left alone still had their keys read for review.
        self.assertTrue(SSHHostKey.objects.filter(device=self.a, observed=True).exists())
        self.assertTrue(SSHHostKey.objects.filter(device=self.b, observed=True).exists())

    def test_a_real_failure_is_failed(self):
        down = inv.InventoryResult(inv.UNREACHABLE, "OSError")
        run, _ = self.go({"10.0.0.2": down})
        self.assertEqual(run.status, "failed")

    # ── accept on first use ───────────────────────────────────────────────

    def test_first_use_is_off_by_default(self):
        SSHHostKey.objects.filter(device=self.b).delete()
        run, fake = self.go({"10.0.0.2": result}, FirstUseCollector)
        self.assertFalse(run.accept_new_host_keys)
        self.assertEqual(fake.calls, [])
        self.assertFalse(SSHHostKey.objects.filter(device=self.b, uploaded=True).exists())

    def test_first_use_accepts_and_logs(self):
        SSHHostKey.objects.filter(device=self.b).delete()
        run, fake = self.go({"10.0.0.2": result}, FirstUseCollector,
                            accept_new_host_keys=True)
        self.assertEqual(fake.calls[0][2]["first_use"], True)
        self.assertIsNone(fake.calls[0][2]["known_hosts"])
        key = SSHHostKey.objects.get(device=self.b)
        self.assertTrue(key.uploaded)
        self.assertEqual(key.fingerprint_sha256, "SHA256:taken")
        row = InventoryHostResult.objects.get(run=run, device=self.b)
        self.assertTrue(row.key_first_use)
        self.assertEqual(run.counts["keys_accepted"], 1)
        entry = ChangeLogEntry.objects.filter(object_type="monitoring.sshhostkey",
                                              object_id=str(key.pk)).latest("timestamp")
        self.assertEqual(entry.user_name, "root")
        self.assertIn(str(run.pk), entry.cause)
        self.assertIn("first use", entry.cause)

    def test_first_use_never_replaces_an_accepted_key(self):
        refused = inv.InventoryResult(inv.HOST_KEY_REFUSED, "The host key does not match.")
        run, fake = self.go({"10.0.0.2": refused}, FirstUseCollector,
                            accept_new_host_keys=True)
        # b has an accepted key: it is pinned, never first use.
        self.assertNotIn("first_use", fake.calls[0][2])
        self.assertTrue(fake.calls[0][2]["known_hosts"])
        self.assertEqual(InventoryHostResult.objects.get(run=run, device=self.b).status,
                         "host_key_refused")
        self.assertFalse(SSHHostKey.objects.filter(device=self.b, uploaded=True,
                                                   fingerprint_sha256="SHA256:seen").exists())

    def test_scheduled_runs_never_accept(self):
        SSHHostKey.objects.filter(device=self.b).delete()
        with mock.patch.object(runner, "enqueue"):
            run = runner.start(self.p, trigger="schedule", accept_new_host_keys=True)
        self.assertFalse(run.accept_new_host_keys)

    @override_settings(DISCOVERY_ALLOW_FIRST_USE_KEYS=False)
    def test_the_deployment_lock_is_rechecked_by_the_job(self):
        SSHHostKey.objects.filter(device=self.b).delete()
        run, fake = self.go({"10.0.0.2": result}, FirstUseCollector,
                            accept_new_host_keys=True)
        self.assertEqual(fake.calls, [])
        self.assertIn("does not allow", " ".join(run.errors))

    def test_a_starter_without_key_rights_gets_no_first_use(self):
        SSHHostKey.objects.filter(device=self.b).delete()
        user = User.objects.create_user("op", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="op", object_types=["inventoryprofile", "device", "virtualmachine",
                                     "devicecredential"], actions=["view", "scan"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        run, fake = self.go({"10.0.0.2": result}, FirstUseCollector, user=user,
                            accept_new_host_keys=True)
        self.assertEqual(fake.calls, [])
        self.assertIn("may no longer accept host keys", " ".join(run.errors))


class LoginOrderTests(Base):
    """The host's own credentials, then the pinned one, then the matching
    shared ones by weight; a key before a password within each, WinRM after
    SSH; the transport switches filter; three at most."""

    def setUp(self):
        self.a = self.host("a", "10.0.0.1", site=self.site, cred=None)
        self.p = self.profile()
        self.p.sites.add(self.site)
        self.row = DiscoverySettings.for_tenant(self.tenant)

    def own(self, kind, name=None):
        return DeviceCredential.objects.create(
            tenant=self.tenant, device=self.a, name=name or kind, kind=kind, username="u",
            secret_managed=False, secret_path=f"x/{kind}")

    def shared(self, name, kind, weight=100):
        return SharedCredential.objects.create(
            tenant=self.tenant, name=name, kind=kind, username="u", weight=weight,
            all_hosts=True, secret_managed=False, secret_path=f"ext/{name}")

    def order(self, **kw):
        (t,) = scope.resolve(self.p, **kw)
        return [(x.source, x.kind) for x in t.logins]

    def test_own_password_before_a_shared_key(self):
        self.own("ssh_password")
        self.shared("k", "ssh_key", weight=1)
        self.assertEqual(self.order(), [("host", "ssh_password"), ("shared: k", "ssh_key")])

    def test_key_before_password_within_each_group(self):
        self.own("ssh_password")
        self.own("ssh_key")
        self.shared("pw", "ssh_password", weight=1)
        self.shared("key", "ssh_key", weight=5)
        self.assertEqual(self.order(), [("host", "ssh_key"), ("host", "ssh_password"),
                                        ("shared: key", "ssh_key")])
        DeviceCredential.objects.filter(device=self.a).delete()
        self.assertEqual(self.order(), [("shared: key", "ssh_key"),
                                        ("shared: pw", "ssh_password")])

    def test_weight_orders_shared_credentials_of_a_kind(self):
        self.shared("b", "ssh_password", weight=2)
        self.shared("a", "ssh_password", weight=1)
        self.assertEqual(self.order(), [("shared: a", "ssh_password"),
                                        ("shared: b", "ssh_password")])

    def test_pinned_between_own_and_matching(self):
        self.own("ssh_password")
        self.shared("m", "ssh_key", weight=1)
        self.p.shared_credential = self.shared("pin", "ssh_password")
        self.p.save()
        self.assertEqual(self.order(), [("host", "ssh_password"),
                                        ("shared: pin", "ssh_password"),
                                        ("shared: m", "ssh_key")])

    def test_password_switch_drops_every_password(self):
        self.own("ssh_password")
        self.shared("pw", "ssh_password", weight=1)
        self.shared("key", "ssh_key", weight=5)
        DiscoverySettings.objects.filter(pk=self.row.pk).update(ssh_password_enabled=False)
        self.assertEqual(self.order(), [("shared: key", "ssh_key")])

    def test_winrm_after_ssh_of_the_same_source_and_only_when_on(self):
        self.own("winrm_cert")
        self.own("ssh_password")
        self.shared("key", "ssh_key", weight=1)
        self.assertEqual(self.order(), [("host", "ssh_password"), ("shared: key", "ssh_key")])
        DiscoverySettings.objects.filter(pk=self.row.pk).update(winrm_enabled=True)
        self.assertEqual(self.order(), [("host", "ssh_password"), ("host", "winrm_cert"),
                                        ("shared: key", "ssh_key")])

    def test_three_at_most(self):
        self.own("ssh_key")
        self.own("ssh_password")
        self.shared("a", "ssh_key", weight=1)
        self.shared("b", "ssh_key", weight=2)
        self.assertEqual(len(self.order()), 3)

    def test_outposts_get_the_same_order_without_winrm(self):
        self.own("ssh_password")
        self.own("winrm_cert")
        self.shared("key", "ssh_key", weight=1)
        DiscoverySettings.objects.filter(pk=self.row.pk).update(winrm_enabled=True)
        (t,) = scope.resolve(self.p, outpost=True)
        self.assertEqual([(r["source"], r["transport"]) for r in outposts._login_refs(t)],
                         [("host", "ssh_password"), ("shared: key", "ssh_key")])


class NoUserNameTests(Base):
    """A login without a user name is never guessed as root: it is skipped
    with a reason, and the next login of the host is used."""

    def setUp(self):
        self.a = self.host("a", "10.0.0.1", site=self.site, cred=None)
        self.p = self.profile()
        self.p.sites.add(self.site)

    def test_skipped_with_a_reason(self):
        DeviceCredential.objects.create(tenant=self.tenant, device=self.a, name="n",
                                        kind="ssh_password", username="  ",
                                        secret_managed=False, secret_path="x/n")
        (t,) = scope.resolve(self.p)
        self.assertEqual((t.skip, t.message), ("no_credential", scope.NO_USER_NAME))
        self.assertIn({"transport": "ssh_password", "outcome": "skipped",
                       "reason": scope.NO_USER_NAME}, t.extra["skipped"])

    @mock.patch.object(DeviceCredential, "resolve_secret", secrets)
    @mock.patch.object(SharedCredential, "resolve_secret", secrets)
    def test_the_next_login_is_used_and_root_never_sent(self):
        DeviceCredential.objects.create(tenant=self.tenant, device=self.a, name="n",
                                        kind="ssh_password", username="",
                                        secret_managed=False, secret_path="x/n")
        SharedCredential.objects.create(tenant=self.tenant, name="ops", kind="ssh_password",
                                        username="ops", all_hosts=True,
                                        secret_managed=False, secret_path="ext/ops")
        with mock.patch.object(runner, "enqueue"):
            run = runner.start(self.p, user=self.su)
        fake = FakeCollector({"10.0.0.1": result})
        runner.execute(str(run.pk), collect=fake.collect, observe=fake.observe)
        self.assertEqual([c[2]["username"] for c in fake.calls], ["ops"])
        row = InventoryHostResult.objects.get(run=run)
        self.assertEqual(row.credential_source, "shared: ops")
        self.assertIn(scope.NO_USER_NAME, [a["reason"] for a in row.attempts])

    def test_the_shared_loop_refuses_a_blank_user(self):
        import asyncio

        calls = []

        async def collect(address, **kw):
            calls.append(kw)
            return inv.InventoryResult(inv.OK)

        async def observe(*a, **kw):
            return None

        result_, _o, used, tried = asyncio.run(inv.read_with_logins(
            "10.0.0.1", [{"transport": "ssh_password", "credential": {"username": ""}}],
            known_hosts=None, first_use=False, timeout=5, collect=collect, observe=observe))
        self.assertEqual(calls, [])
        self.assertIsNone(used)
        self.assertEqual(tried[0]["reason"], "The credential has no user name.")


class LoginLoopTests(SimpleTestCase):
    """``read_with_logins``: an SSH port that does not answer moves on to
    the next login on another transport, skipping the SSH ones between."""

    def test_unreachable_ssh_skips_to_winrm(self):
        import asyncio

        calls = []

        async def collect(address, **kw):
            calls.append("ssh")
            return inv.InventoryResult(inv.UNREACHABLE, "OSError")

        async def winrm(address, **kw):
            calls.append("winrm")
            return inv.InventoryResult(inv.OK)

        async def observe(*a, **kw):
            return None

        logins = [{"transport": "ssh_password", "credential": {"username": "u"}},
                  {"transport": "ssh_key", "credential": {"username": "u"}},
                  {"transport": "winrm", "credential": {}}]
        result, _obs, used, tried = asyncio.run(inv.read_with_logins(
            "10.0.0.1", logins, known_hosts=None, first_use=False, timeout=5,
            collect=collect, observe=observe, collect_winrm=winrm))
        self.assertEqual(calls, ["ssh", "winrm"])
        self.assertEqual((result.status, used), (inv.OK, 2))
        self.assertEqual([t["outcome"] for t in tried], [inv.UNREACHABLE, "skipped", inv.OK])


class OutcomeTests(SimpleTestCase):
    def test_mapping(self):
        f = runner.run_outcome
        self.assertEqual(f([("ok", True), ("exempt", False)]), "ok")
        self.assertEqual(f([("no_credential", False), ("host_key_refused", False)]),
                         "nothing_read")
        self.assertEqual(f([("no_credential", False), ("auth_failed", True)]), "failed")
        self.assertEqual(f([("ok", True), ("no_credential", False)]), "partial")
        self.assertEqual(f([("exempt", False)]), "ok")

    def test_first_use_options_pin_the_first_key(self):
        opts = inv.connect_options(username="u", password="p", known_hosts=None,
                                   first_use=True)
        self.assertEqual(opts["known_hosts"], ([], [], []))
        client = opts["client_factory"]()
        k1, k2 = object(), object()
        self.assertTrue(client.validate_host_public_key("h", "h", 22, k1))
        self.assertTrue(client.validate_host_public_key("h", "h", 22, k1))
        self.assertFalse(client.validate_host_public_key("h", "h", 22, k2))
        with self.assertRaises(inv.InventoryError):
            inv.connect_options(username="u", password="p", known_hosts=b"x", first_use=True)
        with self.assertRaises(inv.InventoryError):
            inv.connect_options(username="u", password="p", known_hosts=None)


@mock.patch.object(DeviceCredential, "resolve_secret", secrets)
class HostKeyApiTests(ApiBase):
    def setUp(self):
        self.a = self.host("a", "10.0.0.1", site=self.site, key=False)
        self.b = self.host("b", "10.0.0.2", site=self.branch)
        self.p = self.profile()
        self.p.sites.add(self.site, self.branch)
        self.new = SSHHostKey.objects.create(tenant=self.tenant, device=self.a,
                                             key_type="ssh-ed25519", public_key=KEY,
                                             fingerprint_sha256="SHA256:new", observed=True)
        self.changed = SSHHostKey.objects.create(
            tenant=self.tenant, device=self.b, key_type="ssh-ed25519", public_key=OTHER_KEY,
            fingerprint_sha256="SHA256:changed", observed=True)
        theirs = self.host("t", "10.0.0.9", tenant=self.other, key=False)
        self.theirs = SSHHostKey.objects.create(tenant=self.other, device=theirs,
                                                key_type="ssh-ed25519", public_key=KEY,
                                                fingerprint_sha256="SHA256:t", observed=True)

    def test_review_list_flags_mismatches(self):
        self.login(self.su)
        rows = self.client.get(f"/api/discovery/profiles/{self.p.pk}/host-keys/").json()
        by = {r["fingerprint"]: r for r in rows["results"]}
        self.assertEqual(set(by), {"SHA256:new", "SHA256:changed"})
        self.assertFalse(by["SHA256:new"]["mismatch"])
        self.assertTrue(by["SHA256:changed"]["mismatch"])
        self.assertFalse(by["SHA256:changed"]["can_accept"])
        self.assertEqual(by["SHA256:new"]["address"], "10.0.0.1")

    def test_bulk_accept_refuses_mismatches_and_other_tenants(self):
        self.login(self.su)
        r = self.client.post("/api/discovery/host-keys/accept/", {"ids": [
            str(self.new.pk), str(self.changed.pk), str(self.theirs.pk)]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["accepted"], [str(self.new.pk)])
        self.assertEqual([x["id"] for x in body["refused"]], [str(self.changed.pk)])
        self.assertEqual(body["not_found"], 1)
        self.new.refresh_from_db()
        self.changed.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertTrue(self.new.uploaded)
        self.assertFalse(self.changed.uploaded)
        self.assertFalse(self.theirs.uploaded)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="monitoring.sshhostkey", object_id=str(self.new.pk)).exists())

    def test_accept_needs_change_on_host_keys_in_scope(self):
        self.member("viewer", {"sshhostkey": ["view"], "inventoryprofile": ["view"],
                               "device": ["view"]})
        r = self.client.post("/api/discovery/host-keys/accept/",
                             {"ids": [str(self.new.pk)]}, format="json")
        self.assertEqual(r.status_code, 403)
        self.member("branch", {"sshhostkey": ["view", "change"]}, sites=[self.branch])
        r = self.client.post("/api/discovery/host-keys/accept/",
                             {"ids": [str(self.new.pk)]}, format="json")
        self.assertEqual(r.json()["not_found"], 1)
        self.new.refresh_from_db()
        self.assertFalse(self.new.uploaded)

    def test_review_needs_view_on_host_keys(self):
        self.member("prof", {"inventoryprofile": ["view"], "device": ["view"]})
        r = self.client.get(f"/api/discovery/profiles/{self.p.pk}/host-keys/")
        self.assertEqual(r.status_code, 403)

    def test_run_now_first_use_checks(self):
        url = f"/api/discovery/profiles/{self.p.pk}/run/"
        self.member("scanner", {"inventoryprofile": ["view", "scan"],
                                "devicecredential": ["view"]})
        r = self.client.post(url, {"accept_new_host_keys": True}, format="json")
        self.assertEqual(r.status_code, 403)
        self.login(self.su)
        with override_settings(DISCOVERY_ALLOW_FIRST_USE_KEYS=False):
            r = self.client.post(url, {"accept_new_host_keys": True}, format="json")
            self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.post(url, {"accept_new_host_keys": "yes"},
                                          format="json").status_code, 400)
        with mock.patch.object(runner, "enqueue"):
            r = self.client.post(url, {"accept_new_host_keys": True}, format="json")
        self.assertEqual(r.status_code, 202, r.content)
        self.assertTrue(r.json()["accept_new_host_keys"])
