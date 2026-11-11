"""Discovery on Outposts: capability negotiation, old-agent degradation, the
work channel (claim once, secrets only in the claim answer), ingest as
untrusted input, expiry, and the profile API's Runs on."""
from __future__ import annotations

import json
from datetime import timedelta
from unittest import mock

from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress
from danbyte_checks import inventory as inv
from danbyte_checks import service_scan as ss
from monitoring.engines import set_binding
from monitoring.models import DeviceCredential, MonitoringEngine, SSHHostKey

from . import outposts, runner
from .models import (
    DiscoverySettings,
    DiscoveryWorkItem,
    HostPackage,
    InventoryHostResult,
    InventoryRun,
    ObservedService,
)
from .tests_discovery import SECRET, ApiBase, Base, result

CAPS = {"discovery": {"kinds": ["inventory", "service_scan"], "nmap": None,
                      "nmap_reason": "Not found", "protocol": 1}}


def new_key() -> dict:
    import asyncssh

    k = asyncssh.generate_private_key("ssh-ed25519").convert_to_public()
    return inv._key_dict(k)


class OutpostBase(Base):
    def outpost(self, name="branch-op", *, tenant=None, caps=CAPS, seen=True, token=None,
                transport="pull", version="0.10.0"):
        return MonitoringEngine.objects.create(
            tenant=tenant or self.tenant, name=name, slug=name, kind="remote",
            transport=transport, token={"secret": token or f"tkn-{name}"},
            last_seen_at=timezone.now() if seen else None, agent_version=version,
            agent_capabilities=caps)

    def go(self, profile, user=None, **kw):
        with mock.patch.object(runner, "enqueue"):
            run = runner.start(profile, user=user or self.su, **kw)
        runner.execute(str(run.pk), collect=self.no_server, observe=self.no_server,
                       collect_winrm=self.no_server, scanner=self.no_scan)
        run.refresh_from_db()
        return run

    # A run on Outposts never reads a host from the server.
    async def no_server(self, *a, **kw):
        raise AssertionError("contacted from the server")

    def no_scan(self, *a, **kw):
        raise AssertionError("scanned from the server")


class AuthMixin:
    def auth(self, engine):
        return {"HTTP_AUTHORIZATION": f"Bearer {engine.token['secret']}"}

    def claim(self, engine):
        r = self.client.get("/api/outpost/discovery-work/", **self.auth(engine))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r["Cache-Control"], "no-store")
        return r.json()["jobs"]

    def post(self, engine, results):
        return self.client.post("/api/outpost/discovery-results/", {"results": results},
                                format="json", **self.auth(engine))


@override_settings(DISCOVERY_ENABLED=True)
class CapabilityTests(AuthMixin, APITestCase, OutpostBase):
    def test_hello_records_capabilities_and_an_old_agent_has_none(self):
        eng = self.outpost(caps={})
        r = self.client.post("/api/outpost/hello/", {"version": "0.9.0"}, format="json",
                             **self.auth(eng))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["discovery"])
        eng.refresh_from_db()
        self.assertEqual(eng.agent_capabilities, {})
        self.client.post("/api/outpost/hello/", {"version": "0.10.0", "capabilities": {
            "discovery": {"kinds": ["inventory", "service_scan", "rm -rf"],
                          "nmap": {"version": "7.95"}, "protocol": 1},
            "junk": "x" * 10000}}, format="json", **self.auth(eng))
        eng.refresh_from_db()
        self.assertEqual(eng.agent_capabilities["discovery"]["kinds"],
                         ["inventory", "service_scan"])
        self.assertEqual(eng.agent_capabilities["discovery"]["nmap"], {"version": "7.95"})
        self.assertNotIn("junk", eng.agent_capabilities)
        for bad in ("x", ["inventory"], {"discovery": "all"},
                    {"discovery": {"nmap": {"version": "7.95; rm"}}}):
            self.assertIn(outposts.clean_capabilities(bad).get("discovery", {}).get("nmap"),
                          (None,), bad)

    def test_work_says_when_discovery_waits(self):
        eng = self.outpost()
        self.assertFalse(self.client.get("/api/outpost/work/", **self.auth(eng)).json()[
            "discovery_pending"])
        a = self.host("a", "10.0.0.1", site=self.site)
        p = self.profile(runs_on="outpost", outpost=eng)
        p.sites.add(self.site)
        with mock.patch.object(DeviceCredential, "resolve_secret",
                               lambda s: {"password": SECRET}):
            self.go(p)
        self.assertTrue(DiscoveryWorkItem.objects.filter(device=a).exists())
        self.assertTrue(self.client.get("/api/outpost/work/", **self.auth(eng)).json()[
            "discovery_pending"])


