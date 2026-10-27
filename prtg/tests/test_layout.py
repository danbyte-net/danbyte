"""Group layouts and credential placement: the chain of region, site,
location and role groups, matching PRTG's groups by tag then name, the
create/rename/remove group rows and their order, a policy's group against
the layout, and where a profile puts the credentials its sensors need -
against the fake PRTG, whose group routes follow what PRTG 26.3.124 answered
in the lab (``fixtures/v2_group_lifecycle.json``).
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import DeviceRole, Location, Region, Site
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings
from prtg import writer
from prtg.client_v2 import id_from_location
from prtg.credentials import credential_values, effective
from prtg.layout import Groups, Node, Tree, chain, node_key, resolve
from prtg.models import (
    PrtgChange,
    PrtgConnection,
    PrtgCredential,
    PrtgGroupLink,
    PrtgSensorDefinition,
    PrtgSensorProfile,
)

from .fake_server import group_row, load_fixture
from .test_registration import LOCAL_PROBE, _Plan, policy, profile

NO_GAP = mock.patch("prtg.client_v2.WRITE_GAP", 0)
PROXMOX = "paessler-proxmox-credentials_section"
PVE_KIND = "paessler.proxmox.node_performance_sensor"


def _fast(conn):
    from prtg.client_v2 import PrtgV2Client

    return PrtgV2Client(conn.v2_base, conn.api_key, verify_tls=conn.verify_tls,
                        write_gap=0, poll_seconds=0, parent_wait_seconds=2)


class RecordedLifecycleTests(_Plan):
    def test_what_prtg_26_3_answered(self):
        rec = load_fixture("v2_group_lifecycle.json")
        self.assertEqual(rec["create_group_probe"]["status"], 201)
        self.assertEqual(rec["create_group_probe"]["body"], "")
        self.assertTrue(id_from_location(rec["create_group_probe"]["location"]))
        self.assertEqual(rec["create_group_group"]["status"], 201)
        self.assertEqual(rec["rename_group"]["status"], 204)
        self.assertEqual(rec["move_group"]["status"], 204)
        for section in ("windowsconnection", "linuxconnection", "vmwareconnection",
                        PROXMOX, "paessler-vmware-vmware_credentials_section"):
            self.assertEqual(rec[f"patch_{section}"]["status"], 204)
        self.assertEqual(rec["delete_again_" + rec["create_group_probe"]["location"]
                             .rsplit("/", 1)[1]]["status"], 404)
        # A new group is a parent only after a few seconds.
        self.assertTrue(all(w > 1 for w in rec["waits"]))

    def test_inheritance_as_recorded(self):
        import json

        rec = load_fixture("v2_group_lifecycle.json")
        child = json.loads(rec["read_child_creds"]["body"])
        state = effective(child, [PROXMOX, "windowsconnection"], child["name"])
        self.assertEqual(state[PROXMOX], {"set": True, "inherited": True,
                                          "source": "Danbyte test parent"})
        parent = json.loads(rec["read_parent_creds"]["body"])
        own = effective(parent, ["windowsconnection"], parent["name"])
        self.assertEqual(own["windowsconnection"]["source"], "Danbyte test parent")
        self.assertFalse(own["windowsconnection"]["inherited"])

    def test_recording_holds_no_secrets(self):
        text = load_fixture("v2_group_lifecycle.json", raw=True)
        self.assertNotIn("throwaway-pass", text)
        self.assertNotIn("00000000-throwaway", text)


class _Layout(_Plan):
    def setUp(self):
        super().setUp()
        self.eu = Region.objects.create(tenant=self.tenant, name="Europe", slug="eu")
        self.dk = Region.objects.create(tenant=self.tenant, name="Denmark", slug="dk",
                                        parent=self.eu)
        self.site.region = self.dk
        self.site.name = "København HQ"
        self.site.save()
        self.floor = Location.objects.create(tenant=self.tenant, site=self.site,
                                             name="Floor 1", slug="f1")
        self.room = Location.objects.create(tenant=self.tenant, site=self.site,
                                            name="Server room", slug="sr", parent=self.floor)
        self.core = DeviceRole.objects.create(tenant=self.tenant, name="Core switches",
                                              slug="core")
        self.conn.register_group_id = LOCAL_PROBE
        self.conn.register_group_path = "Local Probe"
        self.conn.register_profile = self.ping
        self.conn.register_all = True
        self.conn.group_layout = PrtgConnection.LAYOUT_SITES_ROLES
        self.conn.write_mode = PrtgConnection.WRITE_V2
        self.conn.write_checked_at = timezone.now()
        self.conn.v2_available = True
        self.conn.save()

    def sw(self, name="sw-core-1", addr="10.0.0.91"):
        d = self.device(name, addr)
        d.location = self.room
        d.role = self.core
        d.save()
        return d

    def names(self, kind):
        return [c.detail["name"] for c in sorted(
            self.changes(kind), key=lambda c: c.detail["depth"])]


class ChainTests(_Layout):
    def test_the_four_layouts(self):
        d = self.sw()
        tree = Tree(self.tenant)

        def names(**kw):
            return [n.name for n in chain(self.conn, d, tree, **kw)]

        self.assertEqual(names(layout="none"), [])
        self.assertEqual(names(layout="sites"),
                         ["Europe", "Denmark", "København HQ", "Floor 1", "Server room"])
        self.assertEqual(names(layout="roles"), ["Core switches"])
        self.assertEqual(names(layout="sites_roles"), [
            "Europe", "Denmark", "København HQ", "Floor 1", "Server room", "Core switches"])
        self.assertEqual(names(layout="sites", regions=False, locations=False),
                         ["København HQ"])

    def test_missing_links_are_left_out(self):
        d = self.device("loose", "10.0.0.92")
        d.site = None
        d.save()
        tree = Tree(self.tenant)
        self.assertEqual(chain(self.conn, d, tree, layout="sites_roles"), [])

    def test_match_by_tag_before_name(self):
        node = Node("role", str(self.core.id), "Core switches")
        groups = Groups([
            {"objid": "70", "name": "Core switches", "kind": "group", "parent_id": "1",
             "tags": []},
            {"objid": "71", "name": "Old name", "kind": "group", "parent_id": "1",
             "tags": ["danbyte", node.tag]},
        ])
        steps = resolve({"objid": "1", "path": "Local Probe"}, [node], groups)
        self.assertEqual((steps[0].objid, steps[0].matched_by), ("71", "tag"))
        groups = Groups([{"objid": "70", "name": "Core switches", "kind": "group",
                          "parent_id": "1", "tags": []}])
        steps = resolve({"objid": "1", "path": "Local Probe"}, [node], groups)
        self.assertEqual((steps[0].objid, steps[0].matched_by), ("70", "name"))
        # The same role under another parent is another group.
        self.assertNotEqual(node_key("1", [node]), node_key("2", [node]))


class PlanTests(_Layout):
    def test_groups_are_proposed_top_down_before_the_device(self):
        self.sw()
        self.plan()
        self.assertEqual(self.names(PrtgChange.CREATE_GROUP), [
            "Europe", "Denmark", "København HQ", "Floor 1", "Server room", "Core switches"])
        create = self.changes(PrtgChange.CREATE_DEVICE)[0]
        group = create.detail["group"]
        self.assertEqual(group["objid"], "")
        self.assertEqual(group["source"], "layout")
        self.assertTrue(create.detail["applicable"])
        self.assertEqual(group["path"], "Local Probe / Europe / Denmark / København HQ / "
                                        "Floor 1 / Server room / Core switches")
        europe = next(c for c in self.changes(PrtgChange.CREATE_GROUP)
                      if c.detail["name"] == "Europe")
        self.assertEqual(europe.detail["parent"]["objid"], LOCAL_PROBE)
        self.assertEqual(europe.detail["tags"], ["danbyte", f"danbyte-group-region-{self.eu.id}"])

    def test_two_devices_share_their_groups(self):
        self.sw("sw-core-1", "10.0.0.91")
        self.sw("sw-core-2", "10.0.0.93")
        self.plan()
        self.assertEqual(len(self.changes(PrtgChange.CREATE_GROUP)), 6)
        self.assertEqual(len(self.changes(PrtgChange.CREATE_DEVICE)), 2)

    def test_an_operator_group_is_reused_by_name(self):
        self.conn.group_layout = PrtgConnection.LAYOUT_ROLES
        self.conn.save()
        self.fake.tables["groups"].append(group_row(700, "Core switches", parent=1))
        self.sw()
        self.plan()
        self.assertEqual(self.changes(PrtgChange.CREATE_GROUP), [])
        self.assertEqual(self.changes(PrtgChange.CREATE_DEVICE)[0].detail["group"]["objid"],
                         "700")
        link = PrtgGroupLink.objects.get(connection=self.conn, objid="700")
        self.assertFalse(link.created_here)

    def test_a_renamed_role_renames_only_its_own_group(self):
        self.conn.group_layout = PrtgConnection.LAYOUT_ROLES
        self.conn.save()
        tag = f"danbyte-group-role-{self.core.id}"
        self.fake.tables["groups"].append(group_row(701, "Core", parent=1,
                                                    tags=["danbyte", tag]))
        self.sw()
        self.plan()
        rename = self.changes(PrtgChange.RENAME_GROUP)
        self.assertEqual(len(rename), 1)
        self.assertEqual((rename[0].detail["from"], rename[0].detail["to"]),
                         ("Core", "Core switches"))
        self.assertEqual(self.changes(PrtgChange.CREATE_GROUP), [])

    def test_a_policy_group_wins_unless_it_asks_for_the_layout(self):
        self.sw()
        p = policy(self.conn, "servers", self.ping, group="64")
        self.plan()
        self.assertEqual(self.changes(PrtgChange.CREATE_DEVICE)[0].detail["group"]["objid"],
                         "64")
        self.assertEqual(self.changes(PrtgChange.CREATE_GROUP), [])
        p.use_layout = True
        p.group_id = ""
        p.save()
        self.plan()
        group = self.changes(PrtgChange.CREATE_DEVICE)[0].detail["group"]
        self.assertEqual(group["source"], "layout")
        self.assertEqual(group["policy"], "servers")

    def test_no_layout_keeps_the_registration_group(self):
        self.conn.group_layout = PrtgConnection.LAYOUT_NONE
        self.conn.save()
        self.sw()
        self.plan()
        self.assertEqual(self.changes(PrtgChange.CREATE_GROUP), [])
        self.assertEqual(self.changes(PrtgChange.CREATE_DEVICE)[0].detail["group"]["objid"],
                         LOCAL_PROBE)

    def test_without_api_v2_groups_need_attention(self):
        self.conn.write_mode = PrtgConnection.WRITE_SEED
        self.conn.v2_available = False
        self.conn.seed_device_objid = "2080"
        self.conn.save()
        self.sw()
        self.plan()
        row = self.changes(PrtgChange.CREATE_GROUP)[0]
        self.assertFalse(row.detail["applicable"])
        self.assertEqual(row.detail["issues"][0]["code"], "group_writes")


class ApplyTests(_Layout):
    def apply_all(self):
        with NO_GAP, mock.patch.object(writer.PrtgV2Client, "for_connection",
                                       side_effect=lambda c, **k: _fast(c)):
            return writer.apply_ready(self.conn)

    def test_groups_then_device_land_in_prtg(self):
        self.conn.group_layout = PrtgConnection.LAYOUT_SITES
        self.conn.layout_regions = False
        self.conn.save()
        d = self.sw()
        self.plan()
        self.fake.group_parent_misses = 1  # a new group is not a parent at once
        out = self.apply_all()
        self.assertEqual(out["failed"], [])
        kinds = [r["detail"] for r in out["results"]]
        self.assertTrue(kinds[0].startswith("Created group"))
        site = next(g for g in self.fake.tables["groups"] if g["name"] == "København HQ")
        floor = next(g for g in self.fake.tables["groups"] if g["name"] == "Floor 1")
        room = next(g for g in self.fake.tables["groups"] if g["name"] == "Server room")
        self.assertEqual(site["parentid"], 1)
        self.assertEqual(floor["parentid"], site["objid"])
        self.assertEqual(room["parentid"], floor["objid"])
        self.assertIn(f"danbyte-group-location-{self.room.id}", room["tags"])
        device = next(r for r in self.fake.tables["devices"] if r["name"] == d.name)
        self.assertEqual(device["parentid"], room["objid"])
        self.assertTrue(PrtgGroupLink.objects.get(connection=self.conn,
                                                  objid=str(room["objid"])).created_here)
        # The next plan finds everything in place.
        self.plan()
        self.assertEqual([c for c in self.changes(PrtgChange.CREATE_GROUP)
                          if not c.detail.get("applied")], [])

    def test_order_is_groups_devices_sensors(self):
        rows = [
            PrtgChange(kind=PrtgChange.ADD_SENSOR, detail={}),
            PrtgChange(kind=PrtgChange.CREATE_DEVICE, detail={}),
            PrtgChange(kind=PrtgChange.CREATE_GROUP, detail={"depth": 1}),
            PrtgChange(kind=PrtgChange.CREATE_GROUP, detail={"depth": 0}),
            PrtgChange(kind=PrtgChange.REMOVE_GROUP, detail={"depth": 0}),
            PrtgChange(kind=PrtgChange.REMOVE_GROUP, detail={"depth": 2}),
        ]
        from django.utils import timezone

        for r in rows:
            r.created_at = timezone.now()
        ordered = [(r.kind, r.detail.get("depth")) for r in sorted(rows,
                                                                  key=writer.apply_order)]
        self.assertEqual(ordered, [
            ("create_group", 0), ("create_group", 1), ("create_device", None),
            ("add_sensor", None), ("remove_group", 2), ("remove_group", 0),
        ])

    def test_a_layout_move_for_a_device_danbyte_made(self):
        self.conn.group_layout = PrtgConnection.LAYOUT_ROLES
        self.conn.save()
        d = self.sw("sw-core-9", "10.0.0.2")
        link = self.link(d, 2080)
        link.created_here = True
        link.save()
        self.plan()
        move = self.changes(PrtgChange.MOVE_DEVICE)[0]
        self.assertEqual(move.detail["to"]["objid"], "")
        self.apply_all()
        group = next(g for g in self.fake.tables["groups"] if g["name"] == "Core switches")
        self.assertEqual(self.fake.device(2080)["parentid"], group["objid"])

    def test_a_device_danbyte_did_not_make_is_not_moved(self):
        self.conn.group_layout = PrtgConnection.LAYOUT_ROLES
        self.conn.save()
        self.link(self.sw("sw-core-9", "10.0.0.2"), 2080)
        self.plan()
        self.assertEqual(self.changes(PrtgChange.MOVE_DEVICE), [])
        self.assertEqual(self.changes(PrtgChange.CREATE_GROUP), [])

    def test_empty_groups_are_pruned_only_when_asked(self):
        self.conn.group_layout = PrtgConnection.LAYOUT_ROLES
        self.conn.save()
        tag = "danbyte-group-role-00000000-0000-0000-0000-000000000001"
        self.fake.tables["groups"].append(group_row(702, "Gone role", parent=1,
                                                    tags=["danbyte", tag]))
        self.fake.tables["groups"].append(group_row(703, "Mine by hand", parent=1))
        PrtgGroupLink.objects.create(tenant=self.tenant, connection=self.conn, key="grp-x",
                                     objid="702", tag=tag, created_here=True, kind="role")
        PrtgGroupLink.objects.create(tenant=self.tenant, connection=self.conn, key="grp-y",
                                     objid="703", created_here=False, kind="role")
        self.sw()
        self.plan()
        self.assertEqual(self.changes(PrtgChange.REMOVE_GROUP), [])
        self.conn.prune_devices = True
        self.conn.save()
        self.plan()
        rows = self.changes(PrtgChange.REMOVE_GROUP)
        self.assertEqual([r.detail["objid"] for r in rows], ["702"])
        self.assertFalse(writer.ready(rows[0]))  # removals wait for a person
        with NO_GAP:
            writer.apply(rows[0])
        self.assertIsNone(self.fake.group(702))
        self.assertIsNotNone(self.fake.group(703))


class CredentialPlacementTests(_Layout):
    def setUp(self):
        super().setUp()
        self.conn.group_layout = PrtgConnection.LAYOUT_NONE
        self.conn.sensor_catalog = {"kinds": {"read_at": "2026-10-27T00:00:00+00:00", "rows": [
            {"id": PVE_KIND, "name": "Proxmox VE Node Performance", "form": "generic",
             "credentials": PROXMOX},
        ]}}
        self.conn.save()
        self.pve = profile(self.conn, "Proxmox")
        PrtgSensorDefinition.objects.create(profile=self.pve, kind=PVE_KIND, required=True)
        self.conn.register_profile = self.pve
        self.conn.save()
        self.token = PrtgCredential.objects.create(
            tenant=self.tenant, connection=self.conn, name="pve token", kind="proxmox",
            params={"user": "prtg", "realm": "pve", "token_id": "danbyte"},
            secret_params={"token_secret": "s3cret-token"},
        )

    def test_inherit_set_nowhere_needs_attention(self):
        self.sw()
        self.plan()
        create = self.changes(PrtgChange.CREATE_DEVICE)[0]
        self.assertFalse(create.detail["applicable"])
        found = [i for i in create.detail["issues"] if i["code"] == "credentials_missing"]
        self.assertEqual(found[0]["profile"], str(self.pve.id))
        self.assertIn("Proxmox credentials are not set on any group above", found[0]["text"])

    def test_inherit_from_the_probe_is_fine(self):
        self.fake.node_settings[1] = {PROXMOX: {
            f"{PROXMOX}-credentials_group-api_token_id": "root@pam!prtg"}}
        self.sw()
        self.plan()
        create = self.changes(PrtgChange.CREATE_DEVICE)[0]
        self.assertTrue(create.detail["applicable"], create.detail["issues"])
        state = self.conn.__class__.objects.get(pk=self.conn.pk).credential_reads["1"]
        self.assertEqual(state["sections"][PROXMOX]["source"], "Local Probe")

    def test_set_on_the_group_writes_once(self):
        self.pve.credential_placement = {PROXMOX: {"mode": "group",
                                                   "credential": str(self.token.id)}}
        self.pve.save()
        self.sw()
        self.plan()
        rows = self.changes(PrtgChange.GROUP_CREDENTIALS)
        self.assertEqual(len(rows), 1)
        self.assertNotIn("s3cret-token", str(rows[0].detail))
        self.assertTrue(self.changes(PrtgChange.CREATE_DEVICE)[0].detail["applicable"])
        with NO_GAP:
            writer.apply(rows[0])
        written = self.fake.node_settings[1][PROXMOX]
        self.assertEqual(written[f"{PROXMOX}-credentials_group-api_token_id"],
                         "prtg@pve!danbyte")
        patch = [c for c in self.fake.v2_calls if c["method"] == "PATCH"][-1]
        self.assertIs(patch["body"][PROXMOX]["_inherited"], False)
        self.plan()
        self.assertEqual([r for r in self.changes(PrtgChange.GROUP_CREDENTIALS)
                          if not r.detail.get("applied")], [])
        # A new secret is written again.
        self.token.secret_params = {"token_secret": "rotated"}
        self.token.save()
        self.plan()
        self.assertEqual(len([r for r in self.changes(PrtgChange.GROUP_CREDENTIALS)
                              if not r.detail.get("applied")]), 1)

    def test_set_on_the_device(self):
        self.pve.credential_placement = {PROXMOX: {"mode": "device",
                                                   "credential": str(self.token.id)}}
        self.pve.save()
        d = self.sw()
        self.plan()
        create = self.changes(PrtgChange.CREATE_DEVICE)[0]
        self.assertTrue(create.detail["applicable"])
        self.assertEqual(create.detail["device_credentials"][0]["credential"], "pve token")
        with NO_GAP, mock.patch.object(writer.PrtgV2Client, "for_connection",
                                       side_effect=lambda c, **k: _fast(c)):
            writer.apply(create)
        device = next(r for r in self.fake.tables["devices"] if r["name"] == d.name)
        sections = self.fake.device_settings[device["objid"]]
        self.assertEqual(sections[PROXMOX][f"{PROXMOX}-credentials_group-api_token_secret"],
                         "s3cret-token")

    def test_a_policy_overrides_the_profile(self):
        self.pve.credential_placement = {PROXMOX: {"mode": "device",
                                                   "credential": str(self.token.id)}}
        self.pve.save()
        p = policy(self.conn, "pve", self.pve)
        p.credential_placement = {PROXMOX: {"mode": "group", "credential": str(self.token.id)}}
        p.save()
        self.sw()
        self.plan()
        self.assertEqual(len(self.changes(PrtgChange.GROUP_CREDENTIALS)), 1)
        self.assertEqual(self.changes(PrtgChange.CREATE_DEVICE)[0].detail["device_credentials"],
                         [])

    def test_values_per_kind(self):
        vm = PrtgCredential(kind="vmware", params={"user": "admin"},
                            secret_params={"password": "pw"})
        self.assertEqual(set(credential_values(vm)),
                         {"vmwareconnection", "paessler-vmware-vmware_credentials_section"})
        ssh = PrtgCredential(kind="ssh", params={"user": "root"},
                             secret_params={"private_key": "KEY"})
        self.assertEqual(credential_values(ssh)["linuxconnection"]["linuxloginmode"], "1")
        win = PrtgCredential(kind="windows_login", params={"domain": "LAB", "user": "svc"},
                             secret_params={"password": "pw"})
        self.assertEqual(credential_values(win)["windowsconnection"]["windowslogindomain"],
                         "LAB")


class _ApiCase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="X", slug="x")
        for t in (self.tenant, self.other):
            IntegrationSettings.objects.update_or_create(tenant=t,
                                                         defaults={"prtg_enabled": True})
        self.user = get_user_model().objects.create_superuser("admin", "a@x.dk", "pw")
        self.client.force_authenticate(self.user)
        session = self.client.session
        session["active_tenant_id"] = str(self.tenant.id)
        session.save()
        self.conn = PrtgConnection.objects.create(
            tenant=self.tenant, name="lab", url="https://prtg.example",
            register_group_id="1", register_group_path="Local Probe",
            groups_cache=[{"objid": "1", "name": "Local Probe", "kind": "probe",
                           "path": "Local Probe", "parent_id": "0", "tags": []}],
        )
        self.foreign = PrtgConnection.objects.create(tenant=self.other, name="x",
                                                     url="https://prtg.example")


class CredentialApiTests(_ApiCase):
    def test_secrets_are_write_only(self):
        r = self.client.post("/api/prtg/credentials/", {
            "connection": str(self.conn.id), "name": "pve", "kind": "proxmox",
            "params": {"user": "prtg", "realm": "pve", "token_id": "danbyte"},
            "token_secret": "s3cret",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn("s3cret", r.content.decode())
        self.assertTrue(r.json()["token_secret_set"])
        cred = PrtgCredential.objects.get(pk=r.json()["id"])
        self.assertEqual(cred.secret_params["token_secret"], "s3cret")
        # A blank secret keeps the stored one.
        r = self.client.patch(f"/api/prtg/credentials/{cred.id}/", {"token_secret": "",
                                                                   "name": "pve2"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        cred.refresh_from_db()
        self.assertEqual(cred.secret_params["token_secret"], "s3cret")

    def test_another_tenants_connection_is_refused(self):
        r = self.client.post("/api/prtg/credentials/", {
            "connection": str(self.foreign.id), "name": "x", "kind": "vmware",
            "params": {"user": "u"}, "password": "p",
        }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_proxmox_needs_a_token(self):
        r = self.client.post("/api/prtg/credentials/", {
            "connection": str(self.conn.id), "name": "pve", "kind": "proxmox",
            "params": {"user": "root", "realm": "pam"}, "password": "pw",
        }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_placement_is_checked(self):
        prof = PrtgSensorProfile.objects.create(tenant=self.tenant, connection=self.conn,
                                                name="p")
        other = PrtgCredential.objects.create(tenant=self.other, connection=self.foreign,
                                              name="theirs", kind="proxmox",
                                              params={"user": "a!b"},
                                              secret_params={"token_secret": "x"})
        r = self.client.patch(f"/api/prtg/profiles/{prof.id}/", {"credential_placement": {
            PROXMOX: {"mode": "group", "credential": str(other.id)}}}, format="json")
        self.assertEqual(r.status_code, 400)
        mine = PrtgCredential.objects.create(tenant=self.tenant, connection=self.conn,
                                             name="mine", kind="proxmox",
                                             params={"user": "a!b"},
                                             secret_params={"token_secret": "x"})
        r = self.client.patch(f"/api/prtg/profiles/{prof.id}/", {"credential_placement": {
            PROXMOX: {"mode": "group", "credential": str(mine.id)},
            "windowsconnection": {"mode": "inherit"}}}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["credential_placement"], {
            PROXMOX: {"mode": "group", "credential": str(mine.id)}})
        r = self.client.delete(f"/api/prtg/credentials/{mine.id}/")
        self.assertEqual(r.status_code, 400)


class LayoutApiTests(_ApiCase):
    def test_layout_needs_a_root(self):
        self.conn.register_group_id = ""
        self.conn.save()
        r = self.client.patch(f"/api/prtg/connections/{self.conn.id}/",
                              {"group_layout": "roles"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("layout_root_id", r.json())

    def test_preview(self):
        from api.models import Device

        site = Site.objects.create(tenant=self.tenant, name="HQ")
        role = DeviceRole.objects.create(tenant=self.tenant, name="Core switches",
                                         slug="core")
        Device.objects.create(tenant=self.tenant, name="sw1", site=site, role=role)
        Device.objects.create(tenant=self.other, name="theirs")
        r = self.client.get(f"/api/prtg/connections/{self.conn.id}/layout-preview/"
                            "?layout=sites_roles")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual([g["path"] for g in body["groups"]],
                         ["Local Probe › HQ › Core switches"])
        self.assertEqual(body["groups"][0]["objects"], ["sw1"])
        self.assertFalse(body["rows"][0]["path"][0]["exists"])
        r = self.client.get(f"/api/prtg/connections/{self.foreign.id}/layout-preview/")
        self.assertEqual(r.status_code, 404)

    def test_policy_may_use_the_layout_without_a_group(self):
        prof = PrtgSensorProfile.objects.create(tenant=self.tenant, connection=self.conn,
                                                name="p")
        r = self.client.post("/api/prtg/policies/", {
            "connection": str(self.conn.id), "name": "by layout", "profile": str(prof.id),
            "use_layout": True,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.post("/api/prtg/policies/", {
            "connection": str(self.conn.id), "name": "no group", "profile": str(prof.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
