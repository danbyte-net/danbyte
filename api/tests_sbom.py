"""SBOM: licences on applications, installs and platforms, and the CycloneDX
1.6 export at ``/api/sbom/`` - its shape, licence fallback, filters, tenant
and RBAC exclusion, and a query count that stays flat."""
from __future__ import annotations

import csv
import io
import json
import re

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api.models import (
    Application,
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    InstalledSoftware,
    Manufacturer,
    Platform,
    Site,
    VirtualMachine,
)
from api.package_ids import render_cpe, render_purl, validate_cpe, validate_purl
from api.spdx import license_entry, validate_license_expression
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant

URL = "/api/sbom/"


class LicenseExpressionTests(SimpleTestCase):
    def test_valid(self):
        for v in ("", "MIT", "Apache-2.0", "GPL-2.0+", "GPL-2.0-or-later",
                  "LicenseRef-acme-eula", "DocumentRef-x:LicenseRef-y",
                  "MIT OR Apache-2.0",
                  "GPL-2.0-only WITH Classpath-exception-2.0",
                  "(MIT OR Apache-2.0) AND BSD-3-Clause",
                  "((MIT))", " MIT "):
            validate_license_expression(v)

    def test_invalid(self):
        for v in ("MIT Apache-2.0", "MIT or Apache-2.0", "(MIT", "MIT)", "AND",
                  "MIT AND", "MIT WITH", "WITH MIT", "M!T", "()", "x" * 256):
            with self.assertRaises(ValidationError, msg=v):
                validate_license_expression(v)

    def test_entry(self):
        self.assertIsNone(license_entry(""))
        self.assertEqual(license_entry("MIT"), {"license": {"id": "MIT"}})
        self.assertEqual(license_entry("MIT OR Apache-2.0"),
                         {"expression": "MIT OR Apache-2.0"})
        self.assertEqual(license_entry("LicenseRef-acme"), {"expression": "LicenseRef-acme"})
        self.assertEqual(license_entry("GPL-2.0+"), {"expression": "GPL-2.0+"})


def _csv(resp):
    content = b"".join(resp.streaming_content) if resp.streaming else resp.content
    return list(csv.DictReader(io.StringIO(content.decode().lstrip("\ufeff"))))


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.cisco = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.canonical = Manufacturer.objects.create(tenant=self.tenant, name="Canonical",
                                                     slug="canonical")
        self.pgdg = Manufacturer.objects.create(tenant=self.tenant, name="PGDG", slug="pgdg")
        self.router = DeviceRole.objects.create(tenant=self.tenant, name="Router",
                                                slug="router")
        self.node = DeviceRole.objects.create(tenant=self.tenant, name="Node", slug="node")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=self.cisco,
                                       model="C8300")
        self.ubuntu = Platform.objects.create(tenant=self.tenant, name="Ubuntu", slug="ubuntu",
                                              manufacturer=self.canonical, license="GPL-2.0-only")
        self.iosxe = Platform.objects.create(tenant=self.tenant, name="IOS-XE", slug="ios-xe",
                                             manufacturer=self.cisco)
        self.r1 = Device.objects.create(tenant=self.tenant, name="r1", site=self.site_a,
                                        role=self.router, device_type=dt, platform=self.iosxe,
                                        software_version="17.9.4")
        self.n1 = Device.objects.create(tenant=self.tenant, name="n1", site=self.site_a,
                                        role=self.node, platform=self.ubuntu,
                                        software_version="22.04")
        self.n2 = Device.objects.create(tenant=self.tenant, name="n2", site=self.site_b,
                                        role=self.node, platform=self.ubuntu)
        ct = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        cl = Cluster.objects.create(tenant=self.tenant, name="pve", type=ct)
        self.vm = VirtualMachine.objects.create(tenant=self.tenant, name="svc1", cluster=cl,
                                                site=self.site_a, platform=self.ubuntu)
        self.pg = Application.objects.create(tenant=self.tenant, name="PostgreSQL",
                                             slug="postgresql", manufacturer=self.pgdg,
                                             license="PostgreSQL")
        self.nginx = Application.objects.create(tenant=self.tenant, name="nginx",
                                                slug="nginx")
        self.admin = User.objects.create_superuser("sbom-root", password="x")
        self.login(self.admin)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def install(self, app, host, version="1", **kw):
        parent = {"virtual_machine": host} if isinstance(host, VirtualMachine) \
            else {"device": host}
        return InstalledSoftware.objects.create(tenant=self.tenant, application=app,
                                                version=version, **parent, **kw)

    def sbom(self, query="", **kw):
        r = self.client.get(URL + query, **kw)
        self.assertEqual(r.status_code, 200, r.content)
        return r, json.loads(r.content)

    @staticmethod
    def hosts(doc) -> dict:
        return {c["name"]: c for c in doc["components"]}

    @staticmethod
    def prop(obj, name):
        for p in obj.get("properties", ()):
            if p["name"] == f"danbyte:{name}":
                return p["value"]
        return None