@override_settings(DISCOVERY_ENABLED=True)
@mock.patch.object(DeviceCredential, "resolve_secret", lambda self: {"password": SECRET})
class DegradationTests(AuthMixin, APITestCase, OutpostBase):
    def setUp(self):
        self.a = self.host("a", "10.0.0.1", site=self.site)
        self.b = self.host("b", "10.0.0.2", site=self.site, vm=True)

    def test_an_old_agent_is_handed_nothing_and_the_run_says_why(self):
        eng = self.outpost(caps={}, version="0.9.0")
        p = self.profile(runs_on="outpost", outpost=eng)
        p.sites.add(self.site)
        run = self.go(p)
        self.assertEqual(run.status, "skipped")
        self.assertFalse(DiscoveryWorkItem.objects.exists())
        rows = InventoryHostResult.objects.filter(run=run)
        self.assertEqual({r.status for r in rows}, {"outpost_unsupported"})
        self.assertIn("0.9.0", rows[0].message)
        self.assertIn(outposts.AGENT_VERSION, rows[0].message)
        self.assertEqual({r.engine for r in rows}, {"outpost: branch-op"})
        self.assertTrue(any(outposts.AGENT_VERSION in e for e in run.errors))
        self.assertEqual(self.claim(eng), [])

    def test_offline_disabled_and_ssh_driven_outposts(self):
        cases = [(self.outpost("off", seen=False), "outpost_offline", "offline"),
                 (self.outpost("ssh", transport="ssh"), "outpost_unsupported", "SSH")]
        dis = self.outpost("dis")
        dis.enabled = False
        dis.save()
        cases.append((dis, "outpost_offline", "disabled"))
        for i, (eng, status, word) in enumerate(cases):
            p = self.profile(name=f"p{i}", runs_on="outpost", outpost=eng)
            p.devices.add(self.a)
            run = self.go(p)
            self.assertEqual(run.status, "skipped", eng.name)
            row = InventoryHostResult.objects.get(run=run)
            self.assertEqual(row.status, status)
            self.assertIn(word, row.message)
        self.assertFalse(DiscoveryWorkItem.objects.exists())

    def test_a_scan_without_the_kind_or_without_nmap(self):
        only_inv = self.outpost("inv", caps={"discovery": {"kinds": ["inventory"]}})
        p = self.profile(name="s", kind="service_scan", runs_on="outpost", outpost=only_inv)
        p.devices.add(self.a)
        self.assertEqual(self.go(p).status, "skipped")
        eng = self.outpost("nonmap")
        DiscoverySettings.objects.update_or_create(tenant=self.tenant,
                                                   defaults={"nmap_enabled": True})
        p2 = self.profile(name="n", kind="service_scan", runs_on="outpost", outpost=eng,
                          scan_engine="nmap")
        p2.devices.add(self.a)
        run = self.go(p2)
        self.assertEqual(run.status, "skipped")
        self.assertIn("no nmap", InventoryHostResult.objects.get(run=run).message)

    def test_the_hosts_outpost_never_falls_back_to_the_server(self):
        eng = self.outpost()
        set_binding(self.tenant, "device", self.a.pk, eng)
        p = self.profile(runs_on="host")
        p.sites.add(self.site)
        run = self.go(p)
        self.assertEqual(run.status, "running")
        self.assertEqual(list(DiscoveryWorkItem.objects.values_list("device", flat=True)),
                         [self.a.pk])
        vm_row = InventoryHostResult.objects.get(run=run, virtual_machine=self.b)
        self.assertEqual(vm_row.status, "no_outpost")
        self.assertIn("server", vm_row.message)

    def test_run_now_is_refused_without_the_outpost(self):
        p = self.profile(runs_on="outpost")
        with self.assertRaises(runner.RunRefused):
            runner.start(p, user=self.su)


