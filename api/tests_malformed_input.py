"""Malformed input answers 400, never 500 (#373).

A sweep over every ``/api/`` route the URL resolver knows: each one is sent
JSON bodies that are not objects, and query strings with non-numeric
numbers and NUL bytes. Detail routes get a real row where the fixture has
one, so the action behind the lookup runs. Outbound side effects (job
queues, subprocesses, sockets) are stubbed for the sweep.
"""
from __future__ import annotations

import re
import socket
import uuid
from decimal import Decimal
from unittest import mock

from django.contrib.auth import get_user_model
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    VRF,
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    IPAddress,
    Manufacturer,
    Prefix,
    Site,
    Status,
)

User = get_user_model()

# Bodies a JSON client can send that are valid JSON but not an object.
NON_OBJECT_BODIES = ('"x"', '[{"a": 1}]', "null")

# Query parameters the API parses as numbers, ids or flags somewhere; each
# given a value that is none of those.
GARBAGE_PARAMS = (
    "limit", "offset", "page", "page_size", "cursor", "n", "days", "hours",
    "since", "until", "from", "to", "start", "end", "id", "ids", "site",
    "device", "prefix", "vrf", "tenant", "location", "rack", "interface",
    "window", "depth", "level", "top", "max", "min", "year", "month",
)
NUL_PARAMS = ("status", "tag", "search", "q", "name", "kind", "type", "role")

# Routes that legitimately accept a top-level JSON array. A view opts in
# with ``allow_json_list = True`` (see api/parsers.py). ``api/mcp/`` takes
# JSON-RPC batches but keeps DRF's plain parser and answers every other
# shape with a protocol error itself; it is swept like the rest.
LIST_BODY_ROUTES: tuple[str, ...] = ()

# The OpenAPI schema and its viewers: generated, take no input, and cost
# seconds a call.
SKIP_ROUTES = ("api/schema/", "api/docs/", "api/docs/redoc/")

_LOOPBACK = ("127.0.0.1", "::1", "localhost")


def _loopback_only(connect):
    """``socket.connect`` that reaches the local database and Redis only;
    anything outbound fails as an unreachable host would."""

    def guarded(sock, address):
        host = address[0] if isinstance(address, tuple) else None
        if host is not None and host not in _LOOPBACK:
            raise OSError("outbound connections are stubbed in this test")
        return connect(sock, address)

    return guarded


_GROUP = re.compile(r"\(\?P<(\w+)>[^)]*\)")
_CONVERTER = re.compile(r"<(?:(\w+):)?(\w+)>")


def api_routes():
    """``(route, callback)`` for every ``/api/`` URL pattern, router format
    suffix variants left out."""
    out = []

    def walk(patterns, prefix):
        for p in patterns:
            route = prefix + str(p.pattern)
            if isinstance(p, URLResolver):
                walk(p.url_patterns, route)
            elif isinstance(p, URLPattern):
                clean = route.replace("^", "").replace("$", "")
                if "(?P<format>" in clean or r"\.(?P<format>" in clean:
                    continue
                if clean.startswith("api/") and clean not in SKIP_ROUTES:
                    out.append((clean, p.callback))

    walk(get_resolver().url_patterns, "")
    return out


