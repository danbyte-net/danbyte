"""The web app's own list requests pass strict query-parameter checking.

``API_STRICT_QUERY_PARAMS`` is on by default: a list answers 400 to a
parameter it does not read. Every list URL the frontend writes (read
statically from ``frontend/src`` by ``api.frontend_queries``), the ones it
builds at run time (``DYNAMIC_CALLS``) and the docs' examples are sent here
with the parameters they carry, and must come back without naming any of
them unknown.
"""
from __future__ import annotations

import uuid
from urllib.parse import urlencode

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, override_settings
from django.urls import Resolver404, resolve
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from core.query_params import list_view_class

from .frontend_queries import FRONTEND_SRC, extract_calls, extract_doc_calls
from .models import Device, Site

User = get_user_model()
HEADER = "X-Danbyte-Unknown-Params"
_ID = str(uuid.UUID(int=1))


def _p(*names, **values):
    return {**dict.fromkeys(names, ""), **values}


#: Lists the frontend asks with parameter names it computes at run time,
#: which the static pass cannot read: ``(where, path, params)``.
DYNAMIC_CALLS = [
    # A device's or a VM's: services, credentials, host keys, software,
    # connect protocols and PRTG pins/links/sensors, keyed by the host kind.
    *[
        (src, path, _p(key, *extra))
        for src, path, keys, extra in [
            ("services-pane.tsx", "/api/services/", ("device", "vm"), ()),
            ("application-flow-pane.tsx", "/api/services/", ("device", "vm"), ()),
            ("device-credentials-card.tsx", "/api/monitoring/device-credentials/",
             ("device", "virtual_machine"), ()),
            ("ssh-host-keys-panel.tsx", "/api/monitoring/ssh-host-keys/",
             ("device", "virtual_machine"), ()),
            ("host-connect-menu.tsx", "/api/monitoring/connect-protocols/",
             ("device", "virtual_machine"), ("enabled",)),
            ("software-summary-card.tsx", "/api/installed-software/",
             ("device", "virtual_machine"), ("page_size",)),
            ("show-on-floor-plan.tsx", "/api/floor-plan-tiles/",
             ("device", "rack", "cabinet"), ()),
            ("sensor-pins.tsx", "/api/prtg/sensor-pins/",
             ("device", "virtual_machine", "ip_address", "interface", "vm_interface",
              "service"), ()),
            ("sensors-tab.tsx", "/api/prtg/links/", ("device", "virtual_machine"), ()),
            ("sensors-tab.tsx", "/api/prtg/sensors/",
             ("device", "virtual_machine", "ip_address", "interface", "service"),
             ("ordering",)),
            ("embedded-device-table.tsx", "/api/devices/",
             ("role", "platform", "site", "room", "location", "device_type"),
             ("page_size",)),
            ("embedded-device-type-table.tsx", "/api/device-types/", ("manufacturer",),
             ("page_size",)),
            ("dns-records-table.tsx", "/api/dns-records/", ("ip", "prefix", "zone"),
             ("page_size",)),
        ]
        for key in keys
    ],
    # The prefix list's free-space and tree-rail parameters.
    ("prefixes.index.tsx", "/api/prefixes/",
     _p("search", "length", "scope", "within", free="1")),
    ("prefixes.index.tsx", "/api/prefixes/", _p("search", "vrf")),
    # The server-paged lists (lib/server-list.ts): the slim table rows, the
    # columns' extra fields, sorting and the rail's f_<facet> and expr.
    *[
        ("server-list.ts", path,
         _p("search", "ordering", "include", "expr", view="table", page="1",
            page_size="50", **{f"f_{f}": "x" for f in facets}))
        for path, facets in [
            ("/api/devices/", ("status", "site", "role", "tags")),
            ("/api/interfaces/", ("device", "status", "tags")),
            ("/api/cables/", ("type", "status", "tags")),
            ("/api/virtual-machines/", ("cluster", "status", "tags")),
        ]
    ],
]


def _list_calls():
    """``(call, url, view class)`` for every frontend call that hits a list."""
    from .frontend_queries import Call

    out = []
    dynamic = [Call(src, 0, path, params) for src, path, params in DYNAMIC_CALLS]
    for call in [*extract_calls(), *dynamic, *extract_doc_calls()]:
        path = call.path.replace("{}", _ID)
        if "{" in path or not path.endswith("/"):
            continue
        try:
            match = resolve(path)
        except Resolver404:
            continue
        cls = list_view_class(match.func, "GET")
        if cls is not None and call.params:
            out.append((call, path, cls))
    return out