@override_settings(DISCOVERY_ENABLED=True)
@mock.patch.object(DeviceCredential, "resolve_secret", lambda self: {"password": SECRET})
class InventoryChannelTests(AuthMixin, APITestCase, OutpostBase):
    def setUp(self):
        self.eng = self.outpost()
        self.a = self.host("a", "10.0.0.1", site=self.site)
        self.p = self.profile(runs_on="outpost", outpost=self.eng)
        self.p.devices.add(self.a)

    def answer(self, job_item, r=None, **extra):
        return {"item_id": job_item["item_id"],
                "result": inv.result_as_dict(r or result()), "used": 0,
                "attempts": [{"transport": "ssh_password", "outcome": "ok", "reason": ""}],
                **extra}

    def test_claim_once_secret_only_in_the_answer_then_ingest(self):
        with self.assertLogs("discovery", level="DEBUG") as logs:
            runner.log.debug("start")
            run = self.go(self.p)
            self.assertEqual(run.status, "running")
            item = DiscoveryWorkItem.objects.get()
            self.assertNotIn(SECRET, json.dumps(item.payload))
            jobs = self.claim(self.eng)
            self.assertEqual(len(jobs), 1)
            job = jobs[0]
            self.assertEqual(job["kind"], "inventory")
            one = job["items"][0]
            self.assertEqual(one["address"], "10.0.0.1")
            self.assertIn("ssh-ed25519", one["known_hosts"])
            self.assertEqual(one["logins"][0]["credential"]["password"], SECRET)
            self.assertEqual(one["logins"][0]["transport"], "ssh_password")
            # Claimed once: a second fetch hands nothing out.
            self.assertEqual(self.claim(self.eng), [])
            r = self.post(self.eng, [self.answer(one)])
            self.assertEqual(r.json(), {"accepted": 1, "refused": 0})
        run.refresh_from_db()
        self.assertEqual(run.status, "ok")
        self.assertEqual(run.counts["ok"], 1)
        self.assertEqual(HostPackage.objects.filter(device=self.a).count(), 88)
        row = InventoryHostResult.objects.get(run=run)
        self.assertEqual((row.status, row.engine, row.transport),
                         ("ok", "outpost: branch-op", "ssh_password"))
        blob = json.dumps({"c": run.counts, "e": run.errors, "p": list(
            DiscoveryWorkItem.objects.values_list("payload", flat=True))}) + json.dumps(
            list(InventoryHostResult.objects.values("message", "attempts")))
        self.assertNotIn(SECRET, blob)
        self.assertNotIn(SECRET, "\n".join(logs.output))
        # Reported once: the same answer again is refused.
        self.assertEqual(self.post(self.eng, [self.answer(one)]).json()["refused"], 1)

    def test_foreign_engine_tenant_and_unknown_items_are_refused(self):
        self.go(self.p)
        one = self.claim(self.eng)[0]["items"][0]
        mine2 = self.outpost("other-op")
        theirs = self.outpost("theirs", tenant=self.other)
        for eng in (mine2, theirs):
            r = self.post(eng, [self.answer(one)])
            self.assertEqual(r.json(), {"accepted": 0, "refused": 1})
        self.assertEqual(self.post(self.eng, [{"item_id": "nope"}, {
            "item_id": "00000000-0000-0000-0000-000000000000"}]).json()["refused"], 2)
        self.assertFalse(HostPackage.objects.exists())
        self.assertEqual(DiscoveryWorkItem.objects.get().status, "claimed")

    def test_malformed_and_oversized_results_fail_the_host(self):
        cases = []
        bad_name = inv.result_as_dict(result())
        bad_name["packages"][0][1] = "evil;rm -rf /"
        cases.append(bad_name)
        too_many = inv.result_as_dict(result())
        too_many["packages"] = [["deb", f"p{i}", "1.0", "amd64", "", "", ""]
                                for i in range(inv.MAX_PACKAGES + 1)]
        cases.append(too_many)
        wrong_type = inv.result_as_dict(result())
        wrong_type["packages"][0][0] = "rpm"
        cases.append(wrong_type)
        cases.append({"status": "pwned"})
        cases.append("not an object")
        for i, raw in enumerate(cases):
            DiscoveryWorkItem.objects.all().delete()
            InventoryRun.objects.all().delete()
            self.go(self.p)
            one = self.claim(self.eng)[0]["items"][0]
            r = self.post(self.eng, [{"item_id": one["item_id"], "result": raw}])
            self.assertEqual(r.json(), {"accepted": 0, "refused": 1}, i)
            row = InventoryHostResult.objects.get()
            self.assertEqual(row.status, "failed", i)
            self.assertIn("refused", row.message)
            self.assertFalse(HostPackage.objects.exists(), i)
        self.assertEqual(self.post(self.eng, "x").status_code, 400)
        many = [{"item_id": "x"}] * (outposts.RESULTS_MAX + 1)
        self.assertEqual(self.post(self.eng, many).status_code, 400)

    def test_a_posted_key_is_taken_only_on_first_use(self):
        SSHHostKey.objects.filter(device=self.a).delete()
        key = new_key()
        # Without first use the host has no key: only an observe item.
        self.go(self.p)
        one = self.claim(self.eng)[0]["items"][0]
        self.assertEqual(one["mode"], "observe")
        self.assertNotIn("logins", one)
        self.post(self.eng, [{"item_id": one["item_id"],
                              "observed": {**key, "fingerprint": "SHA256:forged"}}])
        row = SSHHostKey.objects.get(device=self.a)
        self.assertFalse(row.uploaded)
        self.assertEqual(row.fingerprint_sha256, key["fingerprint"])  # computed, not posted
        SSHHostKey.objects.all().delete()
        InventoryRun.objects.all().delete()
        self.go(self.p, accept_new_host_keys=True)
        one = self.claim(self.eng)[0]["items"][0]
        self.assertTrue(one["first_use"])
        self.assertIsNone(one["known_hosts"])
        r = result()
        r.host_key = key
        self.post(self.eng, [self.answer(one, r)])
        self.assertTrue(SSHHostKey.objects.get(device=self.a, uploaded=True))
        self.assertTrue(InventoryHostResult.objects.get(status="ok").key_first_use)

    def test_a_credential_gone_before_the_claim_sends_nothing(self):
        self.go(self.p)
        DeviceCredential.objects.filter(device=self.a).delete()
        job = self.claim(self.eng)[0]
        self.assertEqual(job["items"], [])
        self.assertEqual(InventoryHostResult.objects.get().status, "no_credential")
        self.assertEqual(InventoryRun.objects.get().status, "nothing_read")

    def test_rules_are_server_side_and_the_server_policy_is_not(self):
        self.a.scan_exempt = True
        self.a.save()
        b = self.host("b", "10.0.0.2")
        self.p.devices.add(b)
        with mock.patch("danbyte_checks.netguard.target_blocked", return_value=True):
            run = self.go(self.p)
        self.assertEqual(list(DiscoveryWorkItem.objects.values_list("device", flat=True)),
                         [b.pk])
        self.assertEqual(InventoryHostResult.objects.get(run=run, device=self.a).status,
                         "exempt")

    def test_winrm_is_never_sent_to_an_outpost(self):
        DiscoverySettings.objects.update_or_create(tenant=self.tenant,
                                                   defaults={"winrm_enabled": True})
        DeviceCredential.objects.filter(device=self.a).update(kind="winrm_cert")
        with mock.patch("discovery.gate.winrm_state", return_value=(True, "", "")):
            run = self.go(self.p)
        # Only the key it presents is read (no login); WinRM is never offered.
        item = DiscoveryWorkItem.objects.get(run=run)
        self.assertEqual((item.payload["mode"], item.payload["skip"]),
                         ("observe", "no_credential"))
        self.assertNotIn("logins", item.payload)
        self.assertTrue(any(a["reason"] == "Outposts read over SSH only"
                            for a in item.payload["skipped"]))
        one = self.claim(self.eng)[0]["items"][0]
        self.assertEqual(one["mode"], "observe")
        self.post(self.eng, [{"item_id": one["item_id"], "observed": None}])
        row = InventoryHostResult.objects.get(run=run)
        self.assertEqual(row.status, "no_credential")

    def test_expiry(self):
        self.go(self.p)
        DiscoveryWorkItem.objects.update(deadline=timezone.now() - timedelta(seconds=1))
        self.assertEqual(outposts.expire(), 1)
        self.assertEqual(InventoryHostResult.objects.get().status, "outpost_offline")
        self.assertEqual(InventoryRun.objects.get().status, "skipped")
        InventoryRun.objects.all().delete()
        self.go(self.p)
        self.claim(self.eng)
        DiscoveryWorkItem.objects.update(deadline=timezone.now() - timedelta(seconds=1))
        outposts.expire()
        self.assertEqual(InventoryHostResult.objects.get().status, "timeout")
        self.assertEqual(InventoryRun.objects.get().status, "failed")

    def test_a_profile_switched_off_mid_run_hands_nothing_out(self):
        self.go(self.p)
        self.p.enabled = False
        self.p.save()
        self.assertEqual(self.claim(self.eng), [])
        self.assertEqual(InventoryHostResult.objects.get().status, "failed")
        self.assertFalse(DiscoveryWorkItem.objects.filter(status="pending").exists())