class LicenseFieldTests(_Base):
    def test_api_round_trip_and_validation(self):
        r = self.client.patch(f"/api/applications/{self.nginx.id}/",
                              {"license": "BSD-2-Clause"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["license"], "BSD-2-Clause")
        r = self.client.patch(f"/api/applications/{self.nginx.id}/",
                              {"license": "BSD-2-Clause MIT"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("license", r.json())
        r = self.client.patch(f"/api/platforms/{self.iosxe.id}/",
                              {"license": "LicenseRef-cisco-eula"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["license"], "LicenseRef-cisco-eula")

    def test_install_override_and_effective(self):
        sw = self.install(self.pg, self.n1, "16.4")
        body = self.client.get(f"/api/installed-software/{sw.id}/").json()
        self.assertEqual((body["license"], body["effective_license"]), ("", "PostgreSQL"))
        r = self.client.patch(f"/api/installed-software/{sw.id}/",
                              {"license": "LicenseRef-enterprise"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["effective_license"], "LicenseRef-enterprise")
        r = self.client.patch(f"/api/installed-software/{sw.id}/",
                              {"license": "(MIT"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_import_export_carries_the_license(self):
        rows = _csv(self.client.get("/api/io/application/export/?fmt=csv"))
        self.assertEqual({r["slug"]: r["license"] for r in rows}["postgresql"], "PostgreSQL")
        content = "application,device,version,license\nnginx,n1,1.24,BSD-2-Clause\n"
        body = self.client.post("/api/io/installedsoftware/import/",
                                {"format": "csv", "content": content}, format="json").json()
        self.assertEqual((body["created"], body["errors"]), (1, []))
        self.assertEqual(InstalledSoftware.objects.get(device=self.n1).license, "BSD-2-Clause")
        bad = "application,device,version,license\nnginx,n2,1,not a licence\n"
        body = self.client.post("/api/io/installedsoftware/import/",
                                {"format": "csv", "content": bad}, format="json").json()
        self.assertEqual(body["created"], 0)
        self.assertTrue(body["errors"])
        rows = _csv(self.client.get("/api/io/platform/export/?fmt=csv"))
        self.assertEqual({r["slug"]: r["license"] for r in rows}["ubuntu"], "GPL-2.0-only")


class SbomShapeTests(_Base):
    def test_document_shape(self):
        sw = self.install(self.pg, self.n1, "16.4")
        self.install(self.nginx, self.vm, "1.24")
        r, doc = self.sbom(f"?site={self.site_a.id}")
        self.assertTrue(r["Content-Type"].startswith("application/vnd.cyclonedx+json"))
        self.assertRegex(r["Content-Disposition"],
                         r'^attachment; filename="sbom-a-\d{8}\.cdx\.json"$')
        self.assertEqual(doc["bomFormat"], "CycloneDX")
        self.assertEqual(doc["specVersion"], "1.6")
        self.assertEqual(doc["version"], 1)
        self.assertRegex(doc["serialNumber"],
                         r"^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        meta = doc["metadata"]
        self.assertRegex(meta["timestamp"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        tool = meta["tools"]["components"][0]
        self.assertEqual((tool["type"], tool["name"]), ("application", "Danbyte"))
        self.assertTrue(tool["version"])
        self.assertEqual(meta["component"]["name"], "A")
        for p in meta["properties"]:
            self.assertIsInstance(p["value"], str)

        hosts = self.hosts(doc)
        self.assertEqual(set(hosts), {"r1", "n1", "svc1"})
        self.assertEqual(hosts["r1"]["type"], "device")
        self.assertEqual(hosts["r1"]["supplier"], {"name": "Cisco"})
        self.assertEqual(hosts["svc1"]["type"], "platform")
        n1 = {c["name"]: c for c in hosts["n1"]["components"]}
        os_ = n1["Ubuntu"]
        self.assertEqual((os_["type"], os_["version"], os_["supplier"], os_["licenses"]),
                         ("operating-system", "22.04", {"name": "Canonical"},
                          [{"license": {"id": "GPL-2.0-only"}}]))
        app = n1["PostgreSQL"]
        self.assertEqual((app["type"], app["version"], app["supplier"], app["licenses"]),
                         ("application", "16.4", {"name": "PGDG"},
                          [{"license": {"id": "PostgreSQL"}}]))
        self.assertEqual(app["bom-ref"], f"danbyte:installedsoftware:{sw.id}")

        # Every bom-ref is unique and every dependency names one.
        refs = [c["bom-ref"] for h in doc["components"]
                for c in [h, *h.get("components", [])]]
        refs.append(meta["component"]["bom-ref"])
        self.assertEqual(len(refs), len(set(refs)))
        deps = {d["ref"]: d["dependsOn"] for d in doc["dependencies"]}
        self.assertTrue(set(deps) <= set(refs))
        self.assertTrue({x for v in deps.values() for x in v} <= set(refs))
        self.assertEqual(set(deps[hosts["n1"]["bom-ref"]]),
                         {c["bom-ref"] for c in hosts["n1"]["components"]})
        self.assertEqual(set(deps[meta["component"]["bom-ref"]]),
                         {h["bom-ref"] for h in hosts.values()})

    def test_unknown_licenses_are_left_out_and_counted(self):
        self.install(self.nginx, self.n1, "1.24")
        _, doc = self.sbom(f"?device={self.r1.id},{self.n1.id}")
        hosts = self.hosts(doc)
        r1_os = hosts["r1"]["components"][0]
        self.assertNotIn("licenses", r1_os)  # IOS-XE has none
        nginx = {c["name"]: c for c in hosts["n1"]["components"]}["nginx"]
        self.assertNotIn("licenses", nginx)
        self.assertNotIn("supplier", nginx)
        meta = doc["metadata"]
        self.assertEqual(self.prop(meta, "components"), "3")
        self.assertEqual(self.prop(meta, "components_without_license"), "2")
        self.assertEqual(self.prop(meta, "unlicensed"), "IOS-XE, nginx")
        self.assertEqual(meta["component"]["name"], "selection")

    def test_install_override_wins(self):
        self.install(self.pg, self.n1, "16.4", license="LicenseRef-commercial")
        _, doc = self.sbom(f"?device={self.n1.id}")
        app = {c["name"]: c for c in self.hosts(doc)["n1"]["components"]}["PostgreSQL"]
        self.assertEqual(app["licenses"], [{"expression": "LicenseRef-commercial"}])

    def test_post_takes_the_same_filters(self):
        r = self.client.post(URL, {"device": [str(self.n1.id), str(self.n2.id)]},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(set(self.hosts(json.loads(r.content))), {"n1", "n2"})


class SbomFilterTests(_Base):
    def names(self, query):
        return set(self.hosts(self.sbom(query)[1]))

    def test_filters(self):
        tag = Tag.objects.create(tenant=self.tenant, name="OpenStack", slug="openstack")
        self.n1.tags.add(tag)
        self.vm.tags.add(tag)
        self.assertEqual(self.names(""), {"r1", "n1", "n2", "svc1"})
        self.assertEqual(self.names(f"?site={self.site_b.id}"), {"n2"})
        self.assertEqual(self.names(f"?site={self.site_a.id}&site={self.site_b.id}"),
                         {"r1", "n1", "n2", "svc1"})
        self.assertEqual(self.names(f"?role={self.node.id}"), {"n1", "n2"})
        self.assertEqual(self.names(f"?role={self.node.id}&site={self.site_a.id}"), {"n1"})
        self.assertEqual(self.names(f"?tag={tag.id}"), {"n1", "svc1"})
        self.assertEqual(self.names("?tag=openstack"), {"n1", "svc1"})
        self.assertEqual(self.names(f"?virtual_machine={self.vm.id}"), {"svc1"})
        self.assertEqual(self.names(f"?device={self.r1.id}&virtual_machine={self.vm.id}"),
                         {"r1", "svc1"})

    def test_site_by_name_or_slug(self):
        Site.objects.create(tenant=self.other, name="Nope")
        self.site_b.name = "DKW 01"
        self.site_b.save()
        for v in ("DKW 01", "dkw%2001", "dkw-01"):
            _, doc = self.sbom(f"?site={v}")
            self.assertEqual(set(self.hosts(doc)), {"n2"}, v)
            self.assertEqual(doc["metadata"]["component"]["name"], "DKW 01")
        self.assertEqual(self.names(f"?site=a,{self.site_b.id}"),
                         {"r1", "n1", "n2", "svc1"})
        # An unknown name, or another tenant's, matches nothing.
        _, doc = self.sbom("?site=nope")
        self.assertEqual(doc["components"], [])
        self.assertEqual(doc["metadata"]["component"]["name"], "selection")


class SbomScopeTests(_Base):
    def test_other_tenant_is_never_included(self):
        their_site = Site.objects.create(tenant=self.other, name="X")
        theirs = Device.objects.create(tenant=self.other, name="theirs", site=their_site)
        _, doc = self.sbom(f"?device={theirs.id}")
        self.assertEqual(doc["components"], [])
        _, doc = self.sbom(f"?site={their_site.id}")
        self.assertEqual(doc["components"], [])
        self.assertEqual(doc["metadata"]["component"]["name"], "selection")
        self.assertNotIn("theirs", self.hosts(self.sbom()[1]))

    def test_site_scoped_reader_sees_their_sites_only(self):
        self.install(self.pg, self.n1, "16")
        self.install(self.pg, self.n2, "16")
        user = User.objects.create_user("reader", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="r", object_types=["device", "virtualmachine", "installedsoftware"],
            actions=["view"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        p.sites.set([self.site_a])
        self.login(user)
        self.assertEqual(set(self.hosts(self.sbom()[1])), {"r1", "n1", "svc1"})
        _, doc = self.sbom(f"?device={self.n2.id}")
        self.assertEqual(doc["components"], [])

    def test_a_site_out_of_scope_is_not_named(self):
        # #468: a Site A reader asking for Site B got its name as the subject
        # and in the file name; it reads like an unknown id now.
        self.site_b.name = "Secret B"
        self.site_b.save()
        user = User.objects.create_user("siteonly", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="s", object_types=["site", "device", "virtualmachine"], actions=["view"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        p.sites.set([self.site_a])
        self.login(user)
        r, doc = self.sbom(f"?site={self.site_b.id}")
        self.assertEqual(doc["components"], [])
        self.assertEqual(doc["metadata"]["component"]["name"], "selection")
        self.assertNotIn("Secret B", r.content.decode())
        self.assertNotIn(str(self.site_b.id), r.content.decode())
        self.assertNotIn("secret", r["Content-Disposition"].lower())
        r = self.client.post(URL, {"site": [str(self.site_b.id)]}, content_type="application/json")
        self.assertNotIn("Secret B", r.content.decode())
        # By name it is just as unknown.
        r, doc = self.sbom("?site=secret-b")
        self.assertEqual(doc["components"], [])
        self.assertNotIn("Secret B", r.content.decode())
        # Their own site is still the subject.
        _, doc = self.sbom(f"?site={self.site_a.id}")
        self.assertEqual(doc["metadata"]["component"]["name"], self.site_a.name)

    def test_software_needs_its_own_view_permission(self):
        self.install(self.pg, self.n1, "16")
        user = User.objects.create_user("devonly", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(name="d", object_types=["device"],
                                            actions=["view"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        self.login(user)
        hosts = self.hosts(self.sbom()[1])
        self.assertEqual(set(hosts), {"r1", "n1", "n2"})  # no VM permission
        self.assertEqual([c["type"] for c in hosts["n1"]["components"]],
                         ["operating-system"])

    def test_anonymous_is_refused(self):
        self.client.logout()
        self.assertIn(self.client.get(URL).status_code, (401, 403))


class SbomQueryCountTests(_Base):
    def _count(self) -> int:
        with CaptureQueriesContext(connection) as ctx:
            self.sbom()
        return len(ctx.captured_queries)

    def test_flat(self):
        self.install(self.pg, self.n1, "16")
        # One call first: the request path warms per-session and cached state
        # (session expiry, lookups) that a later call does not repeat, so the
        # comparison is call against call, not cold against warm.
        self.sbom()
        before = self._count()
        cl = self.vm.cluster
        for i in range(6):
            d = Device.objects.create(tenant=self.tenant, name=f"x{i}", site=self.site_a,
                                      role=self.node, platform=self.ubuntu)
            self.install(self.pg, d, "16")
            self.install(self.nginx, d, "1")
            vm = VirtualMachine.objects.create(tenant=self.tenant, name=f"v{i}", cluster=cl,
                                               site=self.site_b, platform=self.iosxe)
            self.install(self.nginx, vm, "1")
        self.assertEqual(self._count(), before)


class SbomFileNameTests(_Base):
    def test_selection_name(self):
        r, _ = self.sbom()
        self.assertTrue(re.search(r'filename="sbom-selection-\d{8}\.cdx\.json"',
                                  r["Content-Disposition"]))


FRR_TEMPLATE = "pkg:deb/debian/frr@{version}?arch=amd64&distro=debian-{os_version}"


class PackageIdTests(SimpleTestCase):
    def test_purl_escaping(self):
        self.assertEqual(
            render_purl(FRR_TEMPLATE, version="10.3-3+deb13u1", os_version="13"),
            "pkg:deb/debian/frr@10.3-3%2Bdeb13u1?arch=amd64&distro=debian-13")
        self.assertEqual(render_purl("pkg:deb/debian/x@{version}", version="1:2.0~rc1"),
                         "pkg:deb/debian/x@1%3A2.0~rc1")
        self.assertEqual(render_purl("pkg:generic/x@{version}?q={os_version}",
                                     version="1 &2", os_version="a=b"),
                         "pkg:generic/x@1%20%262?q=a%3Db")
        # A blank placeholder resolves to nothing; no template, no purl.
        self.assertEqual(render_purl(FRR_TEMPLATE, version="1"), "")
        self.assertEqual(render_purl("", version="1"), "")
        self.assertEqual(render_purl("pkg:pypi/django@5.2"), "pkg:pypi/django@5.2")

    def test_cpe_escaping(self):
        self.assertEqual(
            render_cpe("cpe:2.3:a:frrouting:frrouting:{version}:*:*:*:*:*:*:*",
                       version="10.3-3+deb13u1"),
            "cpe:2.3:a:frrouting:frrouting:10.3-3\\+deb13u1:*:*:*:*:*:*:*")
        self.assertEqual(render_cpe("cpe:2.3:o:cisco:ios:{version}:*:*:*:*:*:*:*",
                                    version="15.2(7)E8"),
                         "cpe:2.3:o:cisco:ios:15.2\\(7\\)E8:*:*:*:*:*:*:*")

    def test_validation(self):
        for v in ("", FRR_TEMPLATE, "pkg:pypi/django@5.2", "pkg:npm/%40scope/x@{version}"):
            validate_purl(v)
        for v in ("deb/debian/frr", "pkg:/frr", "pkg:deb", "pkg:deb/x@{ver}",
                  "pkg:1deb/x", "pkg:deb/ x"):
            with self.assertRaises(ValidationError, msg=v):
                validate_purl(v)
        for v in ("", "cpe:2.3:a:frrouting:frrouting:{version}:*:*:*:*:*:*:*",
                  "cpe:2.3:o:cisco:ios:15.2\\(7\\)e8:*:*:*:*:*:*:*",
                  "cpe:2.3:a:x:y\\:z:1:*:*:*:*:*:*:*"):
            validate_cpe(v)
        for v in ("cpe:/a:x:y:1", "cpe:2.3:a:x:y:1", "cpe:2.2:a:x:y:1:*:*:*:*:*:*:*",
                  "cpe:2.3:q:x:y:1:*:*:*:*:*:*:*", "cpe:2.3:a::y:1:*:*:*:*:*:*:*",
                  "cpe:2.3:a:x:y:{os}:*:*:*:*:*:*:*"):
            with self.assertRaises(ValidationError, msg=v):
                validate_cpe(v)


class SbomPackageIdTests(_Base):
    def test_frr_on_debian(self):
        debian = Platform.objects.create(
            tenant=self.tenant, name="Debian", slug="debian",
            purl_template="pkg:deb/debian/debian@{version}",
            cpe_template="cpe:2.3:o:debian:debian_linux:{version}:*:*:*:*:*:*:*")
        frr = Application.objects.create(
            tenant=self.tenant, name="FRRouting", slug="frr", purl_template=FRR_TEMPLATE,
            cpe_template="cpe:2.3:a:frrouting:frrouting:{version}:*:*:*:*:*:*:*")
        rtr = Device.objects.create(tenant=self.tenant, name="edge1", site=self.site_a,
                                    platform=debian, software_version="13")
        self.install(frr, rtr, "10.3-3+deb13u1")
        own = self.install(self.nginx, rtr, "1.26", purl="pkg:deb/debian/nginx-light@1.26")
        self.install(self.pg, rtr, "17")  # no template: neither field
        host = self.hosts(self.sbom()[1])["edge1"]
        by = {c["name"]: c for c in host["components"]}
        self.assertEqual(
            by["FRRouting"]["purl"],
            "pkg:deb/debian/frr@10.3-3%2Bdeb13u1?arch=amd64&distro=debian-13")
        self.assertEqual(by["FRRouting"]["cpe"],
                         "cpe:2.3:a:frrouting:frrouting:10.3-3\\+deb13u1:*:*:*:*:*:*:*")
        self.assertEqual(by["Debian"]["purl"], "pkg:deb/debian/debian@13")
        self.assertEqual(by["Debian"]["cpe"],
                         "cpe:2.3:o:debian:debian_linux:13:*:*:*:*:*:*:*")
        self.assertEqual(by["nginx"]["purl"], "pkg:deb/debian/nginx-light@1.26")
        self.assertNotIn("purl", by["PostgreSQL"])
        self.assertNotIn("cpe", by["PostgreSQL"])
        # The API shows the same resolved values.
        r = self.client.get(f"/api/installed-software/{own.id}/")
        self.assertEqual(r.json()["effective_purl"], "pkg:deb/debian/nginx-light@1.26")

    def test_api_validation(self):
        r = self.client.patch(f"/api/applications/{self.nginx.id}/",
                              {"purl_template": "nginx@{version}"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("purl_template", r.json())
        r = self.client.patch(f"/api/platforms/{self.ubuntu.id}/",
                              {"cpe_template": "cpe:2.3:o:canonical"}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/platforms/{self.ubuntu.id}/",
                              {"purl_template": "pkg:deb/ubuntu/ubuntu@{version}"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        rows = _csv(self.client.get("/api/io/platform/export/?fmt=csv"))
        self.assertEqual({r["slug"]: r["purl_template"] for r in rows}["ubuntu"],
                         "pkg:deb/ubuntu/ubuntu@{version}")
