"""The registration guidance and who a policy hits: the reason sentences the
planning pass gives (with the code and the link target the SPA needs), and
``policies/<id>/matches/`` with ``match_count`` - the planning pass's own
matching, tenant-scoped, filtered and paged."""
from __future__ import annotations

from unittest import mock

from api.models import Cluster, ClusterType, Device, Status, VirtualMachine
from integrations.models import IntegrationSettings
from prtg.models import PrtgDeviceLink, PrtgPolicy
from prtg.provision import TEXT, decide, preview

from .test_registration import LINUX, SERVERS, _Api, _Plan, policy, profile


class ReasonTextTests(_Plan):
    def test_every_sentence_is_plain(self):
        for code, text in TEXT.items():
            with self.subTest(code=code):
                self.assertNotRegex(text, r"[():;]")
                self.assertTrue(text.endswith("."))

    def test_nothing_registers_it(self):
        d = self.device("edge", "10.0.0.90")
        want = decide(self.conn, d, self.ctx(), linked=False)
        self.assertEqual(want.reason, (
            "Nothing registers this object. Add a policy that matches it, set Monitor "
            "in PRTG on the object, or turn on Register all."
        ))
        self.assertEqual(want.reason_issue, {"code": "no_match", "text": want.reason})

    def test_left_out_reasons(self):
        d = self.device("edge", "10.0.0.90")
        policy(self.conn, "all", self.ping)
        d.status = Status.objects.create(tenant=self.tenant, name="Retired", slug="retired")
        d.save()
        want = decide(self.conn, d, self.ctx(), linked=False)
        self.assertEqual(want.reason, "Its status Retired is left out of PRTG. Set Monitor "
                                      "in PRTG on the object to keep it.")
        d.prtg_sync = "never"
        d.save()
        want = decide(self.conn, d, self.ctx(), linked=False)
        self.assertEqual(want.reason_issue["code"], "excluded")

    def test_already_linked_with_register_all(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.conn.register_all = True
        self.conn.save()
        want = decide(self.conn, d, self.ctx(), linked=True)
        self.assertEqual(want.reason, TEXT["already_linked"])

    def test_no_group_names_where_to_set_one(self):
        d = self.device("edge", "10.0.0.90")
        d.prtg_sync = "always"
        d.save()
        self.conn.register_profile = self.ping
        self.conn.save()
        [entry] = [preview(self.conn, d)]
        [found] = [i for i in entry["issues"] if i["code"] == "no_group"]
        self.assertEqual(found["text"], (
            "No PRTG group chosen. Set one on the matching policy or under Register all "
            "on the connection."
        ))
        self.assertNotIn("policy", found)  # nothing matched: the connection only

    def test_a_gone_group_points_at_the_policy(self):
        d = self.device("edge", "10.0.0.90")
        p = policy(self.conn, "old", self.ping, group="999")
        self.conn.groups_cache = [{"objid": LINUX, "path": "Linux", "kind": "group"}]
        self.conn.save()
        entry = preview(self.conn, d)
        [found] = [i for i in entry["issues"] if i["code"] == "group_gone"]
        self.assertEqual(found["policy"], str(p.id))
        self.assertTrue(found["text"].startswith("The PRTG group old is gone."))

    def test_vm_snmp_points_at_its_snmp_tab(self):
        from monitoring.models import SnmpProfile

        SnmpProfile.objects.all().delete()
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="app", cluster=cluster)
        policy(self.conn, "snmp", profile(self.conn, "S", ("snmp_uptime", {}, True)))
        entry = preview(self.conn, vm)
        [found] = [i for i in entry["issues"] if i["code"] == "no_snmp"]
        self.assertEqual(found["text"], "No SNMP profile applies to VM app. Set one on its "
                                        "SNMP tab.")
        self.assertEqual(found["object"], {"kind": "virtual_machine", "id": str(vm.id)})