@override_settings(DISCOVERY_ENABLED=True)
class ScanChannelTests(AuthMixin, APITestCase, OutpostBase):
    def setUp(self):
        self.eng = self.outpost()
        self.a = self.host("a", "10.0.0.1", site=self.site, cred=None, key=False)
        self.loose = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.9",
                                              prefix=self.prefix)
        self.p = self.profile(name="scan", kind="service_scan", runs_on="outpost",
                              outpost=self.eng, ports=[22, 80])
        self.p.prefixes.set([self.prefix])

    def test_roundtrip_and_validation(self):
        run = self.go(self.p)
        job = self.claim(self.eng)[0]
        self.assertEqual(job["ports"], [22, 80])
        self.assertEqual(job["engine"], "builtin")
        by_addr = {i["address"]: i["item_id"] for i in job["items"]}
        self.assertEqual(set(by_addr), {"10.0.0.1", "10.0.0.9"})
        good = ss.HostResult("10.0.0.1", open=[ss.PortResult(
            port=80, service="http", product="nginx", source="danbyte", confidence="high",
            cpe="cpe:2.3:a:f5:nginx:1.24.0:*:*:*:*:*:*:*")], connects=2)
        sneaky = ss.HostResult("10.0.0.9", open=[ss.PortResult(port=3306)], connects=2)
        r = self.post(self.eng, [
            {"item_id": by_addr["10.0.0.1"], "result": ss.host_result_as_dict(good)},
            {"item_id": by_addr["10.0.0.9"], "result": ss.host_result_as_dict(sneaky)}])
        self.assertEqual(r.json(), {"accepted": 1, "refused": 1})
        run.refresh_from_db()
        self.assertEqual(run.status, "partial")
        obs = ObservedService.objects.get()
        self.assertEqual((obs.address, obs.port, obs.product), ("10.0.0.1", 80, "nginx"))
        rows = {h.address: h for h in InventoryHostResult.objects.filter(run=run)}
        self.assertEqual(rows["10.0.0.1"].engine, "outpost: branch-op")
        self.assertEqual(rows["10.0.0.9"].status, "failed")
        self.assertIn("not asked for", rows["10.0.0.9"].message)

    def test_another_address_is_refused(self):
        self.go(self.p)
        job = self.claim(self.eng)[0]
        item = job["items"][0]
        other = ss.HostResult("192.0.2.7", open=[ss.PortResult(port=22)])
        self.post(self.eng, [{"item_id": item["item_id"],
                              "result": ss.host_result_as_dict(other)}])
        self.assertFalse(ObservedService.objects.exists())

    def test_changed_ports_stop_the_rest(self):
        self.go(self.p)
        self.p.ports = [22, 80, 443]
        self.p.save()
        self.assertEqual(self.claim(self.eng), [])
        self.assertIn("ports changed", InventoryHostResult.objects.first().message)


