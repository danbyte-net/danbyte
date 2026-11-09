"""List endpoints name the query parameters they ignored (core.query_params).

``GET /api/ips/?device_id=<uuid>`` used to answer every address in the tenant:
the filter is ``device``. A list now marks such a parameter in
``X-Danbyte-Unknown-Params`` and ``Warning``, or answers 400 in strict mode.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, override_settings
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from core.query_params import hint_for, list_view_class

from .models import Device, Interface, IPAddress, Prefix, Site

User = get_user_model()
HEADER = "X-Danbyte-Unknown-Params"


def _list_routes():
    """``(url, view class)`` for every list route without path arguments."""
    out = []

    def walk(patterns, prefix):
        for p in patterns:
            route = prefix + str(p.pattern).lstrip("^").rstrip("$")
            if isinstance(p, URLResolver):
                walk(p.url_patterns, route)
            elif isinstance(p, URLPattern):
                if any(c in route for c in "(<\\?*+[") or not route.startswith("api/"):
                    continue
                cls = list_view_class(p.callback, "GET")
                if cls is not None:
                    out.append(("/" + route, cls))

    walk(get_resolver().url_patterns, "")
    return sorted(set(out), key=lambda r: r[0])


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.r1 = Device.objects.create(tenant=self.tenant, name="r1", site=site)
        self.r2 = Device.objects.create(tenant=self.tenant, name="r2", site=site)
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.ip1 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.1", prefix=prefix, assigned_device=self.r1
        )
        self.ip2 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.2", prefix=prefix, assigned_device=self.r2
        )
        Interface.objects.create(device=self.r1, name="mgmt0")
        Interface.objects.create(device=self.r2, name="mgmt0")

    def ids(self, r):
        return sorted(row["id"] for row in r.json()["results"])


class UnknownParamTests(_Base):
    def test_unknown_param_is_named_and_results_unchanged(self):
        plain = self.client.get("/api/ips/")
        r = self.client.get("/api/ips/?foo=1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r[HEADER], "foo")
        self.assertEqual(r["Warning"], '299 - "Unknown query parameters ignored: foo"')
        self.assertEqual(self.ids(r), self.ids(plain))
        self.assertNotIn(HEADER, plain)

    def test_strict_param_is_a_400_with_hint(self):
        r = self.client.get("/api/devices/?site_idd=1&strict=1")
        self.assertEqual(r.status_code, 400)
        body = r.json()
        self.assertEqual(body["detail"], "Unknown query parameters")
        self.assertEqual(body["unknown"], ["site_idd"])

    def test_strict_header_and_hint_for_id_suffix(self):
        r = self.client.get("/api/interfaces/?devic=x&tenant_id=1", HTTP_X_DANBYTE_STRICT="1")
        self.assertEqual(r.status_code, 400)
        body = r.json()
        self.assertEqual(body["unknown"], ["devic", "tenant_id"])
        self.assertEqual(body["hint"].get("devic"), "device")

    @override_settings(API_STRICT_QUERY_PARAMS=True)
    def test_setting_turns_strict_on_and_strict_0_opts_out(self):
        self.assertEqual(self.client.get("/api/ips/?foo=1").status_code, 400)
        r = self.client.get("/api/ips/?foo=1&strict=0")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r[HEADER], "foo")
        self.assertEqual(self.client.get("/api/ips/").status_code, 200)

    def test_detail_and_actions_are_not_checked(self):
        r = self.client.get(f"/api/devices/{self.r1.pk}/?foo=1&strict=1")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(HEADER, r)

    def test_header_names_are_encoded(self):
        r = self.client.get("/api/ips/?a%22b%0d=1")
        self.assertEqual(r[HEADER], "a%22b%0D")

    def test_known_params_raise_no_header(self):
        cases = [
            f"/api/devices/?page=1&page_size=5&search=r&format=json&_=1&site={self.r1.site_id}",
            "/api/devices/?view=table&ordering=-name&include=serial_number&f_status=__none__",
            f"/api/ips/?device={self.r1.pk}&search=10.&status=&page_size=5",
            "/api/prefixes/?search=10&page=1&page_size=10&vrf=&site=&contained_in=",
            f"/api/interfaces/?device={self.r1.pk}&ordering=name&view=table&page_size=5",
            f"/api/cables/?device={self.r1.pk}&search=x&ordering=-updated&page_size=5",
            "/api/virtual-machines/?search=x&ordering=name&page_size=5&view=table",
            "/api/deploy-runs/?device=00000000-0000-0000-0000-000000000000&page_size=5",
            "/api/deploy-pipelines/?page_size=5&search=x",
        ]
        for url in cases:
            with self.subTest(url=url):
                r = self.client.get(url)
                self.assertEqual(r.status_code, 200, r.content[:300])
                self.assertNotIn(HEADER, r, r.get(HEADER))

    def test_a_param_read_only_with_another_is_unknown_alone(self):
        # `include` only counts with view=table; prefixes take no `status`.
        r = self.client.get("/api/devices/?include=serial_number")
        self.assertEqual(r[HEADER], "include")
        r = self.client.get("/api/prefixes/?status=x")
        self.assertEqual(r[HEADER], "status")

    def test_facets_and_table_ids_are_not_checked(self):
        r = self.client.get("/api/devices/facets/?foo=1&strict=1")
        self.assertEqual(r.status_code, 200)


class AliasTests(_Base):
    def test_device_id_is_an_alias_of_device_on_ips(self):
        r = self.client.get(f"/api/ips/?device_id={self.r1.pk}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.ids(r), [str(self.ip1.pk)])
        self.assertNotIn(HEADER, r)

    def test_alias_matches_canonical_on_interfaces(self):
        a = self.client.get(f"/api/interfaces/?device_id={self.r2.pk}")
        b = self.client.get(f"/api/interfaces/?device={self.r2.pk}")
        self.assertEqual(self.ids(a), self.ids(b))
        self.assertEqual(len(self.ids(a)), 1)

    def test_alias_and_canonical_disagreeing_is_a_400(self):
        r = self.client.get(f"/api/ips/?device_id={self.r1.pk}&device={self.r2.pk}")
        self.assertEqual(r.status_code, 400)
        self.assertIn("device_id", r.json())
        same = self.client.get(f"/api/ips/?device_id={self.r1.pk}&device={self.r1.pk}")
        self.assertEqual(same.status_code, 200)


class EveryListTests(_Base):
    """Every list route: known params raise no notice, and an unknown one is
    named on its own. A list that reads its parameters in bulk (so every name
    looks read) or reads one only on some requests shows up here; declare
    ``extra_query_params`` on it."""

    def test_every_list(self):
        routes = _list_routes()
        self.assertGreater(len(routes), 100)
        checked = 0
        for url, cls in routes:
            declared = list(getattr(cls, "extra_query_params", ()) or ())
            known = "&".join(["page=1", "page_size=5", "format=json", "_=1"]
                             + [f"{n}=" for n in declared])
            with self.subTest(url=url):
                r = self.client.get(f"{url}?{known}")
                if not 200 <= r.status_code < 300:
                    continue
                checked += 1
                self.assertNotIn(HEADER, r, f"{url}: {r.get(HEADER)}")
                r = self.client.get(f"{url}?zz_probe=1")
                self.assertEqual(r.get(HEADER), "zz_probe", url)
                r = self.client.get(f"{url}?zz_probe=1&strict=1")
                self.assertEqual(r.status_code, 400, url)
        self.assertGreater(checked, 100)


class HintTests(SimpleTestCase):
    def test_hints(self):
        pool = {"device", "site", "search", "page", "virtual_machine"}
        self.assertEqual(hint_for("device_id", pool), "device")
        self.assertEqual(hint_for("serach", pool), "search")
        self.assertEqual(hint_for("virtual_machin", pool), "virtual_machine")
        self.assertIsNone(hint_for("colour", pool))
