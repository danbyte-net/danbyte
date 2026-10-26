"""PRTG registration and planning: who PRTG should have (never > always >
policies > register all), sensor profiles, the planned changes and their
detail, apply refused, the API and its tenant boundary - against the fake
PRTG on the lab's recordings.

The lab, as the recordings have it: sw-01 (2080, 10.0.0.2) and db-dev01
(2081, 10.0.0.41) and db-zabbix (2082, 10.0.0.53: Ping v2 2092 and HTTP
2100) directly under the Local Probe (1); gw (2095) in Linux / macOS / Unix
(55). Groups include Servers (64) under Windows (54) under Network
Discovery (50) under the Local Probe.
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.db.models import NOT_PROVIDED
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    InventoryItem,
    IPAddress,
    Location,
    Manufacturer,
    Platform,
    Region,
    Service,
    Site,
    Status,
    VirtualMachine,
)
from core.models import Organization, Tag, Tenant
from integrations.models import IntegrationSettings
from monitoring.models import SnmpProfile
from prtg import sensor_kinds as sk
from prtg.client import PrtgClient
from prtg.models import (
    PrtgChange,
    PrtgConnection,
    PrtgDeviceLink,
    PrtgPolicy,
    PrtgSensor,
    PrtgSensorDefinition,
    PrtgSensorProfile,
)
from prtg.provision import (
    NOT_YET,
    TEXT,
    Context,
    decide,
    expand,
    instance_tag,
    load_policies,
    make_starter,
    plan,
    policy_matches,
    preview,
)

from .fake_server import load_fixture
from .test_status import _Lab

LOCAL_PROBE, LINUX, SERVERS = "1", "55", "64"


def profile(conn, name, *defs):
    p = PrtgSensorProfile.objects.create(tenant=conn.tenant, connection=conn, name=name)
    for i, (kind, params, required) in enumerate(defs):
        PrtgSensorDefinition.objects.create(
            profile=p, position=i, kind=kind, params=sk.clean_params(kind, params),
            required=required,
        )
    return p


def policy(conn, name, prof, group=LOCAL_PROBE, priority=100, scope="global", **kw):
    return PrtgPolicy.objects.create(
        tenant=conn.tenant, connection=conn, name=name, profile=prof, group_id=group,
        group_path=name, priority=priority, scope=scope, **kw,
    )


class _Plan(_Lab):
    def setUp(self):
        super().setUp()
        SnmpProfile.objects.create(tenant=self.tenant, name="lab-v2c", slug="lab-v2c")
        self.ping = profile(self.conn, "Ping", ("ping", {}, True))

    def plan(self):
        with mock.patch("prtg.client.PAGE_GAP_SECONDS", 0):
            return plan(self.conn)

    def changes(self, kind=None):
        qs = PrtgChange.objects.filter(connection=self.conn)
        return list(qs.filter(kind=kind) if kind else qs)

    def link(self, device, objid, name=""):
        return PrtgDeviceLink.objects.create(
            tenant=self.tenant, connection=self.conn, device=device, objid=str(objid),
            name=name or device.name, matched_by="address",
        )

    def ctx(self):
        return Context(self.tenant, load_policies(self.conn))


class GroupsTests(_Lab):
    def test_paths_from_the_recorded_tree(self):
        groups = PrtgClient.for_connection(self.conn).groups_tree()
        by_id = {g["objid"]: g for g in groups}
        self.assertNotIn("0", by_id)  # the root group holds probes, not devices
        self.assertEqual(by_id["1"]["kind"], "probe")
        self.assertEqual(by_id["1"]["path"], "Local Probe")
        self.assertEqual(by_id[SERVERS]["path"],
                         "Local Probe / Network Discovery / Windows / Servers")
        self.assertEqual(by_id[SERVERS]["kind"], "group")
        # The core server's autonomous device is not a probe.
        self.assertNotIn("1028", by_id)

    def test_the_recorded_probe_list(self):
        # content=probenode&filter_type=probenode as the lab answered it.
        self.fake.raw_tables["probenode"] = load_fixture("table_probes.json", raw=True)
        groups = PrtgClient.for_connection(self.conn).groups_tree()
        probes = [g for g in groups if g["kind"] == "probe"]
        self.assertEqual([(p["objid"], p["path"]) for p in probes], [("1", "Local Probe")])
        self.assertEqual(len(groups), 15)


class PrecedenceTests(_Plan):
    def test_never_beats_policies_and_register_all(self):
        d = self.device("edge", "10.0.0.90")
        d.prtg_sync = "never"
        d.save()
        policy(self.conn, "all", self.ping)
        self.conn.register_all = True
        self.conn.save()
        want = decide(self.conn, d, self.ctx(), linked=False)
        self.assertEqual(want.via, "never")
        self.plan()
        self.assertFalse(PrtgChange.objects.filter(device=d).exists())

    def test_always_needs_no_policy_and_takes_the_connection_defaults(self):
        d = self.device("edge", "10.0.0.90")
        d.prtg_sync = "always"
        d.save()
        self.conn.register_profile = self.ping
        self.conn.register_group_id = LINUX
        self.conn.save()
        self.plan()
        [c] = self.changes(PrtgChange.CREATE_DEVICE)
        self.assertEqual(c.detail["via"], "always")
        self.assertEqual(c.detail["group"]["objid"], LINUX)
        self.assertEqual(c.detail["group"]["path"], "Local Probe / Network Discovery / "
                                                    "Linux / macOS / Unix")
        self.assertEqual([s["kind"] for s in c.detail["sensors"]], ["ping"])

    def test_always_overrides_a_retired_status(self):
        retired = Status.objects.create(tenant=self.tenant, name="Retired", slug="retired")
        d = self.device("old", "10.0.0.91")
        d.status = retired
        d.save()
        policy(self.conn, "all", self.ping)
        self.assertEqual(decide(self.conn, d, self.ctx(), linked=False).via, "")
        d.prtg_sync = "always"
        d.save()
        self.assertEqual(decide(self.conn, d, self.ctx(), linked=False).via, "always")

    def test_policies_beat_register_all(self):
        d = self.device("edge", "10.0.0.90")
        other = profile(self.conn, "Other", ("snmp_uptime", {}, True))
        self.conn.register_all = True
        self.conn.register_profile = other
        self.conn.register_group_id = LINUX
        self.conn.save()
        policy(self.conn, "servers", self.ping, group=SERVERS)
        want = decide(self.conn, d, self.ctx(), linked=False)
        self.assertEqual(want.via, "policy")
        self.assertEqual([p.name for p in want.profiles], ["Ping"])
        self.assertEqual(want.group["objid"], SERVERS)

    def test_register_all_skips_linked_retired_and_excluded_addresses(self):
        self.conn.register_all = True
        self.conn.register_profile = self.ping
        self.conn.register_group_id = LINUX
        self.conn.save()
        fresh = self.device("fresh", "10.0.0.90")
        linked = self.device("db-zabbix", "10.0.0.53")
        self.link(linked, 2082)
        retired = self.device("gone", "10.0.0.92")
        retired.status = Status.objects.create(
            tenant=self.tenant, name="Decommissioned", slug="decommissioned"
        )
        retired.save()
        muted = self.device("muted", "10.0.0.93")
        muted.primary_ip.monitoring_excluded = True
        muted.primary_ip.save()
        self.plan()
        created = {c.device_id for c in self.changes(PrtgChange.CREATE_DEVICE)}
        self.assertEqual(created, {fresh.id})
        # Register all only adds devices: nothing for the linked one.
        self.assertFalse(PrtgChange.objects.filter(device=linked).exists())

    def test_nothing_configured_proposes_nothing(self):
        self.device("edge", "10.0.0.90")
        counts = self.plan()
        self.assertEqual(counts["create"], 0)
        self.assertEqual(self.changes(), [])
        # And PRTG was not asked for its groups.
        self.assertEqual(self.fake.calls("/api/table.json"), [])

    def test_checks_scope_needs_a_prtg_check(self):
        self.conn.provision_scope = PrtgConnection.SCOPE_CHECKS
        self.conn.save()
        policy(self.conn, "all", self.ping)
        d = self.device("edge", "10.0.0.90")
        want = decide(self.conn, d, self.ctx(), linked=False, checked=set())
        self.assertEqual(want.via, "")
        self.assertEqual(want.reason, TEXT["no_check"])
        self.assertEqual(want.reason_issue["code"], "no_check")
        want = decide(self.conn, d, self.ctx(), linked=False, checked={d.id})
        self.assertEqual(want.via, "policy")


class PolicyScopeTests(_Plan):
    def setUp(self):
        super().setUp()
        self.region = Region.objects.create(tenant=self.tenant, name="EU", slug="eu")
        self.site.region = self.region
        self.site.save()
        self.room = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall", slug="hall"
        )
        self.rack_row = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Row", slug="row", parent=self.room
        )
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Core", slug="core")
        self.platform = Platform.objects.create(tenant=self.tenant, name="Linux", slug="linux")
        mf = Manufacturer.objects.create(tenant=self.tenant, name="Acme", slug="acme")
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mf, model="X1"
        )
        self.d = self.device("core-1", "10.0.0.90")
        self.d.role, self.d.platform, self.d.device_type = self.role, self.platform, self.dtype
        self.d.location = self.rack_row
        self.d.save()
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct, site=self.site)
        self.vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="app-1", cluster=cluster, role=self.role,
            platform=self.platform, device=self.d,
        )

    def matches(self, obj, **kw):
        p = policy(self.conn, "p", self.ping, **kw)
        try:
            return policy_matches(PrtgPolicy.objects.get(pk=p.pk), obj, self.ctx())
        finally:
            p.delete()

    def test_each_scope_for_a_device(self):
        self.assertTrue(self.matches(self.d))
        self.assertTrue(self.matches(self.d, scope="region", region=self.region))
        self.assertTrue(self.matches(self.d, scope="site", target_site=self.site))
        # A parent location reaches a device in a child location.
        self.assertTrue(self.matches(self.d, scope="location", location=self.room))
        self.assertTrue(self.matches(self.d, scope="platform", platform=self.platform))
        self.assertTrue(self.matches(self.d, scope="device_type", device_type=self.dtype))
        self.assertTrue(self.matches(self.d, scope="device_role", device_role=self.role))
        other = Site.objects.create(tenant=self.tenant, name="Other")
        self.assertFalse(self.matches(self.d, scope="site", target_site=other))

    def test_each_scope_for_a_vm(self):
        # The VM's site comes from its cluster; its location from its host.
        self.assertTrue(self.matches(self.vm, scope="site", target_site=self.site))
        self.assertTrue(self.matches(self.vm, scope="region", region=self.region))
        self.assertTrue(self.matches(self.vm, scope="location", location=self.room))
        self.assertTrue(self.matches(self.vm, scope="platform", platform=self.platform))
        self.assertTrue(self.matches(self.vm, scope="device_role", device_role=self.role))
        # A VM has no device type, and no hardware.
        self.assertFalse(self.matches(self.vm, scope="device_type", device_type=self.dtype))
        self.assertFalse(self.matches(self.vm, match_hardware="psu*"))

    def test_applies_to_devices_or_vms(self):
        self.assertFalse(self.matches(self.vm, applies_to_vms=False))
        self.assertFalse(self.matches(self.d, applies_to_devices=False))
        self.assertTrue(self.matches(self.vm, applies_to_devices=False))

    def test_filters_narrow(self):
        core = Tag.objects.create(tenant=self.tenant, name="Core", slug="core")
        prod = Tag.objects.create(tenant=self.tenant, name="Prod", slug="prod")
        self.d.tags.add(core)
        self.assertTrue(self.matches(self.d, match_tags=["core"]))
        # All of them, not any.
        self.assertFalse(self.matches(self.d, match_tags=["core", "prod"]))
        self.d.tags.add(prod)
        self.assertTrue(self.matches(self.d, match_tags=["core", "prod"]))
        self.assertTrue(self.matches(self.d, match_name="CORE-*"))
        self.assertFalse(self.matches(self.d, match_name="edge-*"))
        self.assertFalse(self.matches(self.d, match_hardware="psu*"))
        InventoryItem.objects.create(device=self.d, name="PSU-1")
        self.assertTrue(self.matches(self.d, match_hardware="psu*"))
        self.vm.tags.add(core)
        self.assertTrue(self.matches(self.vm, match_tags=["core"], match_name="app-*"))

    def test_a_policy_never_matches_another_tenant(self):
        org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org, name="T2", slug="t2")
        foreign = Device.objects.create(tenant=other, name="core-1")
        self.assertFalse(self.matches(foreign))


class ProfileTests(_Plan):
    def test_profiles_union_and_the_first_policy_decides_the_group(self):
        d = self.device("edge", "10.0.0.90")
        snmp = profile(self.conn, "SNMP", ("ping", {}, True), ("snmp_uptime", {}, True))
        policy(self.conn, "late", snmp, group=LINUX, priority=20)
        policy(self.conn, "early", self.ping, group=SERVERS, priority=10)
        self.plan()
        [c] = self.changes(PrtgChange.CREATE_DEVICE)
        self.assertEqual(c.detail["group"]["objid"], SERVERS)
        self.assertEqual([p["name"] for p in c.detail["policies"]], ["early", "late"])
        # Ping from both profiles is one sensor.
        self.assertEqual([s["kind"] for s in c.detail["sensors"]], ["ping", "snmp_uptime"])
        self.assertEqual(c.detail["credentials"],
                         [{"kind": "snmp", "name": "lab-v2c", "version": "v2c"}])
        self.assertTrue(c.detail["applicable"])

    def test_interface_glob_and_connected_only(self):
        d = self.device("sw", "10.0.0.90")
        for name, connected, enabled in (("ge-0/0/1", True, True), ("ge-0/0/2", False, True),
                                         ("ge-0/0/3", True, False), ("xe-0/0/1", True, True)):
            Interface.objects.create(device=d, name=name, mark_connected=connected,
                                     enabled=enabled)
        traffic = profile(self.conn, "Traffic", (
            "snmp_traffic", {"interface": "ge-*", "connected_only": True}, True))
        [defn] = traffic.definitions.all()
        sensors = expand(defn, d)
        self.assertEqual([s["interface"]["name"] for s in sensors], ["ge-0/0/1"])
        self.assertEqual(sensors[0]["name"], "ge-0/0/1 Traffic")
        self.assertEqual(sensors[0]["key"], instance_tag(defn.id, sensors[0]["interface"]["id"]))
        defn.params = sk.clean_params("snmp_traffic", {"interface": "ge-*, xe-*"})
        defn.save()
        names = [s["interface"]["name"] for s in expand(defn, d)]
        self.assertEqual(names, ["ge-0/0/1", "ge-0/0/2", "xe-0/0/1"])

    def test_require_service_on_the_port(self):
        d = self.device("web", "10.0.0.90")
        web = profile(self.conn, "Web", ("http", {"scheme": "https", "require_service": True},
                                        True))
        [defn] = web.definitions.all()
        self.assertEqual(expand(defn, d, host="10.0.0.90"), [])
        Service.objects.create(tenant=self.tenant, device=d, name="https", protocol="tcp",
                               ports=[443])
        [s] = expand(defn, d, host="10.0.0.90")
        self.assertEqual(s["params"]["url"], "https://10.0.0.90/")

    def test_the_starter_profile_is_made_on_request(self):
        p = make_starter(self.conn)
        kinds = [d.kind for d in p.definitions.all()]
        self.assertEqual(kinds, ["ping", "snmp_uptime", "snmp_traffic", "http"])
        self.assertTrue(p.definitions.get(kind="snmp_traffic").params["connected_only"])
        self.assertEqual(make_starter(self.conn).name, "Starter profile 2")

    def test_param_validation(self):
        with self.assertRaises(ValueError):
            sk.clean_params("windows_service", {})
        with self.assertRaises(ValueError):
            sk.clean_params("ping", {"port": 1})
        with self.assertRaises(ValueError):
            sk.clean_params("http", {"port": 70000})
        self.assertEqual(sk.clean_params("http", {})["scheme"], "http")


class ProposalTests(_Plan):
    def test_create_device_detail(self):
        d = self.device("edge", "10.0.0.90")
        policy(self.conn, "servers", self.ping, group=SERVERS)
        counts = self.plan()
        self.assertEqual(counts["create"], 1)
        [c] = self.changes(PrtgChange.CREATE_DEVICE)
        self.assertEqual(c.device_id, d.id)
        self.assertEqual(c.key, "")
        self.assertEqual(c.detail["host"], "10.0.0.90")
        self.assertEqual(c.detail["group"]["kind"], "group")
        self.assertIn(f"danbyte-{d.id}", c.detail["tags"])
        [s] = c.detail["sensors"]
        self.assertEqual((s["kind"], s["name"]), ("ping", "Ping"))
        self.assertEqual(c.detail["credentials"], [])  # ping needs none

    def test_missing_group_and_credentials_are_explained(self):
        SnmpProfile.objects.all().delete()
        self.device("edge", "10.0.0.90")
        snmp = profile(self.conn, "SNMP", ("snmp_uptime", {}, True))
        policy(self.conn, "gone", snmp, group="999")
        self.plan()
        [c] = self.changes(PrtgChange.CREATE_DEVICE)
        self.assertFalse(c.detail["applicable"])
        self.assertIn("The PRTG group gone is gone.", c.detail["reason"])
        self.assertIn("No SNMP profile applies to edge. Set one on its Access tab.",
                      c.detail["reason"])
        codes = [(i["code"], i.get("policy")) for i in c.detail["issues"]]
        gone = PrtgPolicy.objects.get(name="gone")
        self.assertEqual(codes, [("group_gone", str(gone.id)), ("no_snmp", None)])
        self.assertEqual(c.detail["issues"][1]["object"],
                         {"kind": "device", "id": str(c.device_id)})

    def test_wmi_needs_a_windows_login(self):
        self.device("win", "10.0.0.90")
        wmi = profile(self.conn, "Windows", ("wmi_cpu", {}, True))
        policy(self.conn, "win", wmi)
        self.plan()
        [c] = self.changes(PrtgChange.CREATE_DEVICE)
        self.assertFalse(c.detail["applicable"])
        self.assertEqual(
            c.detail["reason"],
            "Danbyte holds no Windows login for win. Add one on its Access tab.",
        )

    def test_a_template_is_part_of_a_new_device_only(self):
        d = self.device("edge", "10.0.0.90")
        tpl = profile(self.conn, "Tpl", ("device_template", {"template": "Linux"}, True))
        policy(self.conn, "tpl", tpl)
        self.plan()
        [c] = self.changes(PrtgChange.CREATE_DEVICE)
        self.assertEqual(c.detail["templates"], ["Linux"])
        self.assertEqual(c.detail["sensors"], [])
        PrtgChange.objects.all().delete()
        self.link(d, 2082)
        self.plan()
        self.assertEqual(self.changes(PrtgChange.ADD_SENSOR), [])

    def test_add_sensor_for_a_linked_device(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()  # links db-zabbix and imports its Ping v2 and HTTP sensors
        snmp = profile(self.conn, "Std", ("ping", {}, True), ("snmp_uptime", {}, True),
                       ("snmp_cpu", {}, False))
        policy(self.conn, "std", snmp)
        self.plan()
        [c] = self.changes(PrtgChange.ADD_SENSOR)
        self.assertEqual(c.device_id, d.id)
        self.assertEqual(c.detail["objid"], "2082")
        self.assertEqual(c.detail["sensor"]["kind"], "snmp_uptime")
        self.assertEqual(c.key, c.detail["sensor"]["key"])
        self.assertTrue(c.key.startswith("danbyte-def-"))
        self.assertTrue(c.detail["applicable"])
        # Ping v2 counts as the ping; the optional CPU sensor is not drift.
        self.assertFalse(self.changes(PrtgChange.CREATE_DEVICE))

    def test_remove_sensor_marks_an_unwanted_danbyte_sensor(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()
        sensor = PrtgSensor.objects.get(objid="2100")
        sensor.tags = ["httpsensor", "danbyte-def-0123456789ab"]
        sensor.save()
        policy(self.conn, "ping", self.ping)
        self.plan()
        [c] = self.changes(PrtgChange.REMOVE_SENSOR)
        self.assertEqual((c.device_id, c.key), (d.id, "2100"))
        self.assertEqual(c.detail["sensor"]["objid"], "2100")
        self.assertEqual(c.detail["tag"], "danbyte-def-0123456789ab")

    def test_move_device_when_the_group_differs(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()
        policy(self.conn, "linux", self.ping, group=LINUX)
        self.plan()
        [c] = self.changes(PrtgChange.MOVE_DEVICE)
        self.assertEqual(c.device_id, d.id)
        self.assertEqual(c.detail["from"], {"objid": LOCAL_PROBE, "path": "Local Probe"})
        self.assertEqual(c.detail["to"]["objid"], LINUX)
        self.assertTrue(c.detail["applicable"])
        # In the right group: no move.
        PrtgPolicy.objects.update(group_id=LOCAL_PROBE)
        self.plan()
        self.assertEqual(self.changes(PrtgChange.MOVE_DEVICE), [])

    def test_a_device_waiting_for_its_link_is_not_created(self):
        self.conn.link_mode = PrtgConnection.LINK_REVIEW
        self.conn.save()
        self.device("db-zabbix", "10.0.0.53")
        policy(self.conn, "all", self.ping)
        with mock.patch("prtg.client.PAGE_GAP_SECONDS", 0):
            counts = self.read()
        self.assertEqual(counts["plan"]["awaiting_link"], 1)
        self.assertEqual(self.changes(PrtgChange.CREATE_DEVICE), [])
        self.assertEqual(len(self.changes(PrtgChange.LINK)), 1)

    def test_no_address_is_counted_not_proposed(self):
        Device.objects.create(tenant=self.tenant, name="bare", site=self.site)
        policy(self.conn, "all", self.ping)
        counts = self.plan()
        self.assertEqual(counts["no_address"], 1)
        self.assertEqual(self.changes(PrtgChange.CREATE_DEVICE), [])

    def test_stale_plans_go_and_the_status_read_keeps_them(self):
        d = self.device("edge", "10.0.0.90")
        pol = policy(self.conn, "all", self.ping)
        self.read()
        self.assertEqual(len(self.changes(PrtgChange.CREATE_DEVICE)), 1)
        # A second read re-proposes rather than dropping them.
        self.read()
        self.assertEqual(len(self.changes(PrtgChange.CREATE_DEVICE)), 1)
        pol.delete()
        self.plan()
        self.assertFalse(PrtgChange.objects.filter(device=d).exists())

    def test_a_failed_group_read_proposes_and_drops_nothing(self):
        self.device("edge", "10.0.0.90")
        policy(self.conn, "all", self.ping)
        self.plan()
        self.fake.fail = (500, "boom")
        from prtg.client import PrtgError

        with self.assertRaises(PrtgError):
            self.plan()
        self.assertEqual(len(self.changes(PrtgChange.CREATE_DEVICE)), 1)

    def test_vms_are_planned_too(self):
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="app-1", cluster=cluster)
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.95/24",
                                      prefix=self.prefix, assigned_vm=vm)
        vm.primary_ip = ip
        vm.save()
        policy(self.conn, "vms", self.ping, applies_to_devices=False)
        self.device("edge", "10.0.0.90")
        self.plan()
        [c] = self.changes(PrtgChange.CREATE_DEVICE)
        self.assertEqual(c.virtual_machine_id, vm.id)
        self.assertEqual(c.detail["host"], "10.0.0.95")

    def test_preview_for_one_object(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()
        snmp = profile(self.conn, "Std", ("ping", {}, True), ("snmp_uptime", {}, True))
        policy(self.conn, "std", snmp, group=LOCAL_PROBE)
        self.plan()
        before = PrtgChange.objects.count()
        out = preview(self.conn, d)
        self.assertEqual(PrtgChange.objects.count(), before)
        self.assertTrue(out["managed"])
        self.assertEqual(out["via"], "policy")
        self.assertEqual(out["group"]["path"], "Local Probe")
        self.assertEqual([(s["kind"], s["present"]) for s in out["sensors"]],
                         [("ping", True), ("snmp_uptime", False)])
        self.assertEqual(out["sensors"][0]["sensor"]["objid"], "2092")


class _Api(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
        for tenant in (self.tenant, self.other):
            IntegrationSettings.objects.update_or_create(
                tenant=tenant, defaults={"prtg_enabled": True}
            )
        self.admin = get_user_model().objects.create_superuser("root", "r@x.io", "pw")
        self.conn = PrtgConnection.objects.create(
            tenant=self.tenant, name="a", url="https://prtg.example.com",
            credentials={"api_key": "k"},
            groups_cache=[{"objid": "1", "name": "Local Probe", "kind": "probe",
                           "path": "Local Probe", "probe": "Local Probe", "parent_id": "0"}],
        )
        self.foreign = PrtgConnection.objects.create(
            tenant=self.other, name="b", url="https://prtg.example.com",
            credentials={"api_key": "k"},
        )
        self.site = Site.objects.create(tenant=self.tenant, name="S")
        self.foreign_site = Site.objects.create(tenant=self.other, name="F")
        self.prof = profile(self.conn, "Ping", ("ping", {}, True))
        self.foreign_prof = profile(self.foreign, "Ping", ("ping", {}, True))
        self.client.force_login(self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def post_policy(self, **kw):
        body = {"connection": str(self.conn.id), "name": "p", "profile": str(self.prof.id),
                "group_id": "1", "group_path": "Local Probe", **kw}
        return self.client.post("/api/prtg/policies/", body, format="json")


class PolicyApiTests(_Api):
    def test_create_and_list(self):
        r = self.post_policy(scope="site", target_site=str(self.site.id), priority=5)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["target_name"], "S")
        rows = self.client.get(f"/api/prtg/policies/?connection={self.conn.id}").json()
        self.assertEqual(rows["count"], 1)

    def test_scope_needs_its_target_and_drops_the_others(self):
        r = self.post_policy(scope="site")
        self.assertEqual(r.status_code, 400)
        self.assertIn("target_site", r.json())
        r = self.post_policy(scope="global", target_site=str(self.site.id))
        self.assertEqual(r.status_code, 201)
        self.assertIsNone(r.json()["target_site"])

    def test_foreign_rows_are_refused(self):
        self.assertEqual(
            self.post_policy(scope="site", target_site=str(self.foreign_site.id)).status_code,
            400,
        )
        self.assertEqual(self.post_policy(profile=str(self.foreign_prof.id)).status_code, 400)
        self.assertEqual(
            self.post_policy(connection=str(self.foreign.id)).status_code, 400
        )

    def test_group_and_profile_are_required(self):
        r = self.post_policy(group_id="")
        self.assertEqual(r.status_code, 400)
        r = self.post_policy(profile=None)
        self.assertEqual(r.status_code, 400)

    def test_off_integration_is_404(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=False)
        self.assertEqual(self.client.get("/api/prtg/policies/").status_code, 404)
        self.assertEqual(self.client.get("/api/prtg/plan/?device=x").status_code, 404)


class ProfileApiTests(_Api):
    def test_nested_definitions_in_order(self):
        r = self.client.post("/api/prtg/profiles/", {
            "connection": str(self.conn.id), "name": "Std",
            "definitions": [
                {"kind": "ping"},
                {"kind": "snmp_traffic", "params": {"interface": "ge-*"},
                 "interval_seconds": 60, "tags": ["uplink"]},
            ],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        defs = r.json()["definitions"]
        self.assertEqual([d["kind"] for d in defs], ["ping", "snmp_traffic"])
        self.assertEqual(defs[1]["params"], {"interface": "ge-*", "connected_only": False})
        keep = defs[1]["id"]
        r = self.client.patch(f"/api/prtg/profiles/{r.json()['id']}/", {
            "definitions": [{"id": keep, "kind": "snmp_traffic"}, {"kind": "snmp_uptime"}],
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        defs = r.json()["definitions"]
        self.assertEqual(defs[0]["id"], keep)
        self.assertEqual([d["kind"] for d in defs], ["snmp_traffic", "snmp_uptime"])

    def test_bad_definitions_are_refused(self):
        for bad in ({"kind": "nope"}, {"kind": "ping", "params": {"x": 1}},
                    {"kind": "ping", "interval_seconds": 7},
                    {"kind": "ping", "tags": ["danbyte-mine"]},
                    {"kind": "windows_service"}):
            with self.subTest(bad=bad):
                r = self.client.post("/api/prtg/profiles/", {
                    "connection": str(self.conn.id), "name": "x", "definitions": [bad],
                }, format="json")
                self.assertEqual(r.status_code, 400, r.content)

    def test_starter_and_kinds(self):
        r = self.client.post("/api/prtg/profiles/starter/",
                             {"connection": str(self.conn.id)}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(len(r.json()["definitions"]), 4)
        r = self.client.post("/api/prtg/profiles/starter/",
                             {"connection": str(self.foreign.id)}, format="json")
        self.assertEqual(r.status_code, 404)
        kinds = self.client.get("/api/prtg/profiles/kinds/").json()["kinds"]
        self.assertIn("device_template", {k["value"] for k in kinds})

    def test_a_profile_in_use_is_not_deleted(self):
        self.assertEqual(self.post_policy().status_code, 201)
        r = self.client.delete(f"/api/prtg/profiles/{self.prof.id}/")
        self.assertEqual(r.status_code, 400)
        self.assertIn("p", r.json()["detail"])

    def test_foreign_profiles_are_invisible(self):
        r = self.client.get(f"/api/prtg/profiles/{self.foreign_prof.id}/")
        self.assertEqual(r.status_code, 404)

    def test_register_profile_must_be_this_connections(self):
        r = self.client.patch(f"/api/prtg/connections/{self.conn.id}/", {
            "register_all": True, "register_profile": str(self.foreign_prof.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/prtg/connections/{self.conn.id}/", {
            "register_all": True, "register_profile": str(self.prof.id),
            "register_group_id": "1", "register_group_path": "Local Probe",
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["register_profile_name"], "Ping")


class QueueApiTests(_Api):
    def test_apply_is_refused_and_apply_all_skips_planned(self):
        d = Device.objects.create(tenant=self.tenant, name="edge", site=self.site)
        change = PrtgChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=d,
            kind=PrtgChange.CREATE_DEVICE, detail={"applicable": True},
        )
        rows = self.client.get("/api/prtg/changes/").json()["results"]
        self.assertTrue(rows[0]["planned"])
        self.assertEqual(rows[0]["kind_display"], "Create in PRTG")
        r = self.client.post(f"/api/prtg/changes/{change.id}/apply/")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["detail"], NOT_YET)
        r = self.client.post("/api/prtg/changes/apply-all/",
                             {"connection": str(self.conn.id)}, format="json")
        self.assertEqual(r.json()["applied"], 0)
        self.assertTrue(PrtgChange.objects.filter(pk=change.pk).exists())

    def test_applicable_follows_the_detail(self):
        d = Device.objects.create(tenant=self.tenant, name="edge", site=self.site)
        PrtgChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=d,
            kind=PrtgChange.MOVE_DEVICE, detail={"applicable": False, "reason": "gone"},
        )
        [row] = self.client.get("/api/prtg/changes/").json()["results"]
        self.assertFalse(row["applicable"])


class PlanApiTests(_Api):
    def test_plan_for_a_device(self):
        d = Device.objects.create(tenant=self.tenant, name="edge", site=self.site)
        self.post_policy()
        [entry] = self.client.get(f"/api/prtg/plan/?device={d.id}").json()
        self.assertEqual(entry["connection"]["name"], "a")
        self.assertTrue(entry["managed"])
        self.assertEqual(entry["group"]["path"], "Local Probe")
        self.assertEqual([s["kind"] for s in entry["sensors"]], ["ping"])
        self.assertIn(TEXT["no_address"], entry["problems"])
        self.assertIn("no_address", [i["code"] for i in entry["issues"]])

    def test_plan_for_a_foreign_object_is_404(self):
        d = Device.objects.create(tenant=self.other, name="edge")
        self.assertEqual(self.client.get(f"/api/prtg/plan/?device={d.id}").status_code, 404)
        self.assertEqual(self.client.get("/api/prtg/plan/").status_code, 400)

    def test_groups_are_served_from_the_cache(self):
        from django.utils import timezone

        PrtgConnection.objects.filter(pk=self.conn.pk).update(groups_read_at=timezone.now())
        r = self.client.get(f"/api/prtg/groups/?connection={self.conn.id}").json()
        self.assertEqual([g["path"] for g in r["groups"]], ["Local Probe"])
        r = self.client.get(f"/api/prtg/groups/?connection={self.foreign.id}")
        self.assertEqual(r.status_code, 404)


class PrtgSyncFieldTests(_Api):
    def test_devices_and_vms_take_prtg_sync(self):
        d = Device.objects.create(tenant=self.tenant, name="edge", site=self.site)
        self.assertEqual(d.prtg_sync, "inherit")
        r = self.client.patch(f"/api/devices/{d.id}/", {"prtg_sync": "never"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        d.refresh_from_db()
        self.assertEqual(d.prtg_sync, "never")
        r = self.client.patch(f"/api/devices/{d.id}/", {"prtg_sync": "sometimes"},
                              format="json")
        self.assertEqual(r.status_code, 400)
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="v", cluster=cluster)
        r = self.client.patch(f"/api/virtual-machines/{vm.id}/", {"prtg_sync": "always"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["prtg_sync"], "always")


class MigrationShapeTests(TestCase):
    def test_new_columns_carry_database_defaults(self):
        for model, name in ((Device, "prtg_sync"), (VirtualMachine, "prtg_sync"),
                            (PrtgConnection, "register_all"),
                            (PrtgConnection, "groups_cache"),
                            (PrtgPolicy, "priority"), (PrtgSensorDefinition, "required")):
            with self.subTest(model=model.__name__, name=name):
                self.assertIsNot(model._meta.get_field(name).db_default, NOT_PROVIDED)