class WireTests(Base):
    def test_inventory_roundtrip(self):
        r = result()
        back = inv.result_from_dict(json.loads(json.dumps(inv.result_as_dict(r))))
        self.assertEqual(back.packages, r.packages)
        self.assertEqual(back.os["id"], "debian")

    def test_host_key_fingerprint_is_computed(self):
        key = new_key()
        self.assertEqual(inv.verify_host_key({**key, "fingerprint": "x"}), key)
        for bad in ({"key_type": "ssh-rsa", "public_key": key["public_key"]},
                    {"key_type": "ssh-ed25519", "public_key": "!!"}, "x"):
            with self.assertRaises(inv.WireError):
                inv.verify_host_key(bad)

    def test_scan_caps(self):
        raw = ss.host_result_as_dict(ss.HostResult("10.0.0.1", open=[ss.PortResult(
            port=22, banner="x" * 5000 + "\x1b[2J")]))
        back = ss.host_result_from_dict(raw, address="10.0.0.1", ports=[22])
        self.assertLessEqual(len(back.open[0].banner), ss.BANNER_KEEP)
        self.assertNotIn("\x1b", back.open[0].banner)
        raw["open"] = raw["open"] * 2
        with self.assertRaises(ss.WireError):
            ss.host_result_from_dict(raw, address="10.0.0.1", ports=[22, 80])


