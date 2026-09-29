"""The list-column catalog (``GET /api/list-fields/?path=…``, #243).

It is derived from each list's serializer, so the tests pin the derivation
rules on the device list, check that every routed list builds one, and that
every key in it really is a path into a row of that list.
"""
from __future__ import annotations

import re

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext
from django.urls import get_resolver
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant
from customization.models import CustomField

from .list_fields import NAME_KEYS
from .models import (
    RIR,
    VLAN,
    Aggregate,
    Cable,
    CableTermination,
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    ExportTemplate,
    Interface,
    IPAddress,
    IPRange,
    Location,
    PortReservation,
    Prefix,
    Rack,
    Region,
    Site,
    VirtualMachine,
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


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_NOT_A_PART = re.compile(r"^(id|numid|slug|color)$|_(id|at|color)$")


def _named(v) -> bool:
    """objectName() in frontend/src/components/columns/auto-columns.tsx."""
    if not isinstance(v, dict):
        return v not in (None, "")
    return any(
        v.get(k) not in (None, "") and not isinstance(v.get(k), (dict, list))
        for k in NAME_KEYS
    )


def _reads(v) -> bool:
    """Whether the SPA's cell for ``v`` shows text: a list by its items'
    names, one record by its name or else its parts (objectText())."""
    if isinstance(v, list):
        return any(_named(x) for x in v)
    if not isinstance(v, dict) or _named(v):
        return True
    for k, x in v.items():
        if _NOT_A_PART.search(k) or x in (None, ""):
            continue
        if isinstance(x, str) and not _UUID.match(x):
            return True
        if isinstance(x, dict) and "color" not in x and _named(x):
            return True
    return isinstance(v.get("numid"), int)


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

    def test_single_instance_counts_and_flags_are_not_offered(self):
        """Tab counts computed for one object only (they read 0 on a list),
        row flags and the allocation figure set are not columns."""
        prefix = {f["key"] for f in self._catalog("/api/prefixes/")["fields"]}
        for key in ("dns_record_count", "static_route_count", "allocation",
                    "is_enumerable", "has_descendants", "vlan_vrf_mismatch", "family"):
            self.assertNotIn(key, prefix)
        self.assertIn("ip_count", prefix)
        ips = {f["key"] for f in self._catalog("/api/ips/")["fields"]}
        for key in ("certificate_count", "is_primary_for_device", "is_primary_for_vm",
                    "is_secondary_for_device", "is_oob_for_device"):
            self.assertNotIn(key, ips)
        racks = {f["key"] for f in self._catalog("/api/racks/")["fields"]}
        self.assertNotIn("max_weight_kg", racks)
        self.assertIn("total_weight_kg", racks)

    def test_labels_read_like_the_forms(self):
        racks = {f["key"]: f for f in self._catalog("/api/racks/")["fields"]}
        self.assertEqual(racks["outer_width_mm"]["label"], "Outer width (mm)")
        self.assertEqual(racks["total_weight_kg"]["label"], "Total weight (kg)")
        self.assertEqual(racks["desc_units"]["label"], "Descending units")
        agg = {f["key"]: f for f in self._catalog("/api/aggregates/")["fields"]}
        self.assertEqual(
            (agg["utilisation_pct"]["label"], agg["utilisation_pct"]["kind"]),
            ("Utilisation %", "number"),
        )
        wlan = {f["key"]: f for f in self._catalog("/api/wireless-lans/")["fields"]}
        self.assertEqual(wlan["pmf"]["label"], "PMF")

    def test_lists_of_unnamed_records_are_not_offered(self):
        keys = {f["key"] for f in self._catalog("/api/circuits/")["fields"]}
        self.assertNotIn("terminations", keys)
        keys = {f["key"] for f in self._catalog("/api/fhrp-groups/")["fields"]}
        self.assertNotIn("assignments", keys)
        keys = {f["key"] for f in self._catalog("/api/virtual-machines/")["fields"]}
        self.assertIn("disks", keys)

    def test_only_list_paths_resolve(self):
        self._catalog("/api/nope/", 404)
        self._catalog("/api/devices/00000000-0000-0000-0000-000000000000/", 404)
        self._catalog("/admin/", 404)
        self._catalog("", 404)


class MethodKindTests(SimpleTestCase):
    def test_extend_schema_field_types_a_getter_with_no_hint(self):
        from drf_spectacular.types import OpenApiTypes
        from drf_spectacular.utils import extend_schema_field
        from rest_framework import serializers

        from .list_fields import _kind_from_method

        class S(serializers.Serializer):
            pct = serializers.SerializerMethodField()
            macs = serializers.SerializerMethodField()

            @extend_schema_field(OpenApiTypes.INT)
            def get_pct(self, obj):
                return 1

            @extend_schema_field(serializers.ListField())
            def get_macs(self, obj):
                return []

        s = S()
        self.assertEqual(_kind_from_method(s, s.fields["pct"]), "number")
        # A list-typed getter is left to the model field or the value's shape.
        self.assertIsNone(_kind_from_method(s, s.fields["macs"]))


class RenderedValueTests(_Base):
    """Every column the catalog offers reads as text on real rows - the first
    non-empty value of each field renders something in the SPA's cell
    (``_reads`` mirrors objectName/objectText in auto-columns.tsx)."""

    PATHS = (
        "/api/devices/", "/api/interfaces/", "/api/prefixes/", "/api/ips/",
        "/api/racks/", "/api/virtual-machines/", "/api/cables/", "/api/sites/",
        "/api/vlans/", "/api/aggregates/",
    )

    def setUp(self):
        super().setUp()
        t = self.tenant
        region = Region.objects.create(tenant=t, name="Nordics")
        site = Site.objects.create(tenant=t, name="HQ", region=region)
        loc = Location.objects.create(tenant=t, site=site, name="Hall")
        rack = Rack.objects.create(tenant=t, site=site, location=loc, name="R1")
        sw = Device.objects.create(tenant=t, name="sw1", site=site, rack=rack, position=1)
        srv = Device.objects.create(tenant=t, name="srv1", site=site, location=loc)
        gi1 = Interface.objects.create(device=sw, name="Gi1/0/1")
        gi2 = Interface.objects.create(device=sw, name="Gi1/0/2")
        eno1 = Interface.objects.create(device=srv, name="eno1")
        cable = Cable.objects.create(tenant=t, type="cat6")
        CableTermination.objects.create(cable=cable, end="A", interface=gi1)
        CableTermination.objects.create(cable=cable, end="B", interface=eno1)
        PortReservation.objects.create(tenant=t, interface=gi2, claimed_by=self.admin,
                                       note="spare")
        p = Prefix.objects.create(tenant=t, cidr="10.0.0.0/24", site=site,
                                  allocate_from_ranges=True)
        IPRange.objects.create(tenant=t, prefix=p, start_address="10.0.0.10",
                               end_address="10.0.0.20")
        sw.primary_ip = IPAddress.objects.create(
            tenant=t, ip_address="10.0.0.1", prefix=p, assigned_device=sw,
            assigned_interface=gi1,
        )
        sw.save()
        VLAN.objects.create(tenant=t, site=site, vlan_id=10, name="v10")
        ct = ClusterType.objects.create(tenant=t, name="t", slug="t")
        cl = Cluster.objects.create(tenant=t, name="c", type=ct)
        VirtualMachine.objects.create(tenant=t, name="vm1", cluster=cl, site=site)
        rir = RIR.objects.create(tenant=t, name="RIPE", slug="ripe")
        Aggregate.objects.create(tenant=t, prefix="10.0.0.0/8", rir=rir)

    def test_every_offered_value_reads_as_text(self):
        failures = []
        for path in self.PATHS:
            rows = self.client.get(path).json()["results"]
            self.assertTrue(rows, path)
            for f in self._catalog(path)["fields"]:
                values = []
                for row in rows:
                    try:
                        v = _at(row, f.get("path") or f["key"])
                    except (KeyError, TypeError):
                        v = None
                    if v not in (None, "", []):
                        values.append(v)
                if values and not _reads(values[0]):
                    failures.append(f"{path} {f['key']}: {values[0]!r}")
        self.assertEqual(failures, [])

    def test_a_link_peer_reads_as_its_device_and_port(self):
        rows = self.client.get("/api/interfaces/").json()["results"]
        peer = next(r["link_peer"] for r in rows if r["name"] == "Gi1/0/1")
        self.assertEqual((peer["device"], peer["port"]), ("srv1", "eno1"))
        self.assertTrue(_reads(peer))


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

    def test_every_table_registry_api_is_a_list(self):
        """frontend/src/lib/tables.ts names the list each table's rows come
        from; a path that is not a list would offer no columns (or wrong
        ones)."""
        import re
        from pathlib import Path

        from django.conf import settings

        tables = Path(settings.BASE_DIR) / "frontend/src/lib/tables.ts"
        if not tables.exists():
            self.skipTest("frontend source not present")
        paths = sorted(set(re.findall(r'"(/api/[a-z0-9/_-]+/)"', tables.read_text())))
        self.assertGreater(len(paths), 50)
        bad = []
        for path in paths:
            r = self.client.get("/api/list-fields/", {"path": path})
            if r.status_code == 200:
                continue
            listed = self.client.get(path).status_code
            if listed == 200 or r.status_code != listed:
                bad.append(f"{path}: {r.status_code}, list {listed}")
        self.assertEqual(bad, [])

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
