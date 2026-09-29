"""The list-column catalog (``GET /api/list-fields/?path=…``, #243).

It is derived from each list's serializer, so the tests pin the derivation
rules on the device list, check that every routed list builds one, and that
every key in it really is a path into a row of that list.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.urls import get_resolver
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant
from customization.models import CustomField

from .models import (
    VLAN,
    Device,
    DeviceRole,
    ExportTemplate,
    IPAddress,
    Location,
    Prefix,
    Rack,
    Region,
    Site,
)

User = get_user_model()


def _list_paths() -> list[str]:
    """Every mounted ``/api/…`` route that serves a viewset's list, with no
    URL arguments - the set of paths a table can fetch its rows from."""
    out: list[str] = []

    def walk(patterns, prefix):
        for p in patterns:
            route = prefix + str(p.pattern)
            if hasattr(p, "url_patterns"):
                walk(p.url_patterns, route)
                continue
            cb = p.callback
            actions = getattr(cb, "actions", None) or {}
            if getattr(cb, "cls", None) is None or actions.get("get") != "list":
                continue
            if "(?P<" in route or "<" in route:
                continue  # format suffixes and nested routes with arguments
            path = "/" + route.replace("^", "").replace("$", "")
            if path.startswith("/api/") and path not in out:
                out.append(path)

    walk(get_resolver().url_patterns, "")
    return out


def _at(row, key: str):
    """``row`` followed down ``key``; KeyError when a segment is missing."""
    value = row
    for part in key.split("."):
        if value is None:
            return None
        value = value[part]
    return value


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _user(self, name, object_types, sites=()):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=name, object_types=object_types, actions=["view"]
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        return user

    def _catalog(self, path, status=200):
        r = self.client.get("/api/list-fields/", {"path": path})
        self.assertEqual(r.status_code, status, r.content)
        return r.json()


class DeviceCatalogTests(_Base):
    def test_offers_the_row_fields_and_skips_plumbing(self):
        body = self._catalog("/api/devices/")
        fields = {f["key"]: f for f in body["fields"]}
        for key in (
            "location", "rack", "site", "site.region", "platform", "asset_tag",
            "serial_number", "position", "face", "airflow", "primary_ip",
            "secondary_ip", "oob_ip", "created_at", "config_template",
            "device_type.manufacturer",
        ):
            self.assertIn(key, fields)
        for key in (
            "id", "numid", "permissions", "custom_fields", "site_id", "rack_id",
            "hardware_count", "document_count", "virtual_chassis",
            "topology_card", "image_ports", "vc_renamed_interfaces",
            "device_type.manufacturer_id",
        ):
            self.assertNotIn(key, fields)
        self.assertEqual(body["model"], "api.device")
        self.assertEqual(body["cf_model"], "device")

        region = fields["site.region"]
        self.assertEqual(
            (region["label"], region["kind"], region["group"], region["related"]),
            ("Region", "object", "related", "api.region"),
        )
        self.assertEqual(fields["oob_ip"]["label"], "OOB IP")
        self.assertEqual(fields["created_at"]["label"], "Created")
        self.assertEqual(fields["created_at"]["kind"], "datetime")
        self.assertEqual(fields["position"]["kind"], "number")
        self.assertEqual(fields["description"]["kind"], "longtext")
        self.assertEqual(fields["config_template"]["path"], "config_template.resolved")
        # A method field annotated as a string is text, not a link to nowhere.
        self.assertEqual(fields["device_type.manufacturer"]["kind"], "text")
        airflow = fields["airflow"]
        self.assertEqual(airflow["kind"], "choice")
        self.assertEqual(airflow["setting"], "airflow")
        self.assertEqual(fields["effective_airflow"]["setting"], "airflow")
        self.assertEqual(
            fields["effective_airflow"]["options"], airflow["options"]
        )
        self.assertNotIn("setting", fields["asset_tag"])

    def test_real_fields_ending_in_id_are_kept(self):
        self.assertIn("vlan_id", {f["key"] for f in self._catalog("/api/vlans/")["fields"]})
        self.assertIn(
            "facility_id", {f["key"] for f in self._catalog("/api/racks/")["fields"]}
        )

    def test_long_taxonomies_are_named_and_display_twins_dropped(self):
        fields = {f["key"]: f for f in self._catalog("/api/interfaces/")["fields"]}
        self.assertEqual(fields["type"]["choices"], "interface_types")
        self.assertNotIn("options", fields["type"])
        self.assertNotIn("type_display", fields)

    def test_an_alias_is_one_column(self):
        keys = [f["key"] for f in self._catalog("/api/sites/")["fields"]]
        self.assertIn("location", keys)
        self.assertNotIn("address", keys)

    def test_routing_and_monitoring_lists_resolve_by_path(self):
        self.assertEqual(
            self._catalog("/api/routing/prefix-lists/")["model"], "routing.prefixlist"
        )
        body = self._catalog("/api/monitoring/templates/")
        self.assertEqual(body["model"], "monitoring.checktemplate")

    def test_only_list_paths_resolve(self):
        self._catalog("/api/nope/", 404)
        self._catalog("/api/devices/00000000-0000-0000-0000-000000000000/", 404)
        self._catalog("/admin/", 404)
        self._catalog("", 404)


class CustomFieldTests(_Base):
    def setUp(self):
        super().setUp()
        for i, (key, hidden) in enumerate([("owner", False), ("secret", True)]):
            CustomField.objects.create(
                tenant=self.tenant, key=key, label=key.title(), type="text",
                applies_to=["device"], hidden=hidden, weight=i,
            )
        CustomField.objects.create(
            tenant=self.tenant, key="vlan_only", label="VLAN only", type="text",
            applies_to=["vlan"],
        )

    def test_visible_definitions_ride_along(self):
        cfs = self._catalog("/api/devices/")["custom_fields"]
        self.assertEqual([c["key"] for c in cfs], ["owner"])
        self.assertEqual(cfs[0]["type"], "text")

    def test_a_device_viewer_without_the_field_catalog_still_gets_them(self):
        """The values are in every row they can read; the definitions that
        name them come with the list, not the custom-field catalog grant."""
        self._login(self._user("viewer", ["device"]))
        cfs = self._catalog("/api/devices/")["custom_fields"]
        self.assertEqual([c["key"] for c in cfs], ["owner"])
        self.assertEqual(
            self.client.get("/api/custom-fields/?model=device").status_code, 403
        )

    def test_site_local_fields_stay_with_their_site(self):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()
        a = Site.objects.create(tenant=self.tenant, name="A")
        b = Site.objects.create(tenant=self.tenant, name="B")
        CustomField.objects.create(
            tenant=self.tenant, key="b_local", label="B local", type="text",
            applies_to=["device"], owning_site=b,
        )
        self._login(self._user("site-a", ["device"], sites=[a]))
        keys = [c["key"] for c in self._catalog("/api/devices/")["custom_fields"]]
        self.assertEqual(keys, ["owner"])
        self._login(self.admin)
        keys = [c["key"] for c in self._catalog("/api/devices/")["custom_fields"]]
        self.assertEqual(sorted(keys), ["b_local", "owner"])

    def test_query_count_does_not_grow_with_definitions(self):
        self._catalog("/api/devices/")
        with CaptureQueriesContext(connection) as few:
            self._catalog("/api/devices/")
        for i in range(8):
            CustomField.objects.create(
                tenant=self.tenant, key=f"k{i}", label=f"K{i}", type="text",
                applies_to=["device"],
            )
        with CaptureQueriesContext(connection) as many:
            self._catalog("/api/devices/")
        self.assertEqual(len(few.captured_queries), len(many.captured_queries))


class GateTests(_Base):
    def test_the_catalog_is_gated_like_the_list(self):
        self._login(self._user("vlans-only", ["vlan"]))
        self._catalog("/api/devices/", 403)
        self.assertEqual(self.client.get("/api/devices/").status_code, 403)
        self._catalog("/api/vlans/")

    def test_no_tenant_is_refused(self):
        user = User.objects.create_user("lonely", password="x")
        self.client.force_login(user)
        self._catalog("/api/devices/", 403)

    def test_anonymous_is_refused(self):
        self.client.logout()
        r = self.client.get("/api/list-fields/", {"path": "/api/devices/"})
        self.assertIn(r.status_code, (401, 403))


class EveryListTests(_Base):
    """No routed list is left out, and no key points past its rows."""

    def _drf_request(self):
        from rest_framework.request import Request
        from rest_framework.test import APIRequestFactory, force_authenticate

        req = APIRequestFactory().get("/api/list-fields/")
        force_authenticate(req, user=self.admin)
        req.user = self.admin
        req.session = self.client.session
        return Request(req)

    def test_every_routed_list_builds_a_catalog(self):
        from api.list_fields import build_list_view

        paths = _list_paths()
        self.assertIn("/api/devices/", paths)
        self.assertIn("/api/routing/prefix-lists/", paths)
        self.assertIn("/api/monitoring/templates/", paths)
        failures = []
        for path in paths:
            r = self.client.get("/api/list-fields/", {"path": path})
            if r.status_code != 200:
                # Only where the list itself is closed: an integration or a
                # plugin that is not enabled for this tenant answers 404.
                listed = self.client.get(path).status_code
                if r.status_code != listed:
                    failures.append(f"{path}: {r.status_code}, list {listed}")
                continue
            fields = r.json()["fields"]
            if not fields:
                continue
            view = build_list_view(self._drf_request(), path)
            serializer = view.get_serializer_class()(context=view.get_serializer_context())
            for f in fields:
                top = f["key"].split(".")[0]
                field = serializer.fields.get(top)
                if field is None or field.write_only:
                    failures.append(f"{path}: {f['key']} is not a readable field")
        self.assertEqual(failures, [])

    def test_every_device_key_resolves_on_a_real_row(self):
        region = Region.objects.create(tenant=self.tenant, name="Nordics")
        site = Site.objects.create(tenant=self.tenant, name="HQ", region=region)
        loc = Location.objects.create(tenant=self.tenant, site=site, name="Hall")
        rack = Rack.objects.create(tenant=self.tenant, site=site, name="R1")
        tpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="tpl", object_type="api.device"
        )
        role = DeviceRole.objects.create(
            tenant=self.tenant, name="Access", slug="access", config_template=tpl
        )
        d = Device.objects.create(
            tenant=self.tenant, name="sw1", site=site, location=loc, rack=rack,
            position=1, role=role,
        )
        p = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        d.primary_ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.1", prefix=p, assigned_device=d
        )
        d.save()
        VLAN.objects.create(tenant=self.tenant, site=site, vlan_id=10, name="v10")
        for path in ("/api/devices/", "/api/vlans/", "/api/racks/", "/api/sites/"):
            rows = self.client.get(path).json()["results"]
            self.assertTrue(rows, path)
            for f in self._catalog(path)["fields"]:
                for row in rows:
                    try:
                        _at(row, f.get("path") or f["key"])
                    except (KeyError, TypeError):
                        self.fail(f"{path}: {f['key']} is not in the row")
        row = self.client.get("/api/devices/").json()["results"][0]
        self.assertEqual(_at(row, "site.region")["name"], "Nordics")
        self.assertEqual(_at(row, "config_template.resolved")["name"], "tpl")

    def test_every_customizable_list_serializes_custom_fields(self):
        """A model that can carry custom fields shows them on its list - else
        a field defined for it could never be seen or set."""
        from api.api_urls import router
        from core.models import CustomFieldsMixin

        missing = []
        for prefix, viewset, _basename in router.registry:
            qs = getattr(viewset, "queryset", None)
            if qs is None or not issubclass(qs.model, CustomFieldsMixin):
                continue
            serializer = viewset.serializer_class()
            if "custom_fields" not in serializer.fields:
                missing.append(prefix)
        self.assertEqual(missing, [])