@override_settings(DISCOVERY_ENABLED=True)
class ProfileApiTests(ApiBase, OutpostBase):
    def setUp(self):
        self.eng = self.outpost()
        self.login(self.su)

    def test_runs_on_validation(self):
        theirs = self.outpost("theirs", tenant=self.other)
        local = MonitoringEngine.local_for(self.tenant)
        url = "/api/discovery/profiles/"
        base = {"name": "x", "authorisation": "ok"}
        r = self.client.post(url, {**base, "runs_on": "outpost"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("outpost_id", r.json())
        for bad in (theirs, local):
            r = self.client.post(url, {**base, "runs_on": "outpost", "outpost_id": str(bad.pk)},
                                 format="json")
            self.assertEqual(r.status_code, 400, bad.name)
        r = self.client.post(url, {**base, "runs_on": "outpost", "outpost_id": str(self.eng.pk)},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["outpost"]["name"], "branch-op")
        self.assertTrue(body["outpost"]["can"]["inventory"]["ok"])
        self.assertTrue(body["authorised"])
        # Moving it is a new authorisation.
        r = self.client.patch(f"{url}{body['id']}/", {"runs_on": "server"}, format="json")
        self.assertEqual(r.json()["outpost"], None)
        self.assertFalse(r.json()["authorised"])

    def test_outpost_list(self):
        self.outpost("old", caps={}, version="0.9.0")
        self.outpost("theirs", tenant=self.other)
        rows = {o["name"]: o for o in self.client.get("/api/discovery/outposts/").json()[
            "results"]}
        self.assertEqual(set(rows), {"branch-op", "old"})
        self.assertFalse(rows["old"]["can"]["inventory"]["ok"])
        self.assertIn("0.10.0", rows["old"]["can"]["inventory"]["reason"])
        self.assertFalse(rows["branch-op"]["can"]["nmap"]["ok"])
        self.assertNotIn("token", json.dumps(rows))
        user = self.member("viewer", {"device": ["view"]})
        self.assertEqual(self.client.get("/api/discovery/outposts/").status_code, 403)
        del user