class MatchesApiTests(_Api):
    def setUp(self):
        super().setUp()
        self.a = Device.objects.create(tenant=self.tenant, name="alpha", site=self.site)
        self.b = Device.objects.create(tenant=self.tenant, name="beta", site=self.site,
                                       prtg_sync="never")
        self.c = Device.objects.create(tenant=self.tenant, name="gamma")
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct,
                                         site=self.site)
        self.vm = VirtualMachine.objects.create(tenant=self.tenant, name="app",
                                                cluster=cluster)
        self.foreign_device = Device.objects.create(tenant=self.other, name="alpha",
                                                    site=self.foreign_site)
        PrtgDeviceLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=self.a, objid="2080",
            name="alpha", matched_by="address",
        )
        self.site_policy = PrtgPolicy.objects.get(
            pk=self.post_policy(name="site", scope="site", target_site=str(self.site.id),
                                priority=10).json()["id"]
        )

    def matches(self, policy, query=""):
        r = self.client.get(f"/api/prtg/policies/{policy.id}/matches/{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_the_site_scope_matches_devices_and_vms(self):
        out = self.matches(self.site_policy)
        self.assertEqual(out["count"], 3)
        rows = {r["name"]: r for r in out["results"]}
        self.assertEqual(set(rows), {"alpha", "beta", "app"})  # gamma has no site
        self.assertEqual(rows["app"]["kind"], "virtual_machine")
        self.assertEqual(rows["app"]["site"]["name"], "S")  # its cluster's
        self.assertTrue(rows["alpha"]["linked"])
        self.assertEqual(rows["alpha"]["link"]["objid"], "2080")
        self.assertEqual(rows["beta"]["prtg_sync"], "never")
        self.assertFalse(rows["beta"]["managed"])
        self.assertTrue(rows["app"]["managed"])
        self.assertTrue(rows["app"]["wins_group"])

    def test_the_planning_pass_matching_is_reused(self):
        with mock.patch("prtg.provision.policy_matches", return_value=False) as spy:
            out = self.matches(self.site_policy)
        self.assertEqual(out["count"], 0)
        self.assertTrue(spy.called)

    def test_the_lower_priority_policy_wins_the_group(self):
        wide = PrtgPolicy.objects.get(
            pk=self.post_policy(name="wide", priority=1, group_id=SERVERS).json()["id"]
        )
        rows = {r["name"]: r for r in self.matches(self.site_policy)["results"]}
        self.assertEqual(rows["app"]["group_policy"], {"id": str(wide.id), "name": "wide"})
        self.assertFalse(rows["app"]["wins_group"])
        self.assertEqual({p["name"] for p in rows["app"]["policies"]}, {"wide", "site"})
        self.assertEqual(self.matches(wide)["count"], 4)  # gamma too

    def test_filters(self):
        out = self.matches(self.site_policy, "?prtg_sync=never")
        self.assertEqual([r["name"] for r in out["results"]], ["beta"])
        out = self.matches(self.site_policy, "?linked=1")
        self.assertEqual([r["name"] for r in out["results"]], ["alpha"])
        out = self.matches(self.site_policy, "?linked=0&prtg_sync=inherit")
        self.assertEqual([r["name"] for r in out["results"]], ["app"])

    def test_paging(self):
        out = self.matches(self.site_policy, "?page_size=2")
        self.assertEqual(out["count"], 3)
        self.assertEqual([r["name"] for r in out["results"]], ["alpha", "app"])
        self.assertTrue(out["next"])
        out = self.matches(self.site_policy, "?page_size=2&page=2")
        self.assertEqual([r["name"] for r in out["results"]], ["beta"])

    def test_match_count_on_the_policy(self):
        r = self.client.get(f"/api/prtg/policies/{self.site_policy.id}/")
        self.assertEqual(r.json()["match_count"], 3)
        self.site_policy.enabled = False
        self.site_policy.save()
        # A disabled policy still says who it would hit.
        r = self.client.get(f"/api/prtg/policies/{self.site_policy.id}/")
        self.assertEqual(r.json()["match_count"], 3)

    def test_tenant_isolation(self):
        names = [r["name"] for r in self.matches(self.site_policy)["results"]]
        self.assertEqual(names.count("alpha"), 1)
        foreign = PrtgPolicy.objects.create(
            tenant=self.other, connection=self.foreign, name="f", profile=self.foreign_prof,
            group_id="1",
        )
        r = self.client.get(f"/api/prtg/policies/{foreign.id}/matches/")
        self.assertEqual(r.status_code, 404)
        r = self.client.get(f"/api/prtg/policies/{foreign.id}/")
        self.assertEqual(r.status_code, 404)

    def test_off_integration_is_404(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=False)
        r = self.client.get(f"/api/prtg/policies/{self.site_policy.id}/matches/")
        self.assertEqual(r.status_code, 404)
