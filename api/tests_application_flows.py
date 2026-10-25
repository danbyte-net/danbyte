"""Application flows (#163): exactly one end on each side, tenant and site
scope on every reference, the involvement filters with containment, bulk
writes with their change log, the picker, import/export, the schema and the
diagram's PDF."""
from __future__ import annotations

import csv
import io
from unittest import mock

from django.contrib.auth.models import User
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.test import override_settings
from rest_framework.test import APITestCase

from api import topology_export as tx
from api.models import (
    VRF,
    Application,
    ApplicationFlow,
    Cluster,
    ClusterType,
    Device,
    IPAddress,
    IPRange,
    Prefix,
    Service,
    Site,
    Status,
    VirtualMachine,
)
from api.status_registry import seed_builtin_statuses
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant

FLOWS = "/api/application-flows/"


def _csv(resp) -> str:
    return b"".join(resp.streaming_content).decode() if resp.streaming else resp.content.decode()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        seed_builtin_statuses(self.tenant)
        seed_builtin_statuses(self.other)
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.web = Device.objects.create(tenant=self.tenant, name="web1", site=self.site_a)
        ct = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        cl = Cluster.objects.create(tenant=self.tenant, name="C", type=ct)
        self.vm = VirtualMachine.objects.create(tenant=self.tenant, name="db-vm", cluster=cl,
                                                site=self.site_b)
        self.net_a = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/24",
                                           site=self.site_a)
        self.net_b = Prefix.objects.create(tenant=self.tenant, cidr="10.2.0.0/24",
                                           site=self.site_b)
        self.ip_web = IPAddress.objects.create(tenant=self.tenant, prefix=self.net_a,
                                               ip_address="10.1.0.10", assigned_device=self.web)
        self.ip_db = IPAddress.objects.create(tenant=self.tenant, prefix=self.net_b,
                                              ip_address="10.2.0.20", assigned_vm=self.vm)
        self.pool = IPRange.objects.create(tenant=self.tenant, prefix=self.net_b,
                                           start_address="10.2.0.100",
                                           end_address="10.2.0.150")
        self.app = Application.objects.create(tenant=self.tenant, name="Shop", slug="shop")
        self.admin = User.objects.create_superuser("flows-root", password="x")
        self.login(self.admin)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None

    def post(self, **data):
        data.setdefault("application_id", str(self.app.id))
        data.setdefault("name", "web to db")
        if not any(k.startswith("source_") for k in data):
            data["source_ip_id"] = str(self.ip_web.id)
        if not any(k.startswith("destination_") for k in data):
            data["destination_ip_id"] = str(self.ip_db.id)
        return self.client.post(FLOWS, data, format="json")

    def flow(self, name="f", app=None, **ends):
        if not any(k.startswith("source_") for k in ends):
            ends["source_ip"] = self.ip_web
        if not any(k.startswith("destination_") for k in ends):
            ends["destination_ip"] = self.ip_db
        return ApplicationFlow.objects.create(tenant=self.tenant, application=app or self.app,
                                              name=name, **ends)

    def names(self, query=""):
        return sorted(r["name"] for r in self.ok(self.client.get(f"{FLOWS}{query}"))["results"])