class ExtractorTests(SimpleTestCase):
    def test_sources_are_found(self):
        self.assertTrue(FRONTEND_SRC.is_dir(), FRONTEND_SRC)
        calls = extract_calls()
        self.assertGreater(len(calls), 1000)

    def test_shapes(self):
        from . import frontend_queries as fq

        text = (
            'const p = new URLSearchParams({ device: id, view: "table" })\n'
            'p.set("ordering", o)\n'
            "api(`/api/interfaces/?${p}`)\n"
            "api(`/api/ips/?device=${d}&page_size=50${x ? `&vrf=${x}` : \"\"}`)\n"
            'api("/api/racks/?picker=1" + (s ? `&site=${s}` : ""))\n'
        )
        literals = fq._lex(text)
        self.assertTrue(any(raw.startswith("/api/interfaces/") for *_, raw in literals))
        root = self._tmp_tree({"a.tsx": text})
        calls = {c.path: c for c in extract_calls(root)}
        self.assertEqual(
            set(calls["/api/interfaces/"].params), {"device", "view", "ordering"}
        )
        self.assertEqual(set(calls["/api/ips/"].params), {"device", "page_size", "vrf"})
        self.assertEqual(calls["/api/ips/"].params["page_size"], "50")
        self.assertEqual(set(calls["/api/racks/"].params), {"picker", "site"})

    def _tmp_tree(self, files):
        import tempfile
        from pathlib import Path

        root = Path(tempfile.mkdtemp())
        for name, text in files.items():
            (root / name).write_text(text)
        self.addCleanup(lambda: __import__("shutil").rmtree(root))
        return root


@override_settings(DISCOVERY_ENABLED=True)
class FrontendListParamsTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.site_id = str(site.pk)
        Device.objects.create(tenant=self.tenant, name="r1", site=site)
        # Every integration on, so their lists answer rather than 404.
        from integrations.models import IntegrationSettings
        from integrations.toggles import KEYS
        from vulnerabilities.models import VulnerabilitySettings

        IntegrationSettings.objects.update_or_create(
            tenant=self.tenant, defaults={field: True for field in KEYS.values()})
        vulns = VulnerabilitySettings.load()
        vulns.enabled = True
        vulns.save()

    def unknown_names(self, path, params) -> set[str] | None:
        """The names of ``params`` the list ignored, or None when it did
        not answer 2xx. A value the frontend computes is sent empty, then
        as an id, a number and a flag: a parameter read only when another
        is set (``include_shared`` with a ``site``) counts as understood
        when any of them reads it."""
        unknown = None
        for fill in ("", self.site_id, "1", "true"):
            query = urlencode({k: v if v else fill for k, v in params.items()})
            r = self.client.get(f"{path}?{query}&strict=0")
            if not 200 <= r.status_code < 300:
                continue
            got = {n.strip() for n in r.get(HEADER, "").split(",") if n.strip()}
            unknown = got if unknown is None else unknown & got
            if not unknown:
                return unknown
        return unknown

    def test_every_frontend_list_call_is_understood(self):
        calls = _list_calls()
        self.assertGreater(len(calls), 300)
        failures, refused = [], []
        checked = 0
        for call, path, _cls in calls:
            unknown = self.unknown_names(path, call.params)
            if unknown is None:
                refused.append(f"{call.file}:{call.line} {path}")
                continue
            checked += 1
            if unknown:
                failures.append(f"{call.file}:{call.line} {path} -> {', '.join(sorted(unknown))}")
        # A list that refuses every request here (a 404 for a feature that
        # needs more than its switch) is not checked; most are.
        self.assertGreater(checked, len(calls) * 0.9, "\n".join(refused))
        self.assertEqual(failures, [], "\n" + "\n".join(failures))


class FixedFilterTests(APITestCase):
    """Parameters the web app sent that their lists ignored, now honoured."""

    def setUp(self):
        from .models import Cable, Cluster, ClusterType

        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        kind = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=kind)
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.host = Device.objects.create(tenant=self.tenant, name="h1", site=site,
                                          cluster=self.cluster)
        Device.objects.create(tenant=self.tenant, name="other", site=site)
        self.fibre = Cable.objects.create(tenant=self.tenant, type="smf-os2")
        Cable.objects.create(tenant=self.tenant, type="cat6")

    def test_devices_by_cluster(self):
        r = self.client.get(f"/api/devices/?cluster={self.cluster.pk}&page_size=200")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([d["id"] for d in r.json()["results"]], [str(self.host.pk)])

    def test_fibre_cables_only(self):
        r = self.client.get("/api/cables/?fiber=1")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([c["id"] for c in r.json()["results"]], [str(self.fibre.pk)])
        self.assertEqual(len(self.client.get("/api/cables/").json()["results"]), 2)