class MalformedInputSweep(APITestCase):
    maxDiff = None

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.site = Site.objects.create(tenant=t, name="dc-1")
        mfr = Manufacturer.objects.create(tenant=t, name="M", slug="m")
        dtype = DeviceType.objects.create(tenant=t, manufacturer=mfr, model="x1")
        role = DeviceRole.objects.create(tenant=t, name="R", slug="r")
        Status.objects.get_or_create(tenant=t, slug="active", defaults={"name": "Active"})
        a = Device.objects.create(tenant=t, name="a", site=self.site, device_type=dtype,
                                  role=role)
        b = Device.objects.create(tenant=t, name="b", site=self.site, role=role)
        cab = Cable.objects.create(tenant=t)
        CableTermination.objects.create(
            cable=cab, end="A", interface=Interface.objects.create(device=a, name="e0")
        )
        CableTermination.objects.create(
            cable=cab, end="B", interface=Interface.objects.create(device=b, name="e0")
        )
        VRF.objects.create(tenant=t, name="blue")
        p = Prefix.objects.create(tenant=t, cidr="10.0.0.0/24")
        IPAddress.objects.create(tenant=t, ip_address="10.0.0.1", prefix=p)
        from core.models import Tag
        from monitoring.models import SlaAgreement
        from scripting.models import Script

        Tag.objects.create(tenant=t, name="Core", slug="core")
        SlaAgreement.objects.create(tenant=t, name="Gold", target_pct=Decimal("99.000"),
                                    timezone="UTC")
        Script.objects.create(tenant=t, name="s", owner=self.admin)
        self.by_param = {"device": a.pk, "site": self.site.pk, "cable": cab.pk,
                         "prefix": p.pk}

    # ── route filling ───────────────────────────────────────────────────

    def _row_pk(self, callback):
        cls = getattr(callback, "cls", None)
        qs = getattr(cls, "queryset", None)
        if qs is None:
            return None
        try:
            row = qs.model._default_manager.filter(pk__in=qs.values("pk")).first()
        except Exception:  # noqa: BLE001 - a queryset that needs a request
            return None
        return row.pk if row is not None else None

    def _value(self, name, kind, callback):
        if name == "pk":
            return self._row_pk(callback) or uuid.uuid4()
        for key, pk in self.by_param.items():
            if name.startswith(key):
                return pk
        if kind == "int" or name in ("user_id", "pk_int"):
            return 1
        if kind in ("slug", "str", "path") and not name.endswith("id"):
            return "x"
        return uuid.uuid4()

    def _fill(self, route, callback):
        route = _GROUP.sub(
            lambda m: str(self._value(m.group(1), None, callback)), route
        )
        route = _CONVERTER.sub(
            lambda m: str(self._value(m.group(2), m.group(1), callback)), route
        )
        route = route.replace("\\", "").replace("/?", "/")
        return "/" + route

    def _urls(self):
        seen, out = set(), []
        for route, callback in api_routes():
            url = self._fill(route, callback)
            if url not in seen:
                seen.add(url)
                out.append((route, url))
        return out

    # ── sweep ───────────────────────────────────────────────────────────

    def _login(self):
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _sweep(self, calls):
        self.client.raise_request_exception = False
        failures = []
        self._login()
        with (
            mock.patch("rq.queue.Queue.enqueue_job", autospec=True),
            mock.patch("subprocess.Popen", side_effect=FileNotFoundError("stubbed")),
            mock.patch("socket.socket.connect", _loopback_only(socket.socket.connect)),
        ):
            for method, url, kwargs in calls:
                r = getattr(self.client, method)(url, **kwargs)
                if "logout" in url or r.status_code == 401:
                    self._login()
                if r.status_code >= 500:
                    exc = getattr(r, "exc_info", None)
                    failures.append(
                        f"{method.upper()} {url} {kwargs.get('data', kwargs.get('QUERY_STRING', ''))!r}"
                        f" -> {r.status_code} {exc[1]!r}" if exc else
                        f"{method.upper()} {url} -> {r.status_code}"
                    )
        return failures

    def test_non_object_json_body_never_500(self):
        calls = []
        for route, url in self._urls():
            if route in LIST_BODY_ROUTES:
                continue
            for body in NON_OBJECT_BODIES:
                calls.append(("post", url, {"data": body, "content_type": "application/json"}))
            if "<" in route:
                calls.append(("patch", url, {"data": '"x"', "content_type": "application/json"}))
        self.assertGreater(len(calls), 1000)
        self.assertEqual(self._sweep(calls), [])

    def test_garbage_query_params_never_500(self):
        garbage = "&".join(f"{k}=abc" for k in GARBAGE_PARAMS)
        nul = "&".join(f"{k}=%00" for k in NUL_PARAMS)
        calls = []
        for _route, url in self._urls():
            calls.append(("get", f"{url}?{garbage}", {}))
            calls.append(("get", f"{url}?{nul}", {}))
            calls.append(("get", f"{url}?limit=abc", {}))
        self.assertEqual(self._sweep(calls), [])

    def test_sweep_reaches_the_reported_routes(self):
        """Guards the sweep from passing on 404s: the routes in the report
        resolve to real rows."""
        urls = {route: url for route, url in self._urls()}
        dev = str(self.by_param["device"])
        self.assertIn(f"/api/devices/{dev}/deploy/", urls.values())
        self.assertIn(f"/api/cables/{self.by_param['cable']}/auto-route/", urls.values())
        self.assertIn(f"/api/prefixes/{self.by_param['prefix']}/populate/", urls.values())
        self.assertTrue(any(u.startswith("/api/scripts/") and u.endswith("/run/")
                            and "None" not in u for u in urls.values()))


class NonObjectBodyAnswers(APITestCase):
    """The reported routes answer 400 with a field error (#373)."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.site = Site.objects.create(tenant=self.tenant, name="dc-1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dtype = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="x1")
        self.device = Device.objects.create(tenant=self.tenant, name="a", site=self.site,
                                            device_type=dtype)

    def test_string_and_list_bodies(self):
        for path in (f"/api/devices/{self.device.pk}/deploy/",
                     f"/api/devices/{self.device.pk}/config-state/",
                     f"/api/devices/{self.device.pk}/sync-from-type/",
                     "/api/deployment/email/test/"):
            for body in ('"x"', "[]"):
                with self.subTest(path=path, body=body):
                    r = self.client.post(path, body, content_type="application/json")
                    self.assertEqual(r.status_code, 400, r.content)
                    self.assertIn("non_field_errors", r.json())

    def test_object_and_empty_bodies_still_parse(self):
        r = self.client.post("/api/devices/bulk-delete/", {"ids": []}, format="json")
        self.assertNotEqual(r.status_code, 400, r.content)
        r = self.client.post(f"/api/devices/{self.device.pk}/config-pushed/")
        self.assertLess(r.status_code, 500)

    def test_nul_in_a_query_parameter(self):
        for path in ("/api/backups/?status=%00", "/api/dashboard/?tag=%00",
                     "/api/devices/?name=a%00b"):
            with self.subTest(path=path):
                r = self.client.get(path)
                self.assertEqual(r.status_code, 400, r.content)

    def test_non_numeric_limit(self):
        for path in ("/api/agent/calls/?limit=abc", "/api/agent/calls/?offset=x"):
            with self.subTest(path=path):
                r = self.client.get(path)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertTrue(set(r.json()) & {"limit", "offset"}, r.json())