class FlowShapeTests(_Base):
    def test_create_with_both_ends_and_display(self):
        body = self.ok(self.post(protocol="tcp", ports="443,8000-8100 ", direction="both"), 201)
        self.assertEqual(body["ports"], "443, 8000-8100")
        self.assertEqual(body["status"]["slug"], "active")
        self.assertEqual(body["source"]["kind"], "ip")
        self.assertEqual(body["source"]["label"], "10.1.0.10")
        self.assertEqual(body["source"]["device"]["name"], "web1")
        self.assertEqual(body["destination"]["vm"]["name"], "db-vm")
        self.assertEqual(body["application"]["slug"], "shop")
        body = self.ok(self.post(name="pool", source_any=True,
                                 destination_range_id=str(self.pool.id)), 201)
        self.assertEqual(body["source"], {"kind": "any", "id": None, "label": "Any",
                                          "device": None, "vm": None})
        self.assertEqual(body["destination"]["label"], "10.2.0.100-10.2.0.150")

    def test_exactly_one_end_per_side(self):
        r = self.client.post(FLOWS, {"application_id": str(self.app.id), "name": "x",
                                     "destination_any": True}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("source", r.json())
        r = self.post(source_ip_id=str(self.ip_web.id), source_prefix_id=str(self.net_a.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("source", r.json())
        r = self.post(destination_any=True, destination_prefix_id=str(self.net_b.id))
        self.assertIn("destination", r.json())
        for bad in ({}, {"source_ip": self.ip_web, "source_any": True}):
            with self.assertRaises(IntegrityError), transaction.atomic():
                ApplicationFlow.objects.create(tenant=self.tenant, application=self.app,
                                               name="raw", destination_any=True, **bad)
        with self.assertRaises(IntegrityError), transaction.atomic():
            ApplicationFlow.objects.create(tenant=self.tenant, application=self.app, name="r",
                                           source_any=True)

    def test_naming_another_kind_replaces_the_end(self):
        f = self.flow()
        body = self.ok(self.client.patch(f"{FLOWS}{f.id}/", {
            "source_prefix_id": str(self.net_a.id)}, format="json"))
        self.assertEqual(body["source"]["kind"], "prefix")
        f.refresh_from_db()
        self.assertIsNone(f.source_ip_id)
        # A patch that leaves the ends alone keeps them.
        self.ok(self.client.patch(f"{FLOWS}{f.id}/", {"description": "x"}, format="json"))
        r = self.client.patch(f"{FLOWS}{f.id}/", {"source_prefix_id": None}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("source", r.json())

    def test_ports(self):
        for bad in ("70000", "443-80", "http"):
            r = self.post(ports=bad)
            self.assertEqual(r.status_code, 400, bad)
            self.assertIn("ports", r.json())
        r = self.post(protocol="icmp", ports="443")
        self.assertIn("ports", r.json())
        self.ok(self.post(protocol="icmp"), 201)

    def test_name_is_unique_per_application(self):
        self.flow("web to db")
        r = self.post()
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.json())
        other = Application.objects.create(tenant=self.tenant, name="Other", slug="other")
        self.ok(self.post(application_id=str(other.id)), 201)

    def test_service_answers_on_the_destination(self):
        here = Service.objects.create(tenant=self.tenant, name="pg", ports=[5432],
                                      virtual_machine=self.vm)
        there = Service.objects.create(tenant=self.tenant, name="http", ports=[80],
                                       device=self.web)
        r = self.post(service_id=str(there.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("service_id", r.json())
        body = self.ok(self.post(service_id=str(here.id)), 201)
        self.assertEqual(body["service"]["name"], "pg")
        self.assertEqual(self.names(f"?service={here.id}"), ["web to db"])

    def test_deleting_an_end_deletes_the_flow(self):
        f = self.flow()
        self.ip_db.delete()
        self.assertFalse(ApplicationFlow.objects.filter(pk=f.pk).exists())

    def test_application_counts_and_keeps_its_flows(self):
        self.flow()
        body = self.ok(self.client.get(f"/api/applications/{self.app.id}/"))
        self.assertEqual(body["flow_count"], 1)
        row = self.ok(self.client.get("/api/applications/"))["results"][0]
        self.assertEqual(row["flow_count"], 1)
        r = self.client.delete(f"/api/applications/{self.app.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertIn("1 flow", r.json()["detail"])

    def test_status_seed(self):
        st = Status.objects.get(tenant=self.tenant, slug="active")
        self.assertIn("applicationflow", st.default_for)
        slugs = set(Status.objects.filter(tenant=self.tenant,
                                          available_to__contains=["applicationflow"])
                    .values_list("slug", flat=True))
        self.assertEqual(slugs, {"active", "planned", "retired"})
        offline = Status.objects.get(tenant=self.tenant, slug="offline")
        r = self.post(status_id=str(offline.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("status_id", r.json())


class TenantScopeTests(_Base):
    def setUp(self):
        super().setUp()
        o = self.other
        self.o_app = Application.objects.create(tenant=o, name="X", slug="x")
        o_net = Prefix.objects.create(tenant=o, cidr="10.1.0.0/24")
        self.o_ip = IPAddress.objects.create(tenant=o, prefix=o_net, ip_address="10.1.0.10")
        self.o_range = IPRange.objects.create(tenant=o, prefix=o_net,
                                              start_address="10.1.0.1",
                                              end_address="10.1.0.9")
        self.o_net = o_net
        self.o_dev = Device.objects.create(tenant=o, name="foreign")
        self.o_svc = Service.objects.create(tenant=o, name="s", ports=[1], device=self.o_dev)
        self.o_status = Status.objects.get(tenant=o, slug="active")
        self.o_tag = Tag.objects.create(tenant=o, name="t", slug="t")

    def test_every_reference_must_be_the_tenants(self):
        cases = {
            "application_id": str(self.o_app.id),
            "source_ip_id": str(self.o_ip.id),
            "source_range_id": str(self.o_range.id),
            "source_prefix_id": str(self.o_net.id),
            "destination_ip_id": str(self.o_ip.id),
            "destination_range_id": str(self.o_range.id),
            "destination_prefix_id": str(self.o_net.id),
            "service_id": str(self.o_svc.id),
            "status_id": str(self.o_status.id),
            "tag_ids": [str(self.o_tag.id)],
        }
        for key, value in cases.items():
            r = self.post(**{key: value})
            self.assertEqual(r.status_code, 400, key)
            self.assertIn(key, r.json(), key)
        self.assertFalse(ApplicationFlow.objects.exists())

    def test_patch_cannot_move_onto_a_foreign_end(self):
        f = self.flow()
        r = self.client.patch(f"{FLOWS}{f.id}/", {"source_ip_id": str(self.o_ip.id)},
                              format="json")
        self.assertEqual(r.status_code, 400)
        f.refresh_from_db()
        self.assertEqual(f.source_ip, self.ip_web)

    def test_foreign_flows_are_invisible(self):
        theirs = ApplicationFlow.objects.create(tenant=self.other, application=self.o_app,
                                                name="theirs", source_ip=self.o_ip,
                                                destination_any=True)
        self.assertEqual(self.names(), [])
        self.assertEqual(self.client.get(f"{FLOWS}{theirs.id}/").status_code, 404)
        r = self.client.post(f"{FLOWS}bulk-delete/", {"ids": [str(theirs.id)]}, format="json")
        self.assertTrue(ApplicationFlow.objects.filter(pk=theirs.pk).exists(), r.content)
        # Filtering by another tenant's device or address finds nothing.
        self.flow()
        self.assertEqual(self.names(f"?device={self.o_dev.id}"), [])
        self.assertEqual(self.names(f"?ip={self.o_ip.id}"), [])

    def test_bulk_update_refuses_a_foreign_status(self):
        f = self.flow()
        r = self.client.post(f"{FLOWS}bulk-update/", {
            "ids": [str(f.id)], "fields": {"status_id": str(self.o_status.id)}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_default_closed(self):
        user = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.client.get(FLOWS).status_code, 403)
        self.assertEqual(self.post().status_code, 403)


class SiteScopeTests(_Base):
    def _user(self, actions):
        user = User.objects.create_user(f"site-{len(actions)}", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="a", object_types=["applicationflow", "application", "ipaddress", "prefix",
                                    "iprange", "status"],
            actions=actions)
        p.users.add(user)
        p.tenants.add(self.tenant)
        p.sites.set([self.site_a])
        return user

    def test_a_site_viewer_reads_the_flows_of_their_sites(self):
        self.flow("from a", source_ip=self.ip_web, destination_ip=self.ip_db)
        self.flow("into a", source_any=True, destination_prefix=self.net_a)
        self.flow("b only", source_ip=self.ip_db, destination_range=self.pool)
        self.flow("b prefix", source_prefix=self.net_b, destination_any=True)
        self.flow("b pool", source_range=self.pool, destination_any=True)
        self.login(self._user(["view"]))
        self.assertEqual(self.names(), ["from a", "into a"])
        self.assertEqual(self.names(f"?vm={self.vm.id}"), ["from a"])

    def test_a_site_editor_writes_only_in_their_sites(self):
        self.login(self._user(["view", "add", "change", "delete"]))
        self.ok(self.post(name="ok"), 201)
        r = self.post(name="no", source_ip_id=str(self.ip_db.id),
                      destination_ip_id=str(self.ip_web.id))
        self.assertIn(r.status_code, (400, 403))
        self.assertFalse(ApplicationFlow.objects.filter(name="no").exists())


class FilterTests(_Base):
    def setUp(self):
        super().setUp()
        self.vrf = VRF.objects.create(tenant=self.tenant, name="blue")
        blue = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/16", vrf=self.vrf)
        self.flow("ip to ip")
        self.flow("prefix", source_prefix=self.net_a, destination_any=True)
        self.flow("wide", source_any=True, destination_prefix=Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8"))
        self.flow("pool", source_range=self.pool, destination_ip=self.ip_web, protocol="udp")
        self.flow("other vrf", source_prefix=blue, destination_any=True)
        self.flow("any", source_any=True, destination_any=True, protocol="icmp")
        dbpool = IPRange.objects.create(tenant=self.tenant, prefix=self.net_b,
                                        start_address="10.2.0.10", end_address="10.2.0.30")
        self.flow("db pool", source_range=dbpool, destination_any=True)

    def test_device_and_vm_take_containing_prefixes_and_ranges(self):
        self.assertEqual(self.names(f"?device={self.web.id}"),
                         ["ip to ip", "pool", "prefix", "wide"])
        self.assertEqual(self.names(f"?vm={self.vm.id}"), ["db pool", "ip to ip", "wide"])

    def test_ip_is_direct_or_contained(self):
        self.assertEqual(self.names(f"?ip={self.ip_db.id}"), ["db pool", "ip to ip", "wide"])

    def test_prefix_and_range_are_direct_on_either_end(self):
        self.assertEqual(self.names(f"?prefix={self.net_a.id}"), ["prefix"])
        self.assertEqual(self.names(f"?range={self.pool.id}"), ["pool"])

    def test_plain_filters(self):
        self.assertEqual(self.names("?protocol=udp"), ["pool"])
        self.assertEqual(self.names("?search=10.2.0.100"), [])
        self.assertEqual(self.names("?search=db%20pool"), ["db pool"])
        self.assertEqual(len(self.names(f"?application={self.app.id}")), 7)
        active = Status.objects.get(tenant=self.tenant, slug="active")
        ApplicationFlow.objects.filter(name="any").update(status=active)
        self.assertEqual(self.names(f"?status={active.id}"), ["any"])
        self.assertEqual(self.client.get(f"{FLOWS}?device=nope").status_code, 400)
        self.assertEqual(self.client.get(f"{FLOWS}?protocol=gre").status_code, 400)

    def test_picker(self):
        rows = self.ok(self.client.get(f"{FLOWS}?picker=1&protocol=udp"))["results"]
        self.assertEqual(rows, [{"id": rows[0]["id"], "numid": rows[0]["numid"], "name": "pool",
                                 "application": {"id": str(self.app.id), "name": "Shop"}}])


class BulkAndAuditTests(_Base):
    def test_bulk_delete_logs_each_flow(self):
        a, b = self.flow("a"), self.flow("b")
        body = self.ok(self.client.post(f"{FLOWS}bulk-delete/",
                                        {"ids": [str(a.id), str(b.id)]}, format="json"))
        self.assertEqual(body["deleted"], 2)
        for f in (a, b):
            self.assertEqual(ChangeLogEntry.objects.filter(
                object_type="api.applicationflow", object_id=str(f.pk),
                action="delete").count(), 1)

    def test_bulk_update_logs_and_create_logs(self):
        body = self.ok(self.post(), 201)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.applicationflow", object_id=body["id"], action="create").exists())
        planned = Status.objects.get(tenant=self.tenant, slug="planned")
        self.ok(self.client.post(f"{FLOWS}bulk-update/", {
            "ids": [body["id"]], "fields": {"status_id": str(planned.id),
                                            "direction": "both"}}, format="json"))
        f = ApplicationFlow.objects.get(pk=body["id"])
        self.assertEqual((f.status, f.direction), (planned, "both"))
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.applicationflow", object_id=body["id"], action="update").exists())
        r = self.client.post(f"{FLOWS}bulk-update/", {
            "ids": [body["id"]], "fields": {"source_any": True}}, format="json")
        self.assertEqual(r.status_code, 400)


class ImportExportTests(_Base):
    def test_import_by_names_and_round_trip(self):
        content = ("application,name,source_ip,source_any,destination_prefix,"
                   "destination_any,protocol,ports\n"
                   "shop,web to net,10.1.0.10,,10.2.0.0/24,,tcp,443\n"
                   "shop,anywhere,,True,,True,icmp,\n")
        body = self.ok(self.client.post("/api/io/applicationflow/import/",
                                        {"format": "csv", "content": content}, format="json"))
        self.assertEqual((body["created"], body["errors"]), (2, []))
        f = ApplicationFlow.objects.get(name="web to net")
        self.assertEqual((f.source_ip, f.destination_prefix), (self.ip_web, self.net_b))
        self.flow("pool", source_range=self.pool, destination_any=True)
        text = _csv(self.client.get("/api/io/applicationflow/export/?fmt=csv"))
        rows = {r["name"]: r for r in csv.DictReader(io.StringIO(text))}
        self.assertEqual(rows["web to net"]["application"], "shop")
        self.assertEqual(rows["web to net"]["source_ip"], "10.1.0.10")
        self.assertEqual(rows["pool"]["source_range"], str(self.pool.id))
        body = self.ok(self.client.post("/api/io/applicationflow/import/",
                                        {"format": "csv", "content": text}, format="json"))
        self.assertEqual((body["created"], body["errors"]), (0, []))
        self.assertEqual(ApplicationFlow.objects.count(), 3)

    def test_import_refuses_foreign_and_broken_rows(self):
        Application.objects.create(tenant=self.other, name="Theirs", slug="theirs")
        content = ("application,name,source_any,destination_any\n"
                   "theirs,x,True,True\n"
                   "shop,y,,True\n")
        body = self.ok(self.client.post("/api/io/applicationflow/import/",
                                        {"format": "csv", "content": content}, format="json"))
        self.assertEqual(body["created"], 0)
        self.assertEqual(len(body["errors"]), 2)


class SchemaTests(_Base):
    def test_openapi_lists_the_endpoint(self):
        # The generator, not /api/schema/: that response is cached for an hour.
        from drf_spectacular.generators import SchemaGenerator

        paths = SchemaGenerator().get_schema(request=None, public=True)["paths"]
        self.assertIn("/api/application-flows/", paths)
        self.assertIn("/api/application-flows/bulk-update/", paths)
        params = {p["name"] for p in paths["/api/application-flows/"]["get"]["parameters"]}
        self.assertLessEqual({"application", "ip", "prefix", "range", "device", "vm",
                              "protocol", "status", "search"}, params)
        self.assertIn("/api/diagram/export/pdf/", paths)


ARROWED = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">'
    '<path d="M 10,50 L 180,50" fill="none" stroke="#71717b"/>'
    '<polygon points="190,50 180,55 180,45" fill="#71717b"/></svg>'
)
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}


@override_settings(CACHES=LOCMEM)
class DiagramPdfTests(_Base):
    """``POST /api/diagram/export/pdf/`` by kind: the flows' diagram needs
    applicationflow.view, the topology alias keeps device.view."""

    URL = "/api/diagram/export/pdf/"
    fake = mock.patch.object(tx, "render_with_deadline", return_value=b"%PDF-1.7 fake")

    def setUp(self):
        super().setUp()
        cache.clear()

    def _member(self, name, *types):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name=f"{name}-p", object_types=list(types),
                                               actions=["view"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        return user

    def _post(self, url=None, **body):
        payload = {"svg": ARROWED, "title": "Shop", "kind": "application-flows", **body}
        return self.client.post((url or self.URL) + "?print=1", payload, format="json")

    def test_arrowheads_survive_the_sanitizer(self):
        from api.svg_sanitize import sanitize_svg

        self.assertIn(b"<polygon", sanitize_svg(ARROWED))

    def test_the_kind_picks_the_permission(self):
        self.login(self._member("flows-only", "applicationflow"))
        with self.fake:
            r = self._post()
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(self._post(kind="topology").status_code, 403)
        link = r.json()["url"]
        self.assertRegex(link, r"^/api/diagram/export/pdf/[A-Za-z0-9_-]{24,64}/"
                               r"\?kind=application-flows$")
        self.assertEqual(self.client.get(link).content, b"%PDF-1.7 fake")
        # Not a topology link, and not someone else's.
        self.assertEqual(self.client.get(link.split("?")[0]).status_code, 404)
        self.login(self._member("devices-only", "device"))
        self.assertEqual(self.client.get(link).status_code, 404)
        with self.fake:
            self.assertEqual(self._post().status_code, 403)
            r = self._post(url="/api/topology/export/pdf/", kind="topology")
        self.assertRegex(r.json()["url"], r"^/api/topology/export/pdf/[A-Za-z0-9_-]+/$")

    def test_unknown_kind_and_file_name(self):
        self.assertEqual(self._post(kind="racks").status_code, 400)
        with self.fake:
            r = self.client.post(self.URL, {"svg": ARROWED, "kind": "application-flows"},
                                 format="json")
        self.assertRegex(r["Content-Disposition"],
                         r'filename="application-flows-\d{4}-\d{2}-\d{2}\.pdf"')
