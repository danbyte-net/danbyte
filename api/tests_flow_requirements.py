"""Application flow requirements: the resolver (pairs, address modes,
pairing, states, idempotence, fan-out), its triggers, hand edits, detach,
exclusions, tenant and site scope, the change-log cause and the job."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from django.test import override_settings
from rest_framework.test import APITestCase

from api import applications as groups
from api import flow_requirements as fr
from api.models import (
    Application,
    ApplicationFlow,
    ApplicationFlowRequirement,
    ApplicationFlowRequirementExclusion,
    ApplicationGroup,
    Device,
    InstalledSoftware,
    IPAddress,
    IPRole,
    Prefix,
    Service,
    Site,
)
from api.status_registry import seed_builtin_statuses
from audit.context import clear_context, set_context
from audit.models import ChangeLogEntry, JournalEntry
from auth_api.api import assemble_site_role
from auth_api.models import UserProfile
from core.models import Organization, Tenant

REQS = "/api/application-flow-requirements/"
FLOWS = "/api/application-flows/"


class _Base(APITestCase):
    def setUp(self):
        fr._local.pending = None
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        seed_builtin_statuses(self.tenant)
        seed_builtin_statuses(self.other)
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.net_a = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/24",
                                           site=self.site_a)
        self.net_b = Prefix.objects.create(tenant=self.tenant, cidr="10.2.0.0/24",
                                           site=self.site_b)
        self.wms1 = self._host("wms-1", self.site_a, "10.1.0.11")
        self.wms2 = self._host("wms-2", self.site_a, "10.1.0.12")
        self.wms3 = Device.objects.create(tenant=self.tenant, name="wms-3", site=self.site_b)
        self.broker_a = self._host("broker-a", self.site_a, "10.1.0.5")
        self.broker_b = self._host("broker-b", self.site_b, "10.2.0.5", net=self.net_b)
        self.wms = Application.objects.create(tenant=self.tenant, name="WMS client",
                                              slug="wms")
        self.broker = Application.objects.create(tenant=self.tenant, name="Broker",
                                                 slug="broker")
        for d in (self.wms1, self.wms2, self.wms3):
            InstalledSoftware.objects.create(tenant=self.tenant, application=self.wms, device=d)
        for d in (self.broker_a, self.broker_b):
            InstalledSoftware.objects.create(tenant=self.tenant, application=self.broker,
                                             device=d)
        self.admin = User.objects.create_superuser("req-root", password="x")
        self.login(self.admin)

    def _host(self, name, site, addr, net=None):
        d = Device.objects.create(tenant=self.tenant, name=name, site=site)
        ip = IPAddress.objects.create(tenant=self.tenant, prefix=net or self.net_a,
                                      ip_address=addr, assigned_device=d)
        d.primary_ip = ip
        d.save()
        return d

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def requirement(self, **kw):
        data = {"tenant": self.tenant, "application": self.wms, "name": "WMS to Broker",
                "source_kind": "self", "source_address": "primary",
                "destination_kind": "app", "destination_application": self.broker,
                "destination_address": "service", "protocol": "tcp", "ports": "5672"}
        data.update(kw)
        return ApplicationFlowRequirement.objects.create(**data)

    def rows(self, req):
        return {f.binding_key: f for f in ApplicationFlow.objects.filter(requirement=req)}

    def pairs(self, req):
        return sorted(
            (f.source_ip.ip_address, f.destination_ip.ip_address)
            for f in ApplicationFlow.objects.filter(requirement=req)
            .select_related("source_ip", "destination_ip")
        )

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None


class ResolverTests(_Base):
    def test_every_pair_partial_for_a_host_without_address(self):
        req = self.requirement()
        out = fr.resolve(req)
        self.assertEqual(out["created"], 4)
        self.assertEqual(self.pairs(req), [
            ("10.1.0.11", "10.1.0.5"), ("10.1.0.11", "10.2.0.5"),
            ("10.1.0.12", "10.1.0.5"), ("10.1.0.12", "10.2.0.5"),
        ])
        req.refresh_from_db()
        self.assertEqual((req.state, req.generated_count, req.gap_count), ("partial", 4, 1))
        flow = ApplicationFlow.objects.filter(requirement=req).select_related(
            "source_install__device").first()
        self.assertTrue(flow.generated)
        self.assertEqual(flow.application, self.wms)
        self.assertEqual(flow.status.slug, "active")
        self.assertIn(flow.source_install.device.name, flow.name)
        self.assertTrue(flow.name.startswith("WMS to Broker: "))

    def test_a_second_run_writes_nothing(self):
        req = self.requirement()
        fr.resolve(req)
        before = ChangeLogEntry.objects.filter(object_type="api.applicationflow").count()
        out = fr.resolve(req)
        self.assertEqual((out["created"], out["updated"], out["removed"], out["released"]),
                         (0, 0, 0, 0))
        self.assertEqual(
            ChangeLogEntry.objects.filter(object_type="api.applicationflow").count(), before)

    def test_same_site_pairs_only_hosts_at_one_site(self):
        req = self.requirement(pairing="same_site")
        fr.resolve(req)
        self.assertEqual(self.pairs(req), [("10.1.0.11", "10.1.0.5"),
                                           ("10.1.0.12", "10.1.0.5")])

    def test_far_app_not_installed_is_unresolved(self):
        cache = Application.objects.create(tenant=self.tenant, name="Cache", slug="cache")
        req = self.requirement(destination_application=cache)
        fr.resolve(req)
        req.refresh_from_db()
        self.assertEqual(req.state, "unresolved")
        self.assertIn("Cache is not installed anywhere", req.state_detail)
        self.assertEqual(req.generated_count, 0)

    def test_this_app_not_installed_is_idle(self):
        lonely = Application.objects.create(tenant=self.tenant, name="Lonely", slug="lonely")
        req = self.requirement(application=lonely)
        fr.resolve(req)
        req.refresh_from_db()
        self.assertEqual(req.state, "idle")

    def test_self_to_self_never_pairs_a_host_with_itself(self):
        req = self.requirement(name="peers", application=self.broker, destination_kind="self",
                               destination_application=None, destination_address="primary",
                               ports="25672")
        fr.resolve(req)
        self.assertEqual(self.pairs(req), [("10.1.0.5", "10.2.0.5"), ("10.2.0.5", "10.1.0.5")])

    def test_fixed_destination_and_role_and_family(self):
        vip = IPRole.objects.create(tenant=self.tenant, name="VIP", slug="vip")
        IPAddress.objects.create(tenant=self.tenant, prefix=self.net_a, ip_address="10.1.0.99",
                                 assigned_device=self.wms1, role=vip)
        IPAddress.objects.create(tenant=self.tenant, prefix=self.net_a, ip_address="fd00::1",
                                 assigned_device=self.wms1, role=vip)
        req = self.requirement(source_address="role", source_address_role=vip,
                               destination_kind="prefix", destination_application=None,
                               destination_prefix=self.net_b, destination_address="",
                               family="ipv4")
        fr.resolve(req)
        flows = list(ApplicationFlow.objects.filter(requirement=req).select_related(
            "source_ip"))
        self.assertEqual([(f.source_ip.ip_address, f.destination_prefix_id) for f in flows],
                         [("10.1.0.99", self.net_b.pk)])
        req.refresh_from_db()
        self.assertEqual(req.state, "partial")  # wms-2 and wms-3 have no VIP

    def test_service_mode_uses_the_install_service_address(self):
        alt = IPAddress.objects.create(tenant=self.tenant, prefix=self.net_a,
                                       ip_address="10.1.0.55", assigned_device=self.broker_a)
        svc = Service.objects.create(tenant=self.tenant, device=self.broker_a, name="amqp",
                                     ports=[5672], ip_address=alt)
        inst = InstalledSoftware.objects.get(device=self.broker_a)
        inst.service = svc
        inst.save()
        req = self.requirement()
        fr.resolve(req)
        flow = ApplicationFlow.objects.get(requirement=req, source_ip__ip_address="10.1.0.11",
                                           destination_ip__ip_address="10.1.0.55")
        self.assertEqual(flow.service, svc)

    @override_settings(FLOW_REQUIREMENT_MAX_PAIRS=3, FLOW_REQUIREMENT_WARN_PAIRS=2)
    def test_fan_out_is_refused_above_the_cap(self):
        req = self.requirement()
        out = fr.resolve(req)
        self.assertEqual(out["created"], 0)
        req.refresh_from_db()
        self.assertEqual(req.state, "unresolved")
        self.assertIn("Too many pairs", req.state_detail)
        p = self.ok(self.client.post(REQS + "preview/", self._payload(name="other"), format="json"))
        self.assertTrue(p["refused"])
        self.assertTrue(p["warn"])

    @override_settings(FLOW_REQUIREMENT_WARN_PAIRS=3)
    def test_preview_warns_and_counts(self):
        p = self.ok(self.client.post(REQS + "preview/", self._payload(), format="json"))
        self.assertEqual((p["pairs"], p["warn"], p["refused"]), (4, True, False))
        self.assertEqual(p["gaps"], [{"side": "source", "reason": "no address",
                                      "host": {"kind": "device", "id": str(self.wms3.pk),
                                               "name": "wms-3"}}])
        self.assertFalse(ApplicationFlowRequirement.objects.exists())

    def _payload(self, **kw):
        data = {"application_id": str(self.wms.pk), "name": "WMS to Broker",
                "source_kind": "self", "destination_kind": "app",
                "destination_application_id": str(self.broker.pk),
                "protocol": "tcp", "ports": "5672"}
        data.update(kw)
        return data

    def test_release_keeps_edited_rows_with_a_journal(self):
        req = self.requirement()
        fr.resolve(req)
        edited = ApplicationFlow.objects.filter(requirement=req).first()
        edited.overridden_fields = ["ports"]
        edited.ports = "5671"
        edited.save()
        counts = fr.release_all(req)
        self.assertEqual(counts, {"removed": 3, "released": 1})
        edited.refresh_from_db()
        self.assertEqual((edited.generated, edited.requirement_id, edited.ports),
                         (False, None, "5671"))
        self.assertTrue(JournalEntry.objects.filter(
            object_id=str(edited.pk), comments__contains="stopped applying").exists())


class TriggerTests(_Base):
    def setUp(self):
        super().setUp()
        self.req = self.requirement()
        fr.resolve(self.req)

    def test_install_added_and_removed(self):
        new = self._host("wms-4", self.site_a, "10.1.0.14")
        with self.captureOnCommitCallbacks(execute=True):
            r = self.ok(self.client.post("/api/installed-software/", {
                "application_id": str(self.wms.pk), "device_id": str(new.pk)},
                format="json"), 201)
        self.assertIn(("10.1.0.14", "10.1.0.5"), self.pairs(self.req))
        with self.captureOnCommitCallbacks(execute=True):
            self.ok(self.client.delete(f"/api/installed-software/{r['id']}/"), 204)
        self.assertNotIn(("10.1.0.14", "10.1.0.5"), self.pairs(self.req))

    def test_far_app_moves(self):
        with self.captureOnCommitCallbacks(execute=True):
            InstalledSoftware.objects.filter(device=self.broker_b).delete()
        self.assertEqual({d for _s, d in self.pairs(self.req)}, {"10.1.0.5"})

    def test_group_assignment_installs_and_documents(self):
        group = ApplicationGroup.objects.create(tenant=self.tenant, name="WH", slug="wh")
        groups.add_member(group, self.wms)
        host = self._host("wms-9", self.site_a, "10.1.0.19")
        with self.captureOnCommitCallbacks(execute=True):
            assignment, _ = groups.assign_group(group, device=host)
        self.assertIn(("10.1.0.19", "10.2.0.5"), self.pairs(self.req))
        with self.captureOnCommitCallbacks(execute=True):
            groups.unassign_group(assignment)
        self.assertNotIn(("10.1.0.19", "10.2.0.5"), self.pairs(self.req))

    def test_an_address_added_changed_and_deleted(self):
        with self.captureOnCommitCallbacks(execute=True):
            ip = IPAddress.objects.create(tenant=self.tenant, prefix=self.net_b,
                                          ip_address="10.2.0.33", assigned_device=self.wms3)
        self.assertIn(("10.2.0.33", "10.1.0.5"), self.pairs(self.req))
        self.req.refresh_from_db()
        self.assertEqual(self.req.state, "resolved")
        with self.captureOnCommitCallbacks(execute=True):
            ip.ip_address = "10.2.0.34"
            ip.save()
        self.assertIn(("10.2.0.34", "10.1.0.5"), self.pairs(self.req))
        self.assertNotIn(("10.2.0.33", "10.1.0.5"), self.pairs(self.req))
        with self.captureOnCommitCallbacks(execute=True):
            ip.delete()
        self.assertFalse(any(s == "10.2.0.34" for s, _d in self.pairs(self.req)))
        self.req.refresh_from_db()
        self.assertEqual(self.req.state, "partial")

    def test_primary_address_change(self):
        second = IPAddress.objects.create(tenant=self.tenant, prefix=self.net_a,
                                          ip_address="10.1.0.21", assigned_device=self.wms1)
        with self.captureOnCommitCallbacks(execute=True):
            self.wms1.primary_ip = second
            self.wms1.save()
        sources = {s for s, _d in self.pairs(self.req)}
        self.assertIn("10.1.0.21", sources)
        self.assertNotIn("10.1.0.11", sources)

    def test_site_change_with_same_site_pairing(self):
        self.req.pairing = "same_site"
        self.req.save()
        fr.resolve(self.req)
        with self.captureOnCommitCallbacks(execute=True):
            self.wms2.site = self.site_b
            self.wms2.save()
        self.assertIn(("10.1.0.12", "10.2.0.5"), self.pairs(self.req))
        self.assertNotIn(("10.1.0.12", "10.1.0.5"), self.pairs(self.req))

    def test_service_address_change(self):
        svc = Service.objects.create(tenant=self.tenant, device=self.broker_a, name="amqp",
                                     ports=[5672])
        inst = InstalledSoftware.objects.get(device=self.broker_a)
        with self.captureOnCommitCallbacks(execute=True):
            inst.service = svc
            inst.save()
        alt = IPAddress.objects.create(tenant=self.tenant, prefix=self.net_a,
                                       ip_address="10.1.0.56", assigned_device=self.broker_a)
        with self.captureOnCommitCallbacks(execute=True):
            svc.ip_address = alt
            svc.save()
        self.assertIn(("10.1.0.11", "10.1.0.56"), self.pairs(self.req))
        self.assertNotIn(("10.1.0.11", "10.1.0.5"), self.pairs(self.req))

    def test_requirement_edit_through_the_api(self):
        r = self.ok(self.client.patch(f"{REQS}{self.req.pk}/", {"ports": "5671"},
                                      format="json"))
        self.assertEqual(r["resolution"]["updated"], 4)
        self.assertEqual(set(ApplicationFlow.objects.filter(requirement=self.req)
                             .values_list("ports", flat=True)), {"5671"})

    def test_the_sweep_heals_a_queryset_update(self):
        IPAddress.objects.filter(assigned_device=self.wms2).update(assigned_device=None)
        Device.objects.filter(pk=self.wms2.pk).update(primary_ip=None)
        out = fr.reconcile_all()
        self.assertEqual(out["removed"], 2)
        self.assertFalse(any(s == "10.1.0.12" for s, _d in self.pairs(self.req)))
        entry = ChangeLogEntry.objects.filter(object_type="api.applicationflow",
                                              action="delete").first()
        self.assertEqual((entry.via, entry.user_id), ("system", None))
        self.assertIn("nightly sweep", entry.cause)


class ApiTests(_Base):
    def test_create_resolves_and_reads(self):
        r = self.ok(self.client.post(REQS, {
            "application_id": str(self.wms.pk), "name": "WMS to Broker",
            "source_kind": "self", "destination_kind": "app",
            "destination_application_id": str(self.broker.pk), "ports": "5672",
        }, format="json"), 201)
        self.assertEqual(r["resolution"]["created"], 4)
        self.assertEqual(r["state"], "partial")
        self.assertEqual(r["source"]["label"], "This application")
        self.assertEqual(r["destination"]["label"], "Hosts of Broker")
        self.assertEqual(r["destination_address"], "service")
        gaps = self.ok(self.client.get(f"{REQS}{r['id']}/gaps/"))
        self.assertEqual([g["host"]["name"] for g in gaps["gaps"]], ["wms-3"])
        flows = self.ok(self.client.get(f"{FLOWS}?requirement={r['id']}"))["results"]
        self.assertEqual(len(flows), 4)
        self.assertTrue(all(f["generated"] for f in flows))
        self.assertEqual(flows[0]["requirement"]["name"], "WMS to Broker")
        self.assertEqual(flows[0]["source_install"]["application"], "WMS client")
        self.assertEqual(self.ok(self.client.get(f"{FLOWS}?generated=false"))["count"], 0)
        host = self.ok(self.client.get(f"{REQS}?device={self.wms1.pk}"))["results"]
        self.assertEqual([h["host"]["flows"] for h in host], [2])
        host = self.ok(self.client.get(f"{REQS}?device={self.wms3.pk}"))["results"]
        self.assertEqual(host[0]["host"]["reason"], "no address")
        refs = self.ok(self.client.get(f"{REQS}?references={self.broker.pk}"))["results"]
        self.assertEqual(len(refs), 1)

    def test_validation(self):
        bad = self.client.post(REQS, {
            "application_id": str(self.wms.pk), "name": "x", "source_kind": "app",
            "source_application_id": str(self.broker.pk), "destination_kind": "any",
        }, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertIn("source_kind", bad.json())
        bad = self.client.post(REQS, {
            "application_id": str(self.wms.pk), "name": "x", "source_kind": "self",
            "destination_kind": "app", "destination_application_id": str(self.wms.pk),
        }, format="json")
        self.assertIn("destination_application_id", bad.json())
        bad = self.client.post(REQS, {
            "application_id": str(self.wms.pk), "name": "x", "source_kind": "self",
            "destination_kind": "app",
        }, format="json")
        self.assertIn("destination_application_id", bad.json())

    def test_cross_tenant_references_are_refused(self):
        theirs = Application.objects.create(tenant=self.other, name="Broker", slug="broker")
        r = self.client.post(REQS, {
            "application_id": str(self.wms.pk), "name": "x", "source_kind": "self",
            "destination_kind": "app", "destination_application_id": str(theirs.pk),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        # The same slug in another tenant is never a host of this tenant's app.
        dev = Device.objects.create(tenant=self.other, name="their-broker")
        InstalledSoftware.objects.create(tenant=self.other, application=theirs, device=dev)
        req = self.requirement()
        fr.resolve(req)
        self.assertEqual(len(self.pairs(req)), 4)

    def test_ends_of_a_generated_row_are_locked_and_edits_kept(self):
        req = self.requirement()
        fr.resolve(req)
        flow = ApplicationFlow.objects.filter(requirement=req).first()
        r = self.client.patch(f"{FLOWS}{flow.pk}/", {"destination_any": True}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("detach", str(r.json()))
        self.ok(self.client.patch(f"{FLOWS}{flow.pk}/", {"ports": "5671",
                                                          "description": "tls"},
                                  format="json"))
        flow.refresh_from_db()
        self.assertEqual(flow.overridden_fields, ["ports"])
        self.ok(self.client.patch(f"{REQS}{req.pk}/", {"ports": "15672"}, format="json"))
        flow.refresh_from_db()
        self.assertEqual(flow.ports, "5671")
        self.assertEqual(ApplicationFlow.objects.filter(requirement=req, ports="15672")
                         .count(), 3)
        # Follow drops the override.
        r = self.ok(self.client.post(f"{FLOWS}{flow.pk}/follow/"))
        self.assertEqual((r["ports"], r["overridden_fields"]), ("15672", []))

    def test_bulk_status_edit_is_an_override(self):
        req = self.requirement()
        fr.resolve(req)
        flow = ApplicationFlow.objects.filter(requirement=req).first()
        planned = flow.status.__class__.objects.get(tenant=self.tenant, slug="planned",
                                                    available_to__contains=["applicationflow"])
        self.ok(self.client.post(f"{FLOWS}bulk-update/", {
            "ids": [str(flow.pk)], "fields": {"status_id": str(planned.pk)}}, format="json"))
        flow.refresh_from_db()
        self.assertEqual(flow.overridden_fields, ["status"])

    def test_detach_and_exclusion_restore(self):
        req = self.requirement()
        fr.resolve(req)
        flow = ApplicationFlow.objects.filter(requirement=req).first()
        r = self.ok(self.client.post(f"{FLOWS}{flow.pk}/detach/"))
        self.assertFalse(r["generated"])
        self.assertIsNone(r["requirement"])
        fr.resolve(req)
        self.assertEqual(ApplicationFlow.objects.filter(requirement=req).count(), 3)
        self.assertEqual(ApplicationFlow.objects.filter(application=self.wms).count(), 4)

        other = ApplicationFlow.objects.filter(requirement=req).first()
        key = other.binding_key
        self.ok(self.client.delete(f"{FLOWS}{other.pk}/"), 204)
        excl = ApplicationFlowRequirementExclusion.objects.get(requirement=req,
                                                               binding_key=key)
        fr.resolve(req)
        self.assertFalse(ApplicationFlow.objects.filter(requirement=req,
                                                        binding_key=key).exists())
        listed = self.ok(self.client.get(f"{REQS}{req.pk}/"))["exclusions"]
        self.assertEqual(len(listed), 2)
        self.ok(self.client.delete(f"{REQS}{req.pk}/exclusions/{excl.pk}/"), 204)
        self.assertTrue(ApplicationFlow.objects.filter(requirement=req,
                                                       binding_key=key).exists())
        self.assertTrue(JournalEntry.objects.filter(
            object_id=str(req.pk), comments__startswith="Restored").exists())

    def test_change_log_carries_user_request_and_cause(self):
        set_context(self.admin, "req-123", "ui")
        try:
            req = self.requirement()
            fr.resolve(req, reason="install added on wms-1")
        finally:
            clear_context()
        e = ChangeLogEntry.objects.filter(object_type="api.applicationflow",
                                          action="create").first()
        self.assertEqual((e.user_id, e.request_id, e.via), (self.admin.pk, "req-123", "ui"))
        self.assertEqual(e.cause, "Requirement 'WMS to Broker': install added on wms-1")
        r = self.ok(self.client.get(f"/api/changelog/?object_id={e.object_id}"))
        self.assertEqual(r["results"][0]["cause"], e.cause)

    def test_delete_releases_and_application_delete_is_refused(self):
        req = self.requirement()
        fr.resolve(req)
        r = self.client.delete(f"/api/applications/{self.broker.pk}/")
        self.assertEqual(r.status_code, 409)
        self.assertIn("WMS to Broker", r.json()["detail"])
        self.ok(self.client.delete(f"{REQS}{req.pk}/"), 204)
        self.assertFalse(ApplicationFlow.objects.filter(application=self.wms).exists())


class JobTests(_Base):
    def test_large_work_is_queued_with_ids_only(self):
        req = self.requirement()
        with mock.patch.object(fr, "INLINE_PAIRS", 0), \
                mock.patch.object(fr, "enqueue_resolve", return_value="j") as enq, \
                self.captureOnCommitCallbacks(execute=True):
            out = fr.run_or_enqueue(req, reason="r")
        self.assertIn("job", out)
        args = enq.call_args.args
        self.assertEqual((str(args[0]), str(args[1])), (str(self.tenant.pk), str(req.pk)))
        self.assertFalse(ApplicationFlow.objects.filter(requirement=req).exists())

    def test_the_job_re_reads_by_id_within_the_tenant(self):
        req = self.requirement()
        self.assertEqual(fr.run_resolve(str(self.other.pk), str(req.pk), None),
                         {"skipped": "requirement"})
        self.tenant.is_active = False
        self.tenant.save()
        self.assertEqual(fr.run_resolve(str(self.tenant.pk), str(req.pk), None),
                         {"skipped": "tenant"})
        self.tenant.is_active = True
        self.tenant.save()
        out = fr.run_resolve(str(self.tenant.pk), str(req.pk), self.admin.pk,
                             request_id="rq-1", via="api", reason="bulk")
        self.assertEqual(out["created"], 4)
        e = ChangeLogEntry.objects.filter(object_type="api.applicationflow").first()
        self.assertEqual((e.user_id, e.request_id, e.via), (self.admin.pk, "rq-1", "api"))
        pk = str(req.pk)
        req.delete()
        self.assertEqual(fr.run_resolve(str(self.tenant.pk), pk, None),
                         {"skipped": "requirement"})


class SiteScopeTests(_Base):
    def setUp(self):
        super().setUp()
        self.req = self.requirement()
        fr.resolve(self.req)
        self.fixed = self.requirement(name="to B", destination_kind="ip",
                                      destination_application=None,
                                      destination_ip=self.broker_b.primary_ip,
                                      destination_address="")
        fr.resolve(self.fixed)
        self.viewer = User.objects.create_user("viewer-a", password="x")
        UserProfile.objects.create(user=self.viewer).tenants.add(self.tenant)
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.viewer.id])
        self.login(self.viewer)

    def test_generated_flows_show_the_other_site_end_hidden(self):
        rows = self.ok(self.client.get(f"{FLOWS}?requirement={self.req.pk}"))["results"]
        text = str(rows)
        self.assertEqual(len(rows), 4)
        for secret in ("10.2.0.5", "broker-b", str(self.broker_b.pk)):
            self.assertNotIn(secret, text)
        hidden = [r for r in rows if r["destination"]["hidden"]]
        self.assertEqual(len(hidden), 2)
        self.assertTrue(all(r["name"].endswith("→ Hidden") for r in hidden))
        self.assertTrue(all(r["destination_install"] is None for r in hidden))
        found = self.ok(self.client.get(f"{FLOWS}?search=broker-b"))["results"]
        self.assertEqual(found, [])

    def test_requirement_fixed_end_and_gaps_are_hidden(self):
        r = self.ok(self.client.get(f"{REQS}{self.fixed.pk}/"))
        self.assertTrue(r["destination"]["hidden"])
        self.assertNotIn("10.2.0.5", str(r))
        gaps = self.ok(self.client.get(f"{REQS}{self.req.pk}/gaps/"))
        self.assertEqual((gaps["gaps"], gaps["hidden"]), ([], 1))

    def test_a_site_role_cannot_write_requirements(self):
        editor = User.objects.create_user("editor-a", password="x")
        UserProfile.objects.create(user=editor).tenants.add(self.tenant)
        assemble_site_role(self.tenant, "editor", [self.site_a], user_ids=[editor.id])
        self.login(editor)
        self.ok(self.client.get(f"{REQS}{self.req.pk}/"))
        r = self.client.patch(f"{REQS}{self.req.pk}/", {"ports": "1"}, format="json")
        self.assertEqual(r.status_code, 403)
        r = self.client.post(REQS, {"application_id": str(self.wms.pk), "name": "n",
                                    "source_kind": "self", "destination_kind": "any"},
                             format="json")
        self.assertEqual(r.status_code, 403)
        # A site editor still changes status and detaches at their sites,
        # but may not move a generated row's ends.
        flow = ApplicationFlow.objects.filter(
            requirement=self.req, destination_ip__ip_address="10.1.0.5").first()
        r = self.client.patch(f"{FLOWS}{flow.pk}/", {"destination_any": True}, format="json")
        self.assertEqual(r.status_code, 400)
        self.ok(self.client.post(f"{FLOWS}{flow.pk}/detach/"))
