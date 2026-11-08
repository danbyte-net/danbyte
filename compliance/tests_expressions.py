"""Compliance rules with object types, a scope and conditions: the compiler,
the API's validation, the preview, the multi-type engine and the migration
that gives older rules their one type."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from django.db import OperationalError, connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    DeviceRole,
    Platform,
    Prefix,
    Region,
    Site,
    Status,
    VirtualMachine,
)
from auth_api.models import ObjectPermission, UserProfile
from core.expressions import (
    MAX_DEPTH,
    MAX_LEAVES,
    MAX_VALUES,
    ExpressionError,
    FieldDef,
    compile_q,
    validate,
)
from core.models import Organization, Tag, Tenant
from customization.models import CustomField
from profiles.models import DeviceProfile, DeviceProfileAssignment

from . import engine
from .engine import evaluate, evaluate_for_object, statement_timeout
from .fields import Registry
from .models import ComplianceRule, ComplianceTriage
from .tests import _make_device

RULES = "/api/compliance-rules/"
PREVIEW = "/api/compliance-rules/preview/"
FIELDS = "/api/compliance/fields/"
TRIAGE = "/api/compliance/triage/"


def cmp(field, op, *values, value=None):
    if op in ("in", "not_in"):
        return {"kind": "cmp", "field": field, "cmp": op, "values": [str(v) for v in values]}
    return {"kind": "cmp", "field": field, "cmp": op, "value": value}


def empty(field, negated=False):
    return {"kind": "empty", "field": field, "negated": negated}


def group(op, *terms):
    return {"kind": "group", "op": op, "terms": list(terms)}


class _World:
    """Two devices and two VMs in one tenant, a stranger in another."""

    def build(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        other_org = Organization.objects.create(name="X", slug="x")
        self.other = Tenant.objects.create(org=other_org, name="X", slug="x")
        self.eu = Region.objects.create(tenant=self.tenant, name="EU", slug="eu")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS", region=self.eu)
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        self.server = DeviceRole.objects.create(
            tenant=self.tenant, name="Server", slug="server", color="2f6fdd"
        )
        self.switch = DeviceRole.objects.create(tenant=self.tenant, name="Switch", slug="switch")
        self.active = Status.objects.create(tenant=self.tenant, name="Active", slug="active")
        self.prod = Tag.objects.create(tenant=self.tenant, name="prod", slug="prod")
        self.pci = Tag.objects.create(tenant=self.tenant, name="pci", slug="pci")
        self.foreign_tag = Tag.objects.create(tenant=self.other, name="prod", slug="prod")
        CustomField.objects.create(
            tenant=self.tenant, key="owner", label="Owner", type="text",
            applies_to=["device", "virtualmachine"],
        )
        CustomField.objects.create(
            tenant=self.tenant, key="rack_units", label="Units", type="integer",
            applies_to=["device"],
        )
        self.sw1 = _make_device(self.tenant, "sw1")
        self.sw1.role = self.switch
        self.sw1.site = self.ams
        self.sw1.custom_fields = {"rack_units": 1}
        self.sw1.save()
        self.sw1.tags.add(self.prod)
        self.srv1 = _make_device(self.tenant, "srv1")
        self.srv1.role = self.server
        self.srv1.site = self.lon
        self.srv1.status = self.active
        self.srv1.custom_fields = {"owner": "ann", "rack_units": 2}
        self.srv1.save()
        self.srv1.tags.add(self.prod, self.pci)
        ctype = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="C", type=ctype)
        self.vm1 = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1", role=self.server, site=self.ams, cluster=self.cluster,
            custom_fields={"owner": ""},
        )
        self.vm2 = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm2", custom_fields={"owner": "bob"}, cluster=self.cluster,
        )
        self.parent = DeviceProfile.objects.create(tenant=self.tenant, name="RDS", slug="rds")
        self.child = DeviceProfile.objects.create(
            tenant=self.tenant, name="RDS-HR", slug="rds-hr", parent=self.parent
        )
        DeviceProfileAssignment.objects.create(
            tenant=self.tenant, profile=self.child, device=self.srv1
        )
        DeviceProfileAssignment.objects.create(
            tenant=self.tenant, profile=self.parent, virtual_machine=self.vm1
        )

    def rule(self, types, condition=None, scope=None, check="expression", **kw):
        return ComplianceRule.objects.create(
            tenant=self.tenant, name=kw.pop("name", "R"), object_types=list(types),
            check_type=check, condition=condition, scope=scope, **kw,
        )

    def failing(self, rule):
        res = evaluate(self.tenant, rules=[rule], triage={})
        return {v["object_repr"] for v in res["violations"]}, res["rules"][0]


class CompileTests(_World, TestCase):
    def setUp(self):
        self.build()
        self.reg = Registry(self.tenant)

    def matches(self, object_type, ast):
        from .engine import Plan, _models

        plan = Plan(self.tenant, [])
        q = compile_q(ast, self.reg.field_on(object_type), object_type, plan.expand)
        model = _models()[object_type]
        return set(model.objects.filter(tenant=self.tenant).filter(q).values_list(
            "name", flat=True
        ))

    def test_ref_in_and_not_in(self):
        self.assertEqual(self.matches("device", cmp("role", "in", self.server.id)), {"srv1"})
        self.assertEqual(self.matches("virtualmachine", cmp("role", "in", self.server.id)),
                         {"vm1"})
        # A VM without a role is none of them.
        self.assertEqual(
            self.matches("virtualmachine", cmp("role", "not_in", self.server.id)), {"vm2"}
        )

    def test_region_through_the_site(self):
        self.assertEqual(self.matches("device", cmp("region", "in", self.eu.id)), {"sw1"})
        self.assertEqual(self.matches("virtualmachine", cmp("region", "not_in", self.eu.id)),
                         {"vm2"})

    def test_strings_are_case_insensitive_and_regex_runs_in_postgres(self):
        self.assertEqual(self.matches("device", cmp("name", "=", value="SW1")), {"sw1"})
        self.assertEqual(self.matches("device", cmp("name", "~", value="RV")), {"srv1"})
        self.assertEqual(self.matches("device", cmp("name", "matches", value="^s[a-z]1$")),
                         {"sw1"})
        self.assertEqual(
            self.matches("device", cmp("name", "not_matches", value="^sw")), {"srv1"}
        )

    def test_tags_any_and_none(self):
        self.assertEqual(self.matches("device", cmp("tags", "in", self.pci.id)), {"srv1"})
        # not_in means "carries none of them".
        self.assertEqual(self.matches("device", cmp("tags", "not_in", self.pci.id)), {"sw1"})
        self.assertEqual(self.matches("virtualmachine", empty("tags")), {"vm1", "vm2"})
        self.assertEqual(self.matches("device", empty("tags", negated=True)), {"sw1", "srv1"})

    def test_profile_includes_child_profiles(self):
        self.assertEqual(self.matches("device", cmp("profile", "in", self.parent.id)), {"srv1"})
        self.assertEqual(self.matches("virtualmachine", cmp("profile", "in", self.parent.id)),
                         {"vm1"})
        self.assertEqual(self.matches("device", cmp("profile", "in", self.child.id)), {"srv1"})
        self.assertEqual(self.matches("virtualmachine", cmp("profile", "in", self.child.id)),
                         set())
        self.assertEqual(self.matches("device", cmp("profile_state", "in", "ok")), {"srv1"})

    def test_custom_fields(self):
        self.assertEqual(self.matches("device", empty("cf.owner")), {"sw1"})
        # "" reads as empty, like a missing key.
        self.assertEqual(self.matches("virtualmachine", empty("cf.owner")), {"vm1"})
        self.assertEqual(self.matches("device", cmp("cf.rack_units", ">", value="1")), {"srv1"})

    def test_a_field_the_type_lacks_reads_as_empty(self):
        dt = str(self.sw1.device_type_id)
        self.assertEqual(self.matches("virtualmachine", cmp("device_type", "in", dt)), set())
        self.assertEqual(self.matches("virtualmachine", cmp("device_type", "not_in", dt)),
                         {"vm1", "vm2"})
        self.assertEqual(self.matches("virtualmachine", empty("device_type")), {"vm1", "vm2"})
        self.assertEqual(self.matches("virtualmachine", empty("device_type", True)), set())

    def test_nested_and_or_with_the_type_field(self):
        ast = group(
            "or",
            group("and", cmp("type", "in", "device"), cmp("role", "in", self.switch.id)),
            cmp("type", "in", "virtualmachine"),
        )
        self.assertEqual(self.matches("device", ast), {"sw1"})
        self.assertEqual(self.matches("virtualmachine", ast), {"vm1", "vm2"})


class ValidateTests(TestCase):
    FIELDS = {
        "name": FieldDef(key="name", label="Name", kind="string", path="name"),
        "n": FieldDef(key="n", label="N", kind="number", path="n"),
        "role": FieldDef(key="role", label="Role", kind="ref", path="role", ref="devicerole"),
    }

    def check(self, ast):
        return validate(ast, self.FIELDS.get)

    def paths(self, ast):
        with self.assertRaises(ExpressionError) as ctx:
            self.check(ast)
        return [e["path"] for e in ctx.exception.errors]

    def test_unknown_field_and_wrong_operator_name_their_path(self):
        self.assertEqual(self.paths(group("and", cmp("name", "=", value="a"),
                                          cmp("nope", "=", value="b"))),
                         ["terms.1.field"])
        self.assertEqual(self.paths(cmp("n", "~", value="1")), ["cmp"])
        self.assertEqual(self.paths(cmp("n", ">", value="ten")), ["value"])

    def test_limits(self):
        deep = cmp("name", "=", value="a")
        for _ in range(MAX_DEPTH):
            deep = group("and", deep)
        self.assertTrue(self.paths(deep))
        many = group("and", *[cmp("name", "=", value=str(i)) for i in range(MAX_LEAVES + 1)])
        self.assertTrue(self.paths(many))
        wide = cmp("role", "in", *[f"00000000-0000-0000-0000-{i:012d}"
                                   for i in range(MAX_VALUES + 1)])
        self.assertEqual(self.paths(wide), ["values"])
        self.assertTrue(self.paths(cmp("name", "=", value="x" * 300)))

    def test_clean_copy_types_values(self):
        out = self.check(cmp("n", ">=", value=" 7 "))
        self.assertEqual(out["value"], "7")


class _Api(_World, APITestCase):
    def setUp(self):
        self.build()
        self.user = self.login_as(
            "admin",
            ["compliancerule", "compliancetriage", "device", "virtualmachine", "site", "tag",
             "devicerole", "region", "deviceprofile", "prefix"],
            ["view", "add", "change", "delete"],
        )

    def login_as(self, name, types, actions, sites=()):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name=name, object_types=types, actions=actions)
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        return user

    def body(self, **kw):
        return {
            "name": "Owners", "object_types": ["device", "virtualmachine"],
            "check_type": "expression", "condition": empty("cf.owner", negated=True), **kw,
        }


class RuleApiTests(_Api):
    def test_create_read_and_refs(self):
        r = self.client.post(RULES, self.body(scope=cmp("role", "in", self.server.id)),
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["object_types"], ["device", "virtualmachine"])
        self.assertEqual(body["object_type"], "device")
        self.assertEqual(body["refs"][str(self.server.id)]["name"], "Server")
        self.assertEqual(body["refs"][str(self.server.id)]["color"], "2f6fdd")
        listed = self.client.get(RULES).json()["results"][0]
        self.assertIn(str(self.server.id), listed["refs"])

    def test_old_single_type_write_still_works(self):
        r = self.client.post(RULES, {
            "name": "Desc", "object_type": "prefix", "check_type": "required",
            "field": "description",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["object_types"], ["prefix"])

    def test_another_tenants_id_is_refused_with_its_path(self):
        r = self.client.post(RULES, self.body(
            condition=group("or", empty("cf.owner", True), cmp("tags", "in", self.foreign_tag.id))
        ), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["condition"][0]["path"], "terms.1.values.0")
        self.assertFalse(ComplianceRule.objects.exists())

    def test_tag_ids_are_numbers_and_malformed_ids_are_refused(self):
        ok = self.client.post(RULES, self.body(scope=cmp("tags", "in", self.pci.id)),
                              format="json")
        self.assertEqual(ok.status_code, 201, ok.content)
        self.assertEqual(ok.json()["refs"][str(self.pci.id)]["name"], "pci")
        bad = self.client.post(RULES, self.body(scope=cmp("role", "in", "not-a-uuid")),
                               format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(bad.json()["scope"][0]["detail"], "Not a valid id.")

    def test_a_site_outside_the_writers_sites_is_refused(self):
        self.login_as("ams-admin", ["compliancerule", "site", "device"],
                      ["view", "add", "change"], sites=[self.ams])
        ok = self.client.post(RULES, self.body(scope=cmp("site", "in", self.ams.id)),
                              format="json")
        self.assertEqual(ok.status_code, 201, ok.content)
        bad = self.client.post(RULES, self.body(scope=cmp("site", "in", self.lon.id)),
                               format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(bad.json()["scope"][0]["path"], "values.0")

    def test_field_on_no_chosen_type_and_unsuited_check(self):
        r = self.client.post(RULES, self.body(
            object_types=["prefix"], condition=cmp("vcpus", ">", value="2")
        ), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["condition"][0]["path"], "field")
        r = self.client.post(RULES, {
            "name": "c", "object_types": ["device", "virtualmachine"], "check_type": "coverage",
            "coverage_fail_on": "expired",
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("object_types", r.json())

    def test_invalid_regex_is_refused_with_postgres_message(self):
        r = self.client.post(RULES, self.body(condition=cmp("name", "matches", value="(a")),
                             format="json")
        self.assertEqual(r.status_code, 400)
        err = r.json()["condition"][0]
        self.assertEqual(err["path"], "value")
        self.assertIn("parenthes", err["detail"].lower())

    def test_removing_a_type_drops_its_triage(self):
        rule = self.rule(["device", "virtualmachine"], empty("cf.owner", True))
        ComplianceTriage.objects.create(tenant=self.tenant, rule=rule, object_type="device",
                                        object_id=self.sw1.id)
        ComplianceTriage.objects.create(tenant=self.tenant, rule=rule,
                                        object_type="virtualmachine", object_id=self.vm1.id)
        r = self.client.patch(f"{RULES}{rule.id}/", {"object_types": ["device"]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(list(ComplianceTriage.objects.values_list("object_type", flat=True)),
                         ["device"])

    def test_fields_endpoint(self):
        r = self.client.get(FIELDS, {"object_types": "device,virtualmachine"})
        self.assertEqual(r.status_code, 200)
        fields = {f["key"]: f for f in r.json()["fields"]}
        self.assertEqual(fields["role"]["types"], ["device", "virtualmachine"])
        self.assertEqual(fields["device_type"]["types"], ["device"])
        self.assertEqual(fields["vcpus"]["types"], ["virtualmachine"])
        self.assertEqual(fields["cf.owner"]["types"], ["device", "virtualmachine"])
        self.assertEqual(fields["status"]["ref"]["badge"], "status")
        self.assertIn("in", fields["tags"]["ops"])
        self.assertEqual(fields["type"]["kind"], "type")
        self.assertEqual(self.client.get(FIELDS, {"object_types": "nope"}).status_code, 400)


class PreviewTests(_Api):
    def test_counts_and_sample_per_type(self):
        r = self.client.post(PREVIEW, self.body(), format="json")
        self.assertEqual(r.status_code, 200, r.content)
        by_type = r.json()["by_type"]
        self.assertEqual(by_type["device"], {
            "in_scope": 2, "failing": 1,
            "sample": [{"id": str(self.sw1.id), "repr": "sw1", "site_name": "AMS"}],
        })
        self.assertEqual(by_type["virtualmachine"]["in_scope"], 2)
        self.assertEqual(by_type["virtualmachine"]["failing"], 1)
        self.assertFalse(ComplianceRule.objects.exists())

    def test_counts_only_what_the_caller_may_view(self):
        self.login_as("ams", ["compliancerule", "device", "virtualmachine"],
                      ["view", "add"], sites=[self.ams])
        r = self.client.post(PREVIEW, self.body(condition=cmp("name", "=", value="none")),
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        by_type = r.json()["by_type"]
        # LON's server and the site-less VM are not the caller's to count…
        self.assertEqual(by_type["device"]["in_scope"], 1)
        self.assertEqual({s["repr"] for s in by_type["device"]["sample"]}, {"sw1"})
        # …the shared (site-less) VM is viewable, like on the VM list.
        self.assertEqual(by_type["virtualmachine"]["failing"], 2)

    def test_needs_add_or_change(self):
        self.login_as("viewer", ["compliancerule", "device"], ["view"])
        self.assertEqual(self.client.post(PREVIEW, self.body(), format="json").status_code, 403)


class EngineTests(_World, TestCase):
    def setUp(self):
        self.build()

    def test_mixed_types_report_each_objects_own_type(self):
        rule = self.rule(["device", "virtualmachine"], empty("cf.owner", True))
        res = evaluate(self.tenant, rules=[rule], triage={})
        got = {(v["object_type"], v["object_repr"]) for v in res["violations"]}
        self.assertEqual(got, {("device", "sw1"), ("virtualmachine", "vm1")})
        row = res["rules"][0]
        self.assertEqual(row["by_type"], {"device": 1, "virtualmachine": 1})
        self.assertEqual(row["object_type_label"], "Device, Virtual machine")
        self.assertIsNone(row["error"])

    def test_counts_are_whole_past_the_list_cap(self):
        rule = self.rule(["device", "virtualmachine"], cmp("name", "=", value="none"))
        res = evaluate(self.tenant, rules=[rule], triage={}, list_cap=1)
        self.assertEqual(res["rules"][0]["violations"], 4)
        self.assertEqual(len(res["violations"]), 1)
        self.assertEqual(len(res["failing_objects"]), 4)

    def test_queries_per_rule_and_type_do_not_grow_with_rows(self):
        rule = self.rule(["device"], cmp("name", "=", value="none"))
        with CaptureQueriesContext(connection) as few:
            evaluate(self.tenant, rules=[rule], triage={})
        for i in range(5):
            _make_device(self.tenant, f"more{i}")
        with CaptureQueriesContext(connection) as more:
            res = evaluate(self.tenant, rules=[rule], triage={})
        self.assertEqual(res["rules"][0]["violations"], 7)
        self.assertEqual(len(few), len(more))

    def test_scope_narrows_a_python_check(self):
        Platform.objects.create(tenant=self.tenant, name="IOS", slug="ios", target_version="17")
        for d in (self.sw1, self.srv1):
            d.platform = Platform.objects.get(slug="ios")
            d.software_version = "16"
            d.save()
        rule = self.rule(["device"], check="software_target",
                         scope=cmp("role", "in", self.server.id))
        names, row = self.failing(rule)
        self.assertEqual(names, {"srv1"})
        self.assertEqual(row["violations"], 1)

    def test_a_deleted_reference_breaks_the_rule(self):
        role = DeviceRole.objects.create(tenant=self.tenant, name="Gone", slug="gone")
        rule = self.rule(["device"], empty("cf.owner", True), scope=cmp("role", "in", role.id))
        role.delete()
        names, row = self.failing(rule)
        self.assertEqual(names, set())
        self.assertEqual(row["violations"], 0)
        self.assertIn("no longer exists", row["error"])

    def test_a_timeout_reads_as_an_error_not_a_pass(self):
        rule = self.rule(["device"], cmp("name", "=", value="none"))
        boom = OperationalError("canceling statement due to statement timeout")
        with mock.patch.object(engine, "_failing_qs", side_effect=boom):
            names, row = self.failing(rule)
        self.assertEqual(names, set())
        self.assertEqual(row["error"], "The rule took too long to evaluate.")

    def test_statement_timeout_applies_inside_and_is_restored(self):
        def current():
            with connection.cursor() as cur:
                cur.execute("SELECT current_setting('statement_timeout')")
                return cur.fetchone()[0]

        before = current()
        with statement_timeout(1234):
            self.assertEqual(current(), "1234ms")
        self.assertEqual(current(), before)

    def test_evaluate_for_object_answers_devices_and_vms(self):
        rule = self.rule(["device", "virtualmachine"], empty("cf.owner", True),
                         scope=cmp("tags", "not_in", self.pci.id))
        self.assertEqual(evaluate_for_object(self.tenant, "device", self.sw1), [rule])
        self.assertEqual(evaluate_for_object(self.tenant, "device", self.srv1), [])
        self.assertEqual(evaluate_for_object(self.tenant, "virtualmachine", self.vm1), [rule])
        self.assertEqual(evaluate_for_object(self.tenant, "virtualmachine", self.vm2), [])

    def test_leaving_the_scope_clears_an_acknowledgement(self):
        from django.utils import timezone

        rule = self.rule(["virtualmachine"], empty("cf.owner", True),
                         scope=cmp("role", "in", self.server.id))
        ComplianceTriage.objects.create(
            tenant=self.tenant, rule=rule, object_type="virtualmachine",
            object_id=self.vm1.id, acknowledged_at=timezone.now(),
        )
        evaluate(self.tenant, rules=[rule])
        self.assertTrue(ComplianceTriage.objects.exists())
        self.vm1.role = None
        self.vm1.save()
        evaluate(self.tenant, rules=[rule])
        self.assertFalse(ComplianceTriage.objects.exists())


class TriageMultiTypeTests(_Api):
    def test_object_found_among_the_rules_types(self):
        rule = self.rule(["device", "virtualmachine"], empty("cf.owner", True))
        r = self.client.post(TRIAGE, {"action": "acknowledge", "items": [
            {"rule_id": str(rule.id), "object_id": str(self.vm1.id)},
            {"rule_id": str(rule.id), "object_id": str(self.sw1.id)},
        ]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            dict(ComplianceTriage.objects.values_list("object_id", "object_type")),
            {self.vm1.id: "virtualmachine", self.sw1.id: "device"},
        )

    def test_an_object_of_another_type_or_site_is_refused(self):
        rule = self.rule(["device"], empty("cf.owner", True))
        r = self.client.post(TRIAGE, {"action": "acknowledge", "items": [
            {"rule_id": str(rule.id), "object_id": str(self.vm1.id)},
        ]}, format="json")
        self.assertEqual(r.status_code, 400)
        self.login_as("ams", ["compliancetriage", "device"], ["view", "change"],
                      sites=[self.ams])
        r = self.client.post(TRIAGE, {"action": "acknowledge", "items": [
            {"rule_id": str(rule.id), "object_id": str(self.srv1.id)},
        ]}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(ComplianceTriage.objects.exists())


class MigrationTests(_World, TestCase):
    """0009 gives each rule written before it ``[object_type]``; the rule
    then judges exactly what it judged before."""

    def setUp(self):
        self.build()

    def test_old_rules_are_unchanged(self):
        import importlib

        from django.apps import apps

        fill = importlib.import_module(
            "compliance.migrations.0009_rule_scope"
        ).fill_object_types
        Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", description="x")
        Prefix.objects.create(tenant=self.tenant, cidr="10.0.1.0/24")
        legacy = [
            ("prefix", {"check_type": "required", "field": "description"}),
            ("device", {"check_type": "forbidden", "field": "asset_tag"}),
            ("device", {"check_type": "regex", "field": "name", "pattern": "^sw"}),
            ("device", {"check_type": "required_tag", "tag": "pci"}),
            ("virtualmachine", {"check_type": "required_cf", "cf_key": "owner"}),
            ("device", {"check_type": "software_target"}),
        ]
        rules = [
            ComplianceRule.objects.create(tenant=self.tenant, name=f"r{i}", object_type=t, **kw)
            for i, (t, kw) in enumerate(legacy)
        ]
        # As the release before 0009 left them: no list of types.
        ComplianceRule.objects.update(object_types=[])
        before = evaluate(self.tenant, rules=list(ComplianceRule.objects.all()), triage={})
        fill(apps, None)
        fill(apps, None)  # a second run changes nothing
        after_rules = list(ComplianceRule.objects.all())
        self.assertEqual({tuple(r.object_types) for r in after_rules},
                         {(t,) for t, _ in legacy})
        after = evaluate(self.tenant, rules=after_rules, triage={})
        strip = lambda res: sorted(  # noqa: E731
            (v["rule_name"], v["object_type"], v["object_repr"]) for v in res["violations"]
        )
        self.assertEqual(strip(before), strip(after))
        self.assertEqual(
            {r["name"]: r["violations"] for r in before["rules"]},
            {r["name"]: r["violations"] for r in after["rules"]},
        )
        self.assertEqual(len(rules), len(after_rules))

