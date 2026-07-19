"""Import a NetBox instance into Danbyte over the NetBox REST API.

    manage.py import_netbox --url https://netbox.example.com --token <TOKEN> \
        [--tenant <slug>] [--only sites,devices] [--skip cables] \
        [--insecure] [--dry-run] [--report netbox-import.json]

Everything lands in ONE Danbyte tenant (hard isolation boundary). NetBox's own
`tenant` label is kept in each object's `custom_fields.netbox_tenant` for
reference — it is not turned into separate Danbyte tenants (that's a deliberate
policy decision, not something to infer).

Design:
  * objects are imported in dependency order; an in-memory id-map
    (netbox_type, netbox_id) -> Danbyte instance resolves foreign keys.
  * idempotent: every object is matched on a natural key (or, for cables, on an
    existing termination), so re-running only fills gaps. Existing rows are left
    untouched (counted "existed") unless --update-existing re-applies NetBox
    values over them (counted "updated").
  * resilient: each object is created in its own savepoint; one failure is
    recorded (type, name, netbox id, reason) and the import continues.
  * --dry-run runs the whole thing inside a transaction and rolls back, so you
    get real created/failed counts without persisting anything.

Unsupported NetBox concepts (site-groups, rack-reservations, NAT self-links,
scripts, etc.) are skipped by design — see docs/architecture/netbox-parity.md.
"""
from __future__ import annotations

import json
from collections import defaultdict

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils.text import slugify

from api.status_registry import resolve_status, seed_builtin_statuses
from core.models import Organization, Tenant, Tag
from customization.models import CustomField
from api import models as m


# NetBox custom-field type → Danbyte CustomField.type (text/textarea/integer/
# decimal/boolean/date/url/select). Unsupported types degrade to text.
NB_CF_TYPE = {
    "text": "text",
    "longtext": "textarea",
    "integer": "integer",
    "decimal": "decimal",
    "boolean": "boolean",
    "date": "date",
    "datetime": "text",
    "url": "url",
    "select": "select",
    "multiselect": "select",
    "json": "textarea",
    "object": "text",
    "multiobject": "text",
}


class _Rollback(Exception):
    """Raised at the end of a --dry-run to unwind the transaction."""


# NetBox content-type string -> our resource key (for generic references:
# contact assignments, cable terminations, IP interface assignments).
NB_CT = {
    "dcim.device": "devices",
    "dcim.site": "sites",
    "dcim.rack": "racks",
    "dcim.location": "locations",
    "dcim.region": "regions",
    "dcim.manufacturer": "manufacturers",
    "dcim.devicetype": "device_types",
    "dcim.interface": "interfaces",
    "dcim.frontport": "front_ports",
    "dcim.rearport": "rear_ports",
    "dcim.consoleport": "console_ports",
    "dcim.consoleserverport": "console_server_ports",
    "dcim.powerport": "power_ports",
    "dcim.poweroutlet": "power_outlets",
    "dcim.powerfeed": "power_feeds",
    "circuits.circuittermination": "circuit_terminations",
    "ipam.prefix": "prefixes",
    "ipam.ipaddress": "ip_addresses",
    "ipam.vlan": "vlans",
    "ipam.vrf": "vrfs",
    "ipam.aggregate": "aggregates",
    "ipam.asn": "asns",
    "virtualization.cluster": "clusters",
    "virtualization.virtualmachine": "virtual_machines",
    "virtualization.vminterface": "vm_interfaces",
    "circuits.circuit": "circuits",
    "circuits.provider": "providers",
    "tenancy.contact": "contacts",
}

# CableTermination FK attribute per component resource key.
CT_ATTR = {
    "interfaces": "interface",
    "front_ports": "front_port",
    "rear_ports": "rear_port",
    "console_ports": "console_port",
    "console_server_ports": "console_server_port",
    "power_ports": "power_port",
    "power_outlets": "power_outlet",
    "power_feeds": "power_feed",
}


class NetBoxClient:
    """Thin paginated GET client for the NetBox REST API.

    ``guard=True`` (the web path) SSRF-checks every URL before fetching and
    refuses redirects — a tenant admin supplies the URL, so the server must
    not be talked into reaching loopback / cloud-metadata / internal hosts.
    The CLI runs unguarded: an operator's NetBox is almost always an internal
    address, and guarding it would break the feature's main use. An internal
    NetBox behind the web path is reachable via ``DANBYTE_SSRF_ALLOWLIST``
    (the same escape hatch SMTP uses).
    """

    def __init__(self, base_url: str, token: str, verify: bool = True,
                 guard: bool = False):
        import httpx

        self.base = base_url.rstrip("/")
        self.guard = guard
        self.verify = verify
        self._headers = {
            "Authorization": f"Token {token}",
            "Accept": "application/json",
        }
        if guard:
            from core.ssrf import assert_public_url

            assert_public_url(self.base)
            # Guarded (web-triggered, attacker-controlled host): don't touch the
            # target with a plain httpx client — assert_public_url only
            # resolve-and-checks, and httpx re-resolves at connect time, so the
            # host could DNS-rebind to 169.254.169.254 / an internal address
            # between the two. Every guarded fetch goes through
            # core.ssrf.safe_get, which pins the connection to the validated IP
            # and refuses redirects.
            self.client = None
        else:
            self.client = httpx.Client(
                # NetBox's front-port / rear-port list endpoints compute
                # link_peers per row and can be far slower than the rest of the
                # API on cabled patch panels — 60s was enough for 80k interface
                # templates but not always for a 250-row port page.
                timeout=120,
                verify=verify,
                follow_redirects=True,
                headers=self._headers,
            )

    def _get(self, url: str):
        if self.guard:
            # Pinned, redirect-refusing GET — closes the DNS-rebinding TOCTOU.
            import requests

            from core.ssrf import safe_get

            try:
                return safe_get(
                    url, headers=self._headers, timeout=120, verify=self.verify
                )
            except requests.exceptions.Timeout:
                return safe_get(
                    url, headers=self._headers, timeout=120, verify=self.verify
                )
        import httpx

        try:
            return self.client.get(url)
        except httpx.TimeoutException:
            return self.client.get(url)  # one retry — slow pages, not dead hosts

    def list_url(self, path: str) -> str:
        """First-page URL for a list path.

        `path` may carry its own query string (e.g. the module-type
        interface-template filter) — splice it in before ``limit`` instead of
        appending after it, which produced `…?filter/?limit=250`, a 301 from
        NetBox, and (redirects being refused under guard) a failed fetch.
        """
        p, _, query = path.strip("/").partition("?")
        qs = f"{query}&limit=250" if query else "limit=250"
        return f"{self.base}/api/{p.strip('/')}/?{qs}"

    def list(self, path: str) -> list[dict]:
        """All objects at /api/<path>/, following pagination."""
        url = self.list_url(path)
        out: list[dict] = []
        while url:
            r = self._get(url)
            r.raise_for_status()
            data = r.json()
            out.extend(data.get("results", []))
            url = data.get("next")
        return out

    def status(self) -> dict:
        """NetBox's /api/status/ — version probe for the connection test."""
        r = self._get(f"{self.base}/api/status/")
        r.raise_for_status()
        return r.json()

    def count(self, path: str) -> int:
        """The `count` from a NetBox list endpoint (limit=1), for the preview."""
        r = self._get(f"{self.base}/api/{path.strip('/')}/?limit=1")
        r.raise_for_status()
        return int(r.json().get("count") or 0)

    def get_bytes(self, url: str) -> bytes:
        """Download a media file (absolute URL) using the same auth session."""
        r = self._get(url)
        r.raise_for_status()
        return r.content


def _color(c: str | None) -> str:
    if not c:
        return ""
    return c if c.startswith("#") else f"#{c}"


def _val(nb_field):
    """NetBox choice fields are {'value','label'}; return the value."""
    if isinstance(nb_field, dict):
        return nb_field.get("value")
    return nb_field


def _addr(a: str | None) -> str | None:
    """'10.0.0.5/24' -> '10.0.0.5'."""
    return a.split("/")[0] if a else a


class _Importer:
    def __init__(self, cmd, client: NetBoxClient, tenant: Tenant, opts: dict,
                 on_progress=None):
        self.cmd = cmd
        self.nb = client
        self.tenant = tenant
        self.opts = opts
        # Called as on_progress(step_index, step_total, key, stats_snapshot)
        # after each step and, throttled, mid-fetch for big types. The CLI
        # passes None (no-op); the background job writes the run row + job.meta.
        self.on_progress = on_progress or (lambda *a, **k: None)
        self._step_i = 0
        self._step_total = 0
        self.idmap: dict[tuple[str, int], object] = {}
        self.stats = defaultdict(
            lambda: {
                "fetched": 0, "created": 0, "existed": 0,
                "updated": 0, "failed": 0, "skipped": 0,
            }
        )
        # (key, reason) → {"count": n, "samples": ["nb#1", …]} — rolled into
        # notes by report() so a type where every row skipped is diagnosable.
        self._skips: dict[tuple[str, str], dict] = {}
        self.failures: list[str] = []
        self.notes: list[str] = []
        self.images = {"ok": 0, "fail": 0}
        self._nb_devices: dict[int, dict] = {}  # for the primary-ip finalize pass
        self._nb_vms: dict[int, dict] = {}

    # ── helpers ──────────────────────────────────────────────────────────
    def log(self, msg):
        self.cmd.stdout.write(msg)

    def ref(self, key: str, nb_field):
        """Resolve a NetBox nested FK ({'id':..}) to a Danbyte instance."""
        if not nb_field:
            return None
        nbid = nb_field.get("id") if isinstance(nb_field, dict) else nb_field
        return self.idmap.get((key, nbid))

    def ref_generic(self, object_type: str, object_id):
        key = NB_CT.get(object_type)
        return self.idmap.get((key, object_id)) if key else None

    def status(self, nb: dict, model_slug: str):
        v = _val(nb.get("status")) or "active"
        return resolve_status(self.tenant, v, model_slug)

    def cf(self, nb: dict) -> dict:
        d = {
            k: v
            for k, v in (nb.get("custom_fields") or {}).items()
            if v not in (None, "", [])
        }
        d["netbox_id"] = nb.get("id")
        t = nb.get("tenant")
        if isinstance(t, dict) and t.get("name"):
            d["netbox_tenant"] = t["name"]
        return d

    def tag(self, obj, nb: dict):
        """Attach this object's NetBox tags, creating them in OUR tenant.

        Tags are tenant-scoped (unique per (tenant, slug) and (tenant, name)),
        so the lookup must carry the tenant: without it we'd either adopt
        another tenant's identically-named tag or mint a NULL-tenant
        "legacy global" one that the importing tenant can't even edit.
        Keyed on slug — NetBox's stable identifier — so a renamed tag updates
        rather than duplicating.

        Each tag is its own savepoint: a tag that can't be created (e.g. two
        NetBox tags whose names collide on our (tenant, name) constraint) is
        noted and skipped, never allowed to fail the device/prefix/VM it was
        hanging off.
        """
        raw = nb.get("tags") or []
        if not raw:
            return
        tags = []
        for t in raw:
            name = t["name"] if isinstance(t, dict) else str(t)
            slug = (t.get("slug") if isinstance(t, dict) else None) or slugify(name)
            color = _color(t.get("color") if isinstance(t, dict) else None)
            try:
                with transaction.atomic():
                    tag, _ = Tag.objects.get_or_create(
                        tenant=self.tenant,
                        slug=slug,
                        defaults={"name": name, "color": color},
                    )
            except Exception as e:  # noqa: BLE001 — never fail the parent object
                self.notes.append(f"tag '{name}' skipped: {e}")
                continue
            tags.append(tag)
        if tags:
            obj.tags.set(tags)

    def upsert(
        self,
        key: str,
        model,
        nb: dict,
        natural: dict,
        defaults: dict,
        *,
        cf: bool = False,
        tags: bool = False,
    ):
        """get_or_create keyed on `natural`; record stats + id-map. Returns the
        instance (or None on failure).

        Existing rows are left untouched unless ``--update-existing`` is set,
        in which case `defaults` are re-applied over them (a re-sync during a
        migration) and counted as ``updated``. Tags are reconciled on every
        run, not just on create — otherwise a re-run could never pick up a tag
        added in NetBox after the first import.
        """
        self.stats[key]["fetched"] += 1
        if cf:
            defaults = {**defaults, "custom_fields": self.cf(nb)}
        try:
            with transaction.atomic():
                obj, created = model.objects.get_or_create(
                    **natural, defaults=defaults
                )
                if not created and self.opts.get("update_existing"):
                    for field, value in defaults.items():
                        setattr(obj, field, value)
                    obj.save()
                    self.stats[key]["updated"] += 1
                if tags:
                    self.tag(obj, nb)
        except Exception as e:  # noqa: BLE001 — one bad row shouldn't stop the run
            self.stats[key]["failed"] += 1
            label = nb.get("name") or nb.get("display") or nb.get("id")
            self.failures.append(f"[{key}] {label} (nb#{nb.get('id')}): {e}")
            return None
        self.idmap[(key, nb["id"])] = obj
        self.stats[key]["created" if created else "existed"] += 1
        return obj

    def skip(self, key: str, nb: dict, reason: str, *, counted: bool = False):
        """Count a row deliberately not imported (its parent ref is missing,
        or the shape is unsupported). Skips used to be silent ``continue``s —
        a type where EVERY row skipped simply vanished from the report, which
        read as "nothing to do" when it actually meant "nothing worked".

        Counts toward ``fetched`` too: fetched is "rows NetBox returned", so
        fetched ≈ created + existed + failed + skipped. ``counted=True`` for
        call sites that already bumped fetched themselves (cables)."""
        if not counted:
            self.stats[key]["fetched"] += 1
        self.stats[key]["skipped"] += 1
        entry = self._skips.setdefault((key, reason), {"count": 0, "samples": []})
        entry["count"] += 1
        if len(entry["samples"]) < 3:
            entry["samples"].append(f"nb#{nb.get('id')}")

    def each(self, key: str, path: str, *, optional: bool = False):
        """Yield NetBox objects for `path` unless the resource is filtered out.

        Emits a throttled progress tick every 250 rows for big types, so the
        UI's bar advances within a slow step (e.g. thousands of interfaces).

        ``optional=True`` marks a plugin endpoint (e.g. netbox-map): a fetch
        failure there is a note, not a failure — most NetBox installs simply
        don't have the plugin.
        """
        only, skip = self.opts["only"], self.opts["skip"]
        if (only and key not in only) or key in skip:
            return
        try:
            rows = self.nb.list(path)
        except Exception as e:  # noqa: BLE001
            if optional:
                self.notes.append(
                    f"{key}: not imported — optional endpoint /{path}/ "
                    f"not available ({e})"
                )
                return
            # Both a note (the zero-fetch detector greps for "fetch failed")
            # and a failure row — a note alone left the type invisible in the
            # report table, so a whole endpoint could fail without a trace.
            self.notes.append(f"{key}: fetch failed ({e})")
            self.stats[key]["failed"] += 1
            self.failures.append(f"[{key}] fetch failed: {e}")
            return
        self.log(f"  {key}: {len(rows)} from NetBox")
        for n, row in enumerate(rows, 1):
            yield row
            if n % 250 == 0:
                self.on_progress(
                    self._step_i, self._step_total, key, dict(self.stats)
                )

    # ── run ──────────────────────────────────────────────────────────────
    def run(self):
        steps = self._steps()
        self._step_total = len(steps)
        for i, step in enumerate(steps, 1):
            self._step_i = i
            self._cur_key = step.__name__.removeprefix("imp_").removeprefix(
                "finalize_"
            )
            step()
            self.on_progress(i, self._step_total, self._cur_key, dict(self.stats))

    def _steps(self):
        return [
            self.imp_custom_fields,
            self.imp_manufacturers,
            self.imp_platforms,
            self.imp_device_roles,
            self.imp_rack_roles,
            self.imp_ip_roles,
            self.imp_rirs,
            self.imp_cluster_types,
            self.imp_cluster_groups,
            self.imp_circuit_types,
            self.imp_providers,
            self.imp_provider_networks,
            self.imp_contact_roles,
            self.imp_contact_groups,
            self.imp_route_targets,
            self.imp_vrfs,
            self.imp_regions,
            self.imp_sites,
            self.imp_locations,
            self.imp_aggregates,
            self.imp_asns,
            self.imp_racks,
            self.imp_power_panels,
            self.imp_power_feeds,
            self.imp_service_templates,
            self.imp_device_types,
            self.imp_module_types,
            self.imp_interface_templates,
            self.imp_module_interface_templates,
            self.imp_console_port_templates,
            self.imp_console_server_port_templates,
            self.imp_power_port_templates,
            self.imp_power_outlet_templates,
            self.imp_rear_port_templates,
            self.imp_front_port_templates,
            self.imp_device_bay_templates,
            self.imp_module_bay_templates,
            self.imp_inventory_item_templates,
            self.imp_clusters,
            self.imp_vlan_groups,
            self.imp_vlans,
            self.imp_prefixes,
            self.imp_ip_ranges,
            self.imp_devices,
            self.imp_virtual_chassis,
            self.imp_module_bays,
            self.imp_modules,
            self.imp_device_bays,
            self.imp_inventory_items,
            self.imp_interfaces,
            self.imp_console_ports,
            self.imp_console_server_ports,
            self.imp_power_ports,
            self.imp_power_outlets,
            self.imp_rear_ports,
            self.imp_front_ports,
            self.imp_mac_addresses,
            self.imp_virtual_machines,
            self.imp_vm_interfaces,
            self.imp_ip_addresses,
            self.imp_services,
            self.imp_fhrp_groups,
            self.imp_fhrp_group_assignments,
            self.imp_cables,
            self.imp_circuits,
            self.imp_circuit_terminations,
            self.imp_contacts,
            self.imp_contact_assignments,
            self.imp_floor_plans,
            self.imp_floor_plan_tiles,
            self.finalize_interface_links,
            self.finalize_device_links,
            self.finalize_vm_links,
        ]

    # ── custom-field definitions (so imported values are visible) ────────
    def imp_custom_fields(self):
        for nb in self.each("custom_fields", "extras/custom-fields"):
            key = nb.get("name")
            if not key:
                self.skip("custom_fields", nb, "unnamed custom field")
                continue
            # NetBox object_types "dcim.device" → Danbyte applies_to slug
            # "device" (model_name). Extras/unknown slugs are harmless.
            applies = [ct.split(".")[-1] for ct in (nb.get("object_types") or [])]
            default = nb.get("default")
            self.upsert(
                "custom_fields", CustomField, nb,
                {"tenant": self.tenant, "key": key},
                {
                    "label": nb.get("label") or key,
                    "type": NB_CF_TYPE.get(_val(nb.get("type")), "text"),
                    "applies_to": applies,
                    "choices": nb.get("choices") or [],
                    "required": bool(nb.get("required")),
                    "default": "" if default is None else str(default),
                    "description": nb.get("description", ""),
                    "weight": nb.get("weight") or 100,
                },
            )

    # ── catalogs ─────────────────────────────────────────────────────────
    def imp_manufacturers(self):
        for nb in self.each("manufacturers", "dcim/manufacturers"):
            self.upsert(
                "manufacturers", m.Manufacturer, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {"name": nb["name"], "description": nb.get("description", "")},
            )

    def imp_platforms(self):
        for nb in self.each("platforms", "dcim/platforms"):
            self.upsert(
                "platforms", m.Platform, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {
                    "name": nb["name"],
                    "manufacturer": self.ref("manufacturers", nb.get("manufacturer")),
                    "description": nb.get("description", ""),
                },
            )

    def imp_device_roles(self):
        for nb in self.each("device_roles", "dcim/device-roles"):
            self.upsert(
                "device_roles", m.DeviceRole, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {
                    "name": nb["name"],
                    "color": _color(nb.get("color")),
                    "description": nb.get("description", ""),
                },
                cf=True,
            )

    def imp_rack_roles(self):
        for nb in self.each("rack_roles", "dcim/rack-roles"):
            self.upsert(
                "rack_roles", m.RackRole, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {
                    "name": nb["name"],
                    "color": _color(nb.get("color")),
                    "description": nb.get("description", ""),
                },
            )

    def imp_ip_roles(self):
        for nb in self.each("ip_roles", "ipam/roles"):
            self.upsert(
                "ip_roles", m.IPRole, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {
                    "name": nb["name"],
                    "weight": nb.get("weight") or 100,
                    "description": nb.get("description", ""),
                },
            )

    def imp_rirs(self):
        for nb in self.each("rirs", "ipam/rirs"):
            self.upsert(
                "rirs", m.RIR, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {
                    "name": nb["name"],
                    "is_private": bool(nb.get("is_private")),
                    "description": nb.get("description", ""),
                },
            )

    def imp_cluster_types(self):
        for nb in self.each("cluster_types", "virtualization/cluster-types"):
            self.upsert(
                "cluster_types", m.ClusterType, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {"name": nb["name"], "description": nb.get("description", "")},
            )

    def imp_cluster_groups(self):
        for nb in self.each("cluster_groups", "virtualization/cluster-groups"):
            self.upsert(
                "cluster_groups", m.ClusterGroup, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {"name": nb["name"], "description": nb.get("description", "")},
            )

    def imp_circuit_types(self):
        for nb in self.each("circuit_types", "circuits/circuit-types"):
            self.upsert(
                "circuit_types", m.CircuitType, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {
                    "name": nb["name"],
                    "color": _color(nb.get("color")),
                    "description": nb.get("description", ""),
                },
            )

    def imp_providers(self):
        for nb in self.each("providers", "circuits/providers"):
            self.upsert(
                "providers", m.Provider, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {
                    "name": nb["name"],
                    "account": (nb.get("accounts") or [{}])[0].get("account", "")
                    if nb.get("accounts")
                    else nb.get("account", "") or "",
                    "comments": nb.get("comments", ""),
                },
                cf=True, tags=True,
            )

    def imp_provider_networks(self):
        for nb in self.each("provider_networks", "circuits/provider-networks"):
            provider = self.ref("providers", nb.get("provider"))
            if not provider:
                self.skip("provider_networks", nb, "provider not imported")
                continue
            self.upsert(
                "provider_networks", m.ProviderNetwork, nb,
                {"tenant": self.tenant, "provider": provider, "name": nb["name"]},
                {"description": nb.get("description", "")},
                cf=True, tags=True,
            )

    def imp_contact_roles(self):
        for nb in self.each("contact_roles", "tenancy/contact-roles"):
            self.upsert(
                "contact_roles", m.ContactRole, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {"name": nb["name"], "description": nb.get("description", "")},
            )

    def imp_contact_groups(self):
        rows = list(self.each("contact_groups", "tenancy/contact-groups"))
        for nb in rows:
            self.upsert(
                "contact_groups", m.ContactGroup, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {"name": nb["name"], "description": nb.get("description", "")},
            )
        for nb in rows:  # second pass: parent
            obj = self.idmap.get(("contact_groups", nb["id"]))
            parent = self.ref("contact_groups", nb.get("parent"))
            if obj and parent and obj.parent_id != parent.id:
                obj.parent = parent
                obj.save(update_fields=["parent"])

    def imp_route_targets(self):
        for nb in self.each("route_targets", "ipam/route-targets"):
            self.upsert(
                "route_targets", m.RouteTarget, nb,
                {"tenant": self.tenant, "name": nb["name"]},
                {"description": nb.get("description", "")},
                cf=True, tags=True,
            )

    def imp_vrfs(self):
        for nb in self.each("vrfs", "ipam/vrfs"):
            obj = self.upsert(
                "vrfs", m.VRF, nb,
                {"tenant": self.tenant, "name": nb["name"]},
                {
                    "rd": nb.get("rd") or "",
                    "enforce_unique": bool(nb.get("enforce_unique", True)),
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )
            if obj:
                imp = [self.ref("route_targets", rt) for rt in nb.get("import_targets", [])]
                exp = [self.ref("route_targets", rt) for rt in nb.get("export_targets", [])]
                if any(imp):
                    obj.import_targets.set([x for x in imp if x])
                if any(exp):
                    obj.export_targets.set([x for x in exp if x])

    # ── geography ────────────────────────────────────────────────────────
    def imp_regions(self):
        rows = list(self.each("regions", "dcim/regions"))
        for nb in rows:
            self.upsert(
                "regions", m.Region, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {"name": nb["name"], "description": nb.get("description", "")},
            )
        for nb in rows:
            obj = self.idmap.get(("regions", nb["id"]))
            parent = self.ref("regions", nb.get("parent"))
            if obj and parent and obj.parent_id != parent.id:
                obj.parent = parent
                obj.save(update_fields=["parent"])

    def imp_sites(self):
        for nb in self.each("sites", "dcim/sites"):
            obj = self.upsert(
                "sites", m.Site, nb,
                {"tenant": self.tenant, "name": nb["name"]},
                {
                    "region": self.ref("regions", nb.get("region")),
                    "location": nb.get("physical_address") or "",
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_locations(self):
        rows = list(self.each("locations", "dcim/locations"))
        for nb in rows:
            site = self.ref("sites", nb.get("site"))
            if not site:
                self.stats["locations"]["fetched"] += 1
                self.stats["locations"]["failed"] += 1
                self.failures.append(
                    f"[locations] {nb.get('name')} (nb#{nb['id']}): site not imported"
                )
                continue
            self.upsert(
                "locations", m.Location, nb,
                {"tenant": self.tenant, "site": site, "slug": nb["slug"]},
                {
                    "name": nb["name"],
                    "status": self.status(nb, "location") if nb.get("status") else None,
                    "description": nb.get("description", ""),
                },
            )
        for nb in rows:
            obj = self.idmap.get(("locations", nb["id"]))
            parent = self.ref("locations", nb.get("parent"))
            if obj and parent and obj.parent_id != parent.id:
                obj.parent = parent
                obj.save(update_fields=["parent"])

    def imp_aggregates(self):
        for nb in self.each("aggregates", "ipam/aggregates"):
            rir = self.ref("rirs", nb.get("rir"))
            if not rir:
                self.skip("aggregates", nb, "RIR not imported")
                continue
            self.upsert(
                "aggregates", m.Aggregate, nb,
                {"tenant": self.tenant, "prefix": nb["prefix"]},
                {"rir": rir, "date_added": nb.get("date_added"),
                 "description": nb.get("description", "")},
                cf=True, tags=True,
            )

    def imp_asns(self):
        for nb in self.each("asns", "ipam/asns"):
            obj = self.upsert(
                "asns", m.ASN, nb,
                {"tenant": self.tenant, "asn": nb["asn"]},
                {"rir": self.ref("rirs", nb.get("rir")),
                 "description": nb.get("description", "")},
                cf=True, tags=True,
            )
            if obj:
                sites = [self.ref("sites", s) for s in nb.get("sites", [])]
                if any(sites):
                    obj.sites.set([x for x in sites if x])

    def imp_racks(self):
        for nb in self.each("racks", "dcim/racks"):
            site = self.ref("sites", nb.get("site"))
            if not site:
                self.skip("racks", nb, "site not imported")
                continue
            self.upsert(
                "racks", m.Rack, nb,
                {"site": site, "name": nb["name"]},
                {
                    "tenant": self.tenant,
                    "role": self.ref("rack_roles", nb.get("role")),
                    "location": self.ref("locations", nb.get("location")),
                    "status": self.status(nb, "rack"),
                    "facility_id": nb.get("facility_id") or "",
                    "width": int(_val(nb.get("width")) or 19),
                    "u_height": nb.get("u_height") or 42,
                    "starting_unit": nb.get("starting_unit") or 1,
                    "desc_units": bool(nb.get("desc_units")),
                    "max_weight": nb.get("max_weight"),
                    "max_weight_unit": _val(nb.get("weight_unit")) or "",
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_device_types(self):
        for nb in self.each("device_types", "dcim/device-types"):
            name = nb.get("model") or nb.get("display")
            obj = self.upsert(
                "device_types", m.DeviceType, nb,
                {"tenant": self.tenant, "name": name},
                {
                    "model": nb.get("model") or name,
                    "manufacturer": self.ref("manufacturers", nb.get("manufacturer")),
                    "part_number": nb.get("part_number") or "",
                    "u_height": nb.get("u_height") or 1,
                    "is_full_depth": bool(nb.get("is_full_depth", True)),
                    "subdevice_role": _val(nb.get("subdevice_role")) or "",
                    "airflow": _val(nb.get("airflow")) or "",
                    "weight": nb.get("weight"),
                    "weight_unit": _val(nb.get("weight_unit")) or "",
                    "exclude_from_utilization": bool(
                        nb.get("exclude_from_utilization")
                    ),
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )
            if obj and self.opts.get("with_images"):
                self._fetch_image(obj, "front_image", nb.get("front_image"))
                self._fetch_image(obj, "rear_image", nb.get("rear_image"))

    def _fetch_image(self, obj, field, url, *, label="device_types:image"):
        """Download a NetBox media image into an ImageField (skips if already set
        or during --dry-run — file writes aren't transactional)."""
        if not url or getattr(obj, field) or self.opts.get("dry_run"):
            return
        try:
            from django.core.files.base import ContentFile

            content = self.nb.get_bytes(url)
            fname = url.split("?")[0].rstrip("/").split("/")[-1] or f"{field}.img"
            getattr(obj, field).save(fname, ContentFile(content), save=True)
            self.images["ok"] += 1
        except Exception as e:  # noqa: BLE001
            self.images["fail"] += 1
            self.failures.append(f"[{label}] {obj.name} {field}: {e}")

    # ── device-type component templates (stamped onto new devices) ────────
    def _tmpl(self, key, path, model, build):
        for nb in self.each(key, path):
            dt = self.ref("device_types", nb.get("device_type"))
            if not dt:
                reason = (
                    "belongs to a module type (not supported)"
                    if nb.get("module_type") else "device type not imported"
                )
                self.skip(key, nb, reason)
                continue
            self.upsert(
                key, model, nb,
                {"device_type": dt, "name": nb["name"]},
                build(nb),
            )

    def imp_interface_templates(self):
        self._tmpl(
            "interface_templates", "dcim/interface-templates", m.InterfaceTemplate,
            lambda nb: {
                "type": _val(nb.get("type")) or "",
                "enabled": bool(nb.get("enabled", True)),
                "mgmt_only": bool(nb.get("mgmt_only")),
            },
        )

    def imp_console_port_templates(self):
        self._tmpl(
            "console_port_templates", "dcim/console-port-templates",
            m.ConsolePortTemplate, lambda nb: {"type": _val(nb.get("type")) or ""},
        )

    def imp_console_server_port_templates(self):
        self._tmpl(
            "console_server_port_templates", "dcim/console-server-port-templates",
            m.ConsoleServerPortTemplate, lambda nb: {"type": _val(nb.get("type")) or ""},
        )

    def imp_power_port_templates(self):
        self._tmpl(
            "power_port_templates", "dcim/power-port-templates", m.PowerPortTemplate,
            lambda nb: {
                "type": _val(nb.get("type")) or "",
                "maximum_draw": nb.get("maximum_draw"),
                "allocated_draw": nb.get("allocated_draw"),
            },
        )

    def imp_power_outlet_templates(self):
        self._tmpl(
            "power_outlet_templates", "dcim/power-outlet-templates",
            m.PowerOutletTemplate, lambda nb: {
                "type": _val(nb.get("type")) or "",
                "power_port_template": self.ref(
                    "power_port_templates", nb.get("power_port")
                ),
                "feed_leg": _val(nb.get("feed_leg")) or "",
            },
        )

    def imp_rear_port_templates(self):
        self._tmpl(
            "rear_port_templates", "dcim/rear-port-templates", m.RearPortTemplate,
            lambda nb: {
                "type": _val(nb.get("type")) or "",
                "positions": nb.get("positions") or 1,
            },
        )

    def imp_front_port_templates(self):
        for nb in self.each("front_port_templates", "dcim/front-port-templates"):
            dt = self.ref("device_types", nb.get("device_type"))
            rear, rear_pos = self._front_rear(nb, "rear_port_templates")
            if not dt or not rear:
                reason = (
                    "belongs to a module type (not supported)"
                    if not dt and nb.get("module_type")
                    else "device type not imported" if not dt
                    else "rear port template not imported"
                )
                self.skip("front_port_templates", nb, reason)
                continue
            self.upsert(
                "front_port_templates", m.FrontPortTemplate, nb,
                {"device_type": dt, "name": nb["name"]},
                {
                    "rear_port_template": rear,
                    "rear_port_position": rear_pos,
                    "type": _val(nb.get("type")) or "",
                },
            )

    def imp_device_bay_templates(self):
        self._tmpl(
            "device_bay_templates", "dcim/device-bay-templates", m.DeviceBayTemplate,
            lambda nb: {"description": nb.get("description", "")},
        )

    def imp_module_bay_templates(self):
        self._tmpl(
            "module_bay_templates", "dcim/module-bay-templates", m.ModuleBayTemplate,
            lambda nb: {"position": nb.get("position") or ""},
        )

    def imp_clusters(self):
        for nb in self.each("clusters", "virtualization/clusters"):
            ctype = self.ref("cluster_types", nb.get("type"))
            if not ctype:
                self.skip("clusters", nb, "cluster type not imported")
                continue
            self.upsert(
                "clusters", m.Cluster, nb,
                {"tenant": self.tenant, "name": nb["name"]},
                {
                    "type": ctype,
                    "group": self.ref("cluster_groups", nb.get("group")),
                    "site": self.ref("sites", nb.get("site")),
                    "status": self.status(nb, "cluster"),
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_vlan_groups(self):
        for nb in self.each("vlan_groups", "ipam/vlan-groups"):
            self.upsert(
                "vlan_groups", m.VLANGroup, nb,
                {"tenant": self.tenant, "slug": nb["slug"]},
                {
                    "name": nb["name"],
                    "min_vid": nb.get("min_vid") or 1,
                    "max_vid": nb.get("max_vid") or 4094,
                    "description": nb.get("description", ""),
                },
            )

    def imp_vlans(self):
        for nb in self.each("vlans", "ipam/vlans"):
            self.upsert(
                "vlans", m.VLAN, nb,
                {
                    "tenant": self.tenant,
                    "group": self.ref("vlan_groups", nb.get("group")),
                    "vlan_id": nb["vid"],
                },
                {
                    "name": nb["name"],
                    "site": self.ref("sites", nb.get("site")),
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_prefixes(self):
        for nb in self.each("prefixes", "ipam/prefixes"):
            self.upsert(
                "prefixes", m.Prefix, nb,
                {
                    "tenant": self.tenant,
                    "vrf": self.ref("vrfs", nb.get("vrf")),
                    "cidr": nb["prefix"],
                },
                {
                    "status": self.status(nb, "prefix"),
                    "vlan": self.ref("vlans", nb.get("vlan")),
                    "site": self.ref("sites", nb.get("site")),
                    "location": self.ref("locations", nb.get("location")),
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_ip_ranges(self):
        for nb in self.each("ip_ranges", "ipam/ip-ranges"):
            self.upsert(
                "ip_ranges", m.IPRange, nb,
                {
                    "tenant": self.tenant,
                    "vrf": self.ref("vrfs", nb.get("vrf")),
                    "start_address": _addr(nb["start_address"]),
                    "end_address": _addr(nb["end_address"]),
                },
                {
                    "status": self.status(nb, "iprange"),
                    "role": self.ref("ip_roles", nb.get("role")),
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    # ── devices + components ─────────────────────────────────────────────
    def imp_devices(self):
        for nb in self.each("devices", "dcim/devices"):
            self._nb_devices[nb["id"]] = nb
            pos = nb.get("position")
            self.upsert(
                "devices", m.Device, nb,
                {"tenant": self.tenant, "name": nb.get("name") or f"device-{nb['id']}"},
                {
                    "device_type": self.ref("device_types", nb.get("device_type")),
                    "role": self.ref("device_roles", nb.get("role") or nb.get("device_role")),
                    "platform": self.ref("platforms", nb.get("platform")),
                    "site": self.ref("sites", nb.get("site")),
                    "rack": self.ref("racks", nb.get("rack")),
                    "location": self.ref("locations", nb.get("location")),
                    "cluster": self.ref("clusters", nb.get("cluster")),
                    "status": self.status(nb, "device"),
                    "position": int(pos) if pos else None,
                    "face": _val(nb.get("face")) or "",
                    "airflow": _val(nb.get("airflow")) or "",
                    "latitude": nb.get("latitude"),
                    "longitude": nb.get("longitude"),
                    "serial_number": nb.get("serial") or "",
                    "asset_tag": nb.get("asset_tag") or "",
                    "description": nb.get("description", ""),
                    "comments": nb.get("comments", ""),
                },
                cf=True, tags=True,
            )

    def imp_virtual_chassis(self):
        for nb in self.each("virtual_chassis", "dcim/virtual-chassis"):
            self.upsert(
                "virtual_chassis", m.VirtualChassis, nb,
                {"tenant": self.tenant, "name": nb["name"]},
                {
                    "master": self.ref("devices", nb.get("master")),
                    "domain": nb.get("domain") or "",
                },
                cf=True, tags=True,
            )

    def _component(self, key, path, model, extra=None, *, typed=True):
        # typed=False for models without a `type` column (ModuleBay) — passing
        # the NetBox field through blew up get_or_create on every single row.
        for nb in self.each(key, path):
            device = self.ref("devices", nb.get("device"))
            if not device:
                self.skip(key, nb, "device not imported")
                continue
            defaults = {"type": _val(nb.get("type")) or ""} if typed else {}
            defaults.update((extra or (lambda _n: {}))(nb))
            self.upsert(
                key, model, nb,
                {"device": device, "name": nb["name"]},
                defaults,
                cf=True, tags=True,
            )

    def imp_interfaces(self):
        # NetBox interfaces reference each other (lag/parent/bridge), so the
        # relations can't be resolved until every interface exists. Stash the
        # raw NetBox rows and wire the self-FKs in finalize_interface_links.
        self._nb_interfaces: dict[int, dict] = {}
        for nb in self.each("interfaces", "dcim/interfaces"):
            device = self.ref("devices", nb.get("device"))
            if not device:
                self.skip("interfaces", nb, "device not imported")
                continue
            mac = nb.get("mac_address")
            speed = nb.get("speed")
            obj = self.upsert(
                "interfaces", m.Interface, nb,
                {"device": device, "name": nb["name"]},
                {
                    "type": _val(nb.get("type")) or "",
                    "enabled": bool(nb.get("enabled", True)),
                    "mtu": nb.get("mtu"),
                    "speed": str(speed) if speed else "",
                    "duplex": _val(nb.get("duplex")) or "",
                    "poe_mode": _val(nb.get("poe_mode")) or "",
                    "poe_type": _val(nb.get("poe_type")) or "",
                    "wwn": nb.get("wwn") or "",
                    "virtual": _val(nb.get("type")) == "virtual",
                    "mac_address": mac if isinstance(mac, str) else "",
                    "mode": _val(nb.get("mode")) or "",
                    "mgmt_only": bool(nb.get("mgmt_only")),
                    "vlan": self.ref("vlans", nb.get("untagged_vlan")),
                    "vrf": self.ref("vrfs", nb.get("vrf")),
                },
                cf=True, tags=True,
            )
            if obj:
                self._nb_interfaces[nb["id"]] = nb
                tv = [self.ref("vlans", v) for v in nb.get("tagged_vlans", [])]
                if any(tv):
                    obj.tagged_vlans.set([x for x in tv if x])

    def finalize_interface_links(self):
        """Second pass: wire lag / parent / bridge now that every interface
        exists. Without this, every LAG and sub-interface loses its
        aggregation/parenting on import."""
        for nbid, nb in getattr(self, "_nb_interfaces", {}).items():
            obj = self.idmap.get(("interfaces", nbid))
            if obj is None:
                continue
            lag = self.ref("interfaces", nb.get("lag"))
            parent = self.ref("interfaces", nb.get("parent"))
            bridge = self.ref("interfaces", nb.get("bridge"))
            fields = []
            if lag and obj.lag_id != lag.pk:
                obj.lag = lag
                fields.append("lag")
            if parent and obj.parent_id != parent.pk:
                obj.parent = parent
                fields.append("parent")
            if bridge and obj.bridge_id != bridge.pk:
                obj.bridge = bridge
                fields.append("bridge")
            if fields:
                try:
                    obj.save(update_fields=fields)
                except Exception as e:  # noqa: BLE001
                    self.notes.append(f"interface link {obj.name}: {e}")

    def imp_console_ports(self):
        self._component("console_ports", "dcim/console-ports", m.ConsolePort)

    def imp_power_ports(self):
        self._component("power_ports", "dcim/power-ports", m.PowerPort)

    def imp_rear_ports(self):
        self._component(
            "rear_ports", "dcim/rear-ports", m.RearPort,
            lambda nb: {"positions": nb.get("positions") or 1},
        )

    def _front_rear(self, nb: dict, key: str):
        """Resolve a front port('s template) rear reference across NetBox
        versions: ≤4.3 has a single nested ``rear_port``; ≥4.4 has a
        ``rear_ports`` mapping list ({position, rear_port: <pk>,
        rear_port_position}) for breakout support. Danbyte models one rear
        port per front port, so take the first mapping."""
        single = nb.get("rear_port")
        if single:
            return self.ref(key, single), nb.get("rear_port_position") or 1
        maps = nb.get("rear_ports") or []
        if maps:
            first = sorted(maps, key=lambda x: x.get("position") or 1)[0]
            return (
                self.ref(key, first.get("rear_port")),
                first.get("rear_port_position") or 1,
            )
        return None, 1

    def imp_front_ports(self):
        for nb in self.each("front_ports", "dcim/front-ports"):
            device = self.ref("devices", nb.get("device"))
            rear, rear_pos = self._front_rear(nb, "rear_ports")
            if not device or not rear:
                self.skip(
                    "front_ports", nb,
                    "device not imported" if not device
                    else "rear port not imported",
                )
                continue
            self.upsert(
                "front_ports", m.FrontPort, nb,
                {"device": device, "name": nb["name"]},
                {
                    "rear_port": rear,
                    "rear_port_position": rear_pos,
                    "positions": nb.get("positions") or 1,
                    "type": _val(nb.get("type")) or "",
                },
                cf=True, tags=True,
            )

    # ── virtualization ───────────────────────────────────────────────────
    def _fallback_cluster(self):
        """NetBox 4 allows clusterless VMs; Danbyte requires a cluster. Park them
        in a synthetic 'Unclustered' cluster (created once)."""
        if getattr(self, "_fc", None):
            return self._fc
        ct, _ = m.ClusterType.objects.get_or_create(
            tenant=self.tenant, slug="netbox-import",
            defaults={"name": "NetBox import"},
        )
        self._fc, _ = m.Cluster.objects.get_or_create(
            tenant=self.tenant, name="Unclustered (NetBox import)",
            defaults={"type": ct},
        )
        return self._fc

    def imp_virtual_machines(self):
        for nb in self.each("virtual_machines", "virtualization/virtual-machines"):
            self._nb_vms[nb["id"]] = nb
            cluster = self.ref("clusters", nb.get("cluster")) or self._fallback_cluster()
            self.upsert(
                "virtual_machines", m.VirtualMachine, nb,
                {"tenant": self.tenant, "name": nb["name"]},
                {
                    "cluster": cluster,
                    "role": self.ref("device_roles", nb.get("role")),
                    "platform": self.ref("platforms", nb.get("platform")),
                    "device": self.ref("devices", nb.get("device")),
                    "site": self.ref("sites", nb.get("site")),
                    "status": self.status(nb, "virtualmachine"),
                    "vcpus": int(nb["vcpus"]) if nb.get("vcpus") else None,
                    "memory_mb": nb.get("memory"),
                    "disk_gb": nb.get("disk"),
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_vm_interfaces(self):
        for nb in self.each("vm_interfaces", "virtualization/interfaces"):
            vm = self.ref("virtual_machines", nb.get("virtual_machine"))
            if not vm:
                self.skip("vm_interfaces", nb, "virtual machine not imported")
                continue
            mac = nb.get("mac_address")
            obj = self.upsert(
                "vm_interfaces", m.VMInterface, nb,
                {"vm": vm, "name": nb["name"]},
                {
                    "enabled": bool(nb.get("enabled", True)),
                    "mtu": nb.get("mtu"),
                    "mac_address": mac if isinstance(mac, str) else "",
                    "mode": _val(nb.get("mode")) or "",
                    "vlan": self.ref("vlans", nb.get("untagged_vlan")),
                    "vrf": self.ref("vrfs", nb.get("vrf")),
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )
            if obj:
                tv = [self.ref("vlans", v) for v in nb.get("tagged_vlans", [])]
                if any(tv):
                    obj.tagged_vlans.set([x for x in tv if x])

    # ── IP addresses (require a containing prefix) ───────────────────────
    def _prefix_for(self, ip_with_mask: str, vrf):
        """Find the most-specific imported Prefix (same tenant+vrf) containing
        the IP; auto-create a host prefix from the IP's mask if none exists."""
        import ipaddress as ipa

        try:
            ip = ipa.ip_interface(ip_with_mask)
        except ValueError:
            return None
        addr = ip.ip
        best, best_len = None, -1
        for (k, _), obj in self.idmap.items():
            if k != "prefixes" or obj.vrf_id != (vrf.id if vrf else None):
                continue
            try:
                net = ipa.ip_network(obj.cidr, strict=False)
            except ValueError:
                continue
            if addr in net and net.prefixlen > best_len:
                best, best_len = obj, net.prefixlen
        if best:
            return best
        # No container: create the IP's own network as a prefix.
        cidr = str(ip.network)
        obj, created = m.Prefix.objects.get_or_create(
            tenant=self.tenant, vrf=vrf, cidr=cidr,
            defaults={
                "status": resolve_status(self.tenant, "active", "prefix"),
                "custom_fields": {"source": "netbox-import (auto)"},
            },
        )
        if created:
            self.stats["prefixes"]["created"] += 1
            self.notes.append(f"auto-created prefix {cidr} for an IP with no container")
        return obj

    def imp_ip_addresses(self):
        for nb in self.each("ip_addresses", "ipam/ip-addresses"):
            self.stats["ip_addresses"]["fetched"] += 1
            vrf = self.ref("vrfs", nb.get("vrf"))
            prefix = self._prefix_for(nb["address"], vrf)
            if not prefix:
                self.stats["ip_addresses"]["failed"] += 1
                self.failures.append(
                    f"[ip_addresses] {nb['address']} (nb#{nb['id']}): could not resolve/create a prefix"
                )
                continue
            iface = vmiface = vm = None
            ao_type = nb.get("assigned_object_type")
            ao = nb.get("assigned_object")
            if ao and ao_type == "dcim.interface":
                iface = self.ref("interfaces", ao)
            elif ao and ao_type == "virtualization.vminterface":
                vmiface = self.ref("vm_interfaces", ao)
                # IPAddress.save() derives assigned_device from an interface but
                # has no VM equivalent, so set assigned_vm explicitly here —
                # else VM-attached IPs land unlinked from their VM.
                if vmiface is not None:
                    vm = vmiface.vm
            try:
                with transaction.atomic():
                    obj, created = m.IPAddress.objects.get_or_create(
                        tenant=self.tenant, vrf=vrf, ip_address=_addr(nb["address"]),
                        defaults={
                            "prefix": prefix,
                            "status": self.status(nb, "ipaddress"),
                            "role": self.ref("ip_roles", nb.get("role")),
                            "dns_name": nb.get("dns_name") or "",
                            "description": nb.get("description", ""),
                            "assigned_interface": iface,
                            "assigned_vm_interface": vmiface,
                            "assigned_vm": vm,
                            "custom_fields": self.cf(nb),
                        },
                    )
                    if created:
                        self.tag(obj, nb)
            except Exception as e:  # noqa: BLE001
                self.stats["ip_addresses"]["failed"] += 1
                self.failures.append(
                    f"[ip_addresses] {nb['address']} (nb#{nb['id']}): {e}"
                )
                continue
            self.idmap[("ip_addresses", nb["id"])] = obj
            self.stats["ip_addresses"]["created" if created else "existed"] += 1

    def imp_fhrp_groups(self):
        for nb in self.each("fhrp_groups", "ipam/fhrp-groups"):
            self.upsert(
                "fhrp_groups", m.FHRPGroup, nb,
                {"tenant": self.tenant, "protocol": _val(nb.get("protocol")),
                 "group_id": nb["group_id"]},
                {
                    "name": nb.get("name") or "",
                    "auth_type": _val(nb.get("auth_type")) or "",
                    "auth_key": nb.get("auth_key") or "",
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_fhrp_group_assignments(self):
        for nb in self.each("fhrp_group_assignments", "ipam/fhrp-group-assignments"):
            group = self.ref("fhrp_groups", nb.get("group") or nb.get("fhrp_group"))
            if not group:
                self.skip("fhrp_group_assignments", nb, "FHRP group not imported")
                continue
            ot = nb.get("interface_type")
            oid = nb.get("interface_id")
            iface = vmiface = None
            if ot == "dcim.interface":
                iface = self.ref("interfaces", oid)
            elif ot == "virtualization.vminterface":
                vmiface = self.ref("vm_interfaces", oid)
            if not (iface or vmiface):
                self.skip("fhrp_group_assignments", nb, "interface not imported")
                continue
            natural = {"fhrp_group": group}
            natural["interface" if iface else "vm_interface"] = iface or vmiface
            self.upsert(
                "fhrp_group_assignments", m.FHRPGroupAssignment, nb,
                natural,
                {"priority": nb.get("priority") or 0},
            )

    # ── power distribution ───────────────────────────────────────────────
    def imp_power_panels(self):
        for nb in self.each("power_panels", "dcim/power-panels"):
            site = self.ref("sites", nb.get("site"))
            if not site:
                self.skip("power_panels", nb, "site not imported")
                continue
            self.upsert(
                "power_panels", m.PowerPanel, nb,
                {"site": site, "name": nb["name"]},
                {
                    "tenant": self.tenant,
                    "comments": nb.get("comments", ""),
                },
                cf=True, tags=True,
            )

    def imp_power_feeds(self):
        for nb in self.each("power_feeds", "dcim/power-feeds"):
            panel = self.ref("power_panels", nb.get("power_panel"))
            if not panel:
                self.skip("power_feeds", nb, "power panel not imported")
                continue
            self.upsert(
                "power_feeds", m.PowerFeed, nb,
                {"power_panel": panel, "name": nb["name"]},
                {
                    "tenant": self.tenant,
                    "rack": self.ref("racks", nb.get("rack")),
                    "status": self.status(nb, "powerfeed"),
                    "type": _val(nb.get("type")) or "primary",
                    "supply": _val(nb.get("supply")) or "ac",
                    # NetBox: single-phase/three-phase → Danbyte: single/three.
                    "phase": (_val(nb.get("phase")) or "single").replace("-phase", ""),
                    "voltage": nb.get("voltage"),
                    "amperage": nb.get("amperage"),
                    "max_utilization": nb.get("max_utilization") or 80,
                    "comments": nb.get("comments", ""),
                },
                cf=True, tags=True,
            )

    def imp_console_server_ports(self):
        self._component(
            "console_server_ports", "dcim/console-server-ports",
            m.ConsoleServerPort,
            lambda nb: {"speed": _val(nb.get("speed")) or None},
        )

    def imp_power_outlets(self):
        self._component(
            "power_outlets", "dcim/power-outlets", m.PowerOutlet,
            lambda nb: {
                "power_port": self.ref("power_ports", nb.get("power_port")),
                "feed_leg": _val(nb.get("feed_leg")) or "",
            },
        )

    # ── services ─────────────────────────────────────────────────────────
    def imp_service_templates(self):
        for nb in self.each("service_templates", "ipam/service-templates"):
            name = nb.get("name")
            slug = slugify(name)
            self.upsert(
                "service_templates", m.ServiceTemplate, nb,
                {"tenant": self.tenant, "slug": slug},
                {
                    "name": name,
                    "protocol": _val(nb.get("protocol")) or "tcp",
                    "ports": nb.get("ports") or [],
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_services(self):
        for nb in self.each("services", "ipam/services"):
            device = self.ref("devices", nb.get("device"))
            vm = self.ref("virtual_machines", nb.get("virtual_machine"))
            if not (device or vm):
                # NetBox ≥4.3 replaced device/virtual_machine with a generic
                # parent (parent_object_type + parent_object_id / parent).
                pt = nb.get("parent_object_type") or ""
                po = nb.get("parent_object_id")
                if po is None:
                    parent = nb.get("parent")
                    po = parent.get("id") if isinstance(parent, dict) else None
                if pt == "dcim.device":
                    device = self.ref("devices", po)
                elif pt == "virtualization.virtualmachine":
                    vm = self.ref("virtual_machines", po)
            if not (device or vm):
                self.skip("services", nb, "parent device/VM not imported")
                continue
            natural = {
                "tenant": self.tenant, "name": nb["name"],
                "protocol": _val(nb.get("protocol")) or "tcp",
            }
            natural["device" if device else "virtual_machine"] = device or vm
            ipaddrs = nb.get("ipaddresses") or []
            self.upsert(
                "services", m.Service, nb, natural,
                {
                    "ports": nb.get("ports") or [],
                    "ip_address": self.ref("ip_addresses", ipaddrs[0]) if ipaddrs else None,
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_mac_addresses(self):
        for nb in self.each("mac_addresses", "dcim/mac-addresses"):
            mac = nb.get("mac_address")
            if not mac:
                self.skip("mac_addresses", nb, "empty MAC")
                continue
            iface = None
            if nb.get("assigned_object_type") == "dcim.interface":
                iface = self.ref("interfaces", nb.get("assigned_object_id")
                                 or nb.get("assigned_object"))
            self.upsert(
                "mac_addresses", m.MACAddress, nb,
                {"tenant": self.tenant, "mac_address": str(mac).lower()},
                {
                    "assigned_interface": iface,
                    "description": nb.get("description", ""),
                },
                cf=True,
            )

    # ── modular / chassis ────────────────────────────────────────────────
    def imp_module_types(self):
        for nb in self.each("module_types", "dcim/module-types"):
            name = nb.get("model") or nb.get("display")
            self.upsert(
                "module_types", m.ModuleType, nb,
                {"tenant": self.tenant,
                 "manufacturer": self.ref("manufacturers", nb.get("manufacturer")),
                 "name": name},
                {
                    "part_number": nb.get("part_number") or "",
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_module_interface_templates(self):
        for nb in self.each("module_interface_templates",
                            "dcim/interface-templates?module_type_id__isnull=false"):
            mt = self.ref("module_types", nb.get("module_type"))
            if not mt:
                self.skip(
                    "module_interface_templates", nb, "module type not imported"
                )
                continue
            self.upsert(
                "module_interface_templates", m.ModuleInterfaceTemplate, nb,
                {"module_type": mt, "name": nb["name"]},
                {
                    "type": _val(nb.get("type")) or "",
                    "enabled": bool(nb.get("enabled", True)),
                    "mgmt_only": bool(nb.get("mgmt_only")),
                },
            )

    def imp_module_bays(self):
        self._component(
            "module_bays", "dcim/module-bays", m.ModuleBay,
            lambda nb: {"position": nb.get("position") or ""},
            typed=False,  # ModuleBay has no `type` column
        )

    def imp_modules(self):
        for nb in self.each("modules", "dcim/modules"):
            device = self.ref("devices", nb.get("device"))
            bay = self.ref("module_bays", nb.get("module_bay"))
            mt = self.ref("module_types", nb.get("module_type"))
            if not (device and bay and mt):
                missing = (
                    "device" if not device
                    else "module bay" if not bay else "module type"
                )
                self.skip("modules", nb, f"{missing} not imported")
                continue
            self.upsert(
                "modules", m.Module, nb,
                {"module_bay": bay},
                {
                    "device": device,
                    "module_type": mt,
                    "serial_number": nb.get("serial") or "",
                    "asset_tag": nb.get("asset_tag") or "",
                    "description": nb.get("description", ""),
                },
                cf=True,
            )

    def imp_device_bays(self):
        for nb in self.each("device_bays", "dcim/device-bays"):
            device = self.ref("devices", nb.get("device"))
            if not device:
                self.skip("device_bays", nb, "device not imported")
                continue
            self.upsert(
                "device_bays", m.DeviceBay, nb,
                {"device": device, "name": nb["name"]},
                {
                    "installed_device": self.ref(
                        "devices", nb.get("installed_device")
                    ),
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_inventory_items(self):
        for nb in self.each("inventory_items", "dcim/inventory-items"):
            device = self.ref("devices", nb.get("device"))
            if not device:
                self.skip("inventory_items", nb, "device not imported")
                continue
            self.upsert(
                "inventory_items", m.InventoryItem, nb,
                {"device": device, "name": nb["name"]},
                {
                    "parent": self.ref("inventory_items", nb.get("parent")),
                    "manufacturer": self.ref("manufacturers", nb.get("manufacturer")),
                    "part_id": nb.get("part_id") or "",
                    "serial_number": nb.get("serial") or "",
                    "asset_tag": nb.get("asset_tag") or "",
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )

    def imp_inventory_item_templates(self):
        for nb in self.each("inventory_item_templates", "dcim/inventory-item-templates"):
            dt = self.ref("device_types", nb.get("device_type"))
            if not dt:
                self.skip(
                    "inventory_item_templates", nb, "device type not imported"
                )
                continue
            self.upsert(
                "inventory_item_templates", m.InventoryItemTemplate, nb,
                {"device_type": dt, "name": nb["name"]},
                {
                    "manufacturer": self.ref("manufacturers", nb.get("manufacturer")),
                    "part_id": nb.get("part_id") or "",
                },
            )

    # ── cables ───────────────────────────────────────────────────────────
    def imp_cables(self):
        for nb in self.each("cables", "dcim/cables"):
            a = nb.get("a_terminations") or []
            b = nb.get("b_terminations") or []
            ends = [("A", t) for t in a] + [("B", t) for t in b]
            if not ends:
                # NetBox allows planned cables with no endpoints yet; that's
                # not an import failure, there's just nothing to connect.
                self.skip("cables", nb, "no terminations in NetBox")
                continue
            self.stats["cables"]["fetched"] += 1
            resolved, diag = [], []
            for end, t in ends:
                ot, oid = t.get("object_type"), t.get("object_id")
                key = NB_CT.get(ot)
                attr = CT_ATTR.get(key)
                comp = self.ref(key, oid) if key else None
                if comp and attr:
                    resolved.append((end, attr, comp))
                else:
                    why = (
                        "type not imported" if not key or not attr
                        else "component missing from import"
                    )
                    diag.append(f"{end}={ot}#{oid} ({why})")
            if len(resolved) < 2:
                if not diag:
                    # Every present end resolved, there just aren't two of
                    # them — a dangling cable (one side patched, the other
                    # not yet). Valid in NetBox; nothing to connect here.
                    self.skip(
                        "cables", nb, "only one end connected in NetBox",
                        counted=True,
                    )
                    continue
                self.stats["cables"]["failed"] += 1
                self.failures.append(f"[cables] nb#{nb['id']}: " + "; ".join(diag))
                continue
            # A cable has no natural key of its own — but each termination
            # POINT is unique (a component sits on at most one cable), so an
            # existing termination on our first endpoint IS this cable. Without
            # this the create below fires on every re-run, the termination's
            # unique constraint rolls it back, and every cable reports as a
            # failure — drowning the real ones.
            end0, attr0, comp0 = resolved[0]
            found = (
                m.CableTermination.objects
                .filter(**{attr0: comp0})
                .select_related("cable")
                .first()
            )
            if found is not None:
                self.idmap[("cables", nb["id"])] = found.cable
                self.stats["cables"]["existed"] += 1
                continue
            try:
                with transaction.atomic():
                    cable = m.Cable.objects.create(
                        tenant=self.tenant,
                        status=self.status(nb, "cable"),
                        type=_val(nb.get("type")) or "",
                        label=nb.get("label") or "",
                        color=_color(nb.get("color")),
                        length=nb.get("length"),
                        length_unit=_val(nb.get("length_unit")) or "m",
                        description=nb.get("description") or "",
                        custom_fields=self.cf(nb),
                    )
                    for end, attr, comp in resolved:
                        m.CableTermination.objects.create(
                            cable=cable, end=end, **{attr: comp}
                        )
            except Exception as e:  # noqa: BLE001
                self.stats["cables"]["failed"] += 1
                self.failures.append(f"[cables] nb#{nb['id']}: {e}")
                continue
            self.idmap[("cables", nb["id"])] = cable
            self.stats["cables"]["created"] += 1

    # ── circuits ─────────────────────────────────────────────────────────
    def imp_circuits(self):
        for nb in self.each("circuits", "circuits/circuits"):
            provider = self.ref("providers", nb.get("provider"))
            if not provider:
                self.skip("circuits", nb, "provider not imported")
                continue
            self.upsert(
                "circuits", m.Circuit, nb,
                {"tenant": self.tenant, "provider": provider, "cid": nb["cid"]},
                {
                    "type": self.ref("circuit_types", nb.get("type")),
                    "status": self.status(nb, "circuit"),
                    "install_date": nb.get("install_date"),
                    "description": nb.get("description", ""),
                    "comments": nb.get("comments", ""),
                },
                cf=True, tags=True,
            )

    def imp_circuit_terminations(self):
        for nb in self.each("circuit_terminations", "circuits/circuit-terminations"):
            circuit = self.ref("circuits", nb.get("circuit"))
            if not circuit:
                self.skip("circuit_terminations", nb, "circuit not imported")
                continue
            self.stats["circuit_terminations"]["fetched"] += 1
            try:
                with transaction.atomic():
                    m.CircuitTermination.objects.get_or_create(
                        circuit=circuit, term_side=nb["term_side"],
                        defaults={
                            "site": self.ref("sites", nb.get("site")),
                            "provider_network": self.ref(
                                "provider_networks", nb.get("provider_network")
                            ),
                            "port_speed_kbps": nb.get("port_speed"),
                            "upstream_speed_kbps": nb.get("upstream_speed"),
                            "xconnect_id": nb.get("xconnect_id") or "",
                        },
                    )
            except Exception as e:  # noqa: BLE001
                self.stats["circuit_terminations"]["failed"] += 1
                self.failures.append(f"[circuit_terminations] nb#{nb['id']}: {e}")
                continue
            self.stats["circuit_terminations"]["created"] += 1

    # ── contacts ─────────────────────────────────────────────────────────
    def imp_contacts(self):
        for nb in self.each("contacts", "tenancy/contacts"):
            self.upsert(
                "contacts", m.Contact, nb,
                {"tenant": self.tenant, "name": nb["name"]},
                {
                    "group": self.ref("contact_groups", nb.get("group")),
                    "title": nb.get("title") or "",
                    "phone": nb.get("phone") or "",
                    "email": nb.get("email") or "",
                    "address": nb.get("address") or "",
                    "link": nb.get("link") or "",
                    "comments": nb.get("comments", ""),
                },
                cf=True, tags=True,
            )

    def imp_contact_assignments(self):
        for nb in self.each("contact_assignments", "tenancy/contact-assignments"):
            contact = self.ref("contacts", nb.get("contact"))
            target = self.ref_generic(nb.get("object_type"), nb.get("object_id"))
            if not contact or not target:
                self.skip(
                    "contact_assignments", nb,
                    "contact not imported" if not contact
                    else "assigned object not imported",
                )
                continue
            self.stats["contact_assignments"]["fetched"] += 1
            try:
                with transaction.atomic():
                    m.ContactAssignment.objects.get_or_create(
                        tenant=self.tenant,
                        contact=contact,
                        role=self.ref("contact_roles", nb.get("role")),
                        object_type=target._meta.label_lower,
                        object_id=str(target.id),
                    )
            except Exception as e:  # noqa: BLE001
                self.stats["contact_assignments"]["failed"] += 1
                self.failures.append(f"[contact_assignments] nb#{nb['id']}: {e}")
                continue
            self.stats["contact_assignments"]["created"] += 1

    # ── floor plans (netbox-map plugin, optional) ────────────────────────
    # https://github.com/danbyte-net/netbox-map — floorplans hang off a
    # site (+ optional location); Danbyte plans hang off a Location, so
    # location-less plans land in a per-site "Imported floor plans" bucket.

    _TILE_ICONS = {
        "ap": "wifi", "camera": "cctv", "rack": "server", "power": "zap",
        "floorplan_link": "map", "empty": "square",
    }
    _TILE_LINKS = {
        # NetBox object type → (idmap key, tile FK field, link_kind)
        "dcim.device": ("devices", "device", "device"),
        "dcim.rack": ("racks", "rack", "rack"),
        "dcim.powerpanel": ("power_panels", "power_panel", "powerpanel"),
        "dcim.powerfeed": ("power_feeds", "power_feed", "powerfeed"),
    }

    def _floor_tile_type(self, value: str):
        """netbox-map's tile_type is a string enum; ours is tenant data.
        Mint one FloorTileType per distinct source value (import-derived
        data, like tags/statuses — not seed data)."""
        slug = slugify(value) or "tile"
        cache = getattr(self, "_ftt_cache", None)
        if cache is None:
            cache = self._ftt_cache = {}
        if slug not in cache:
            cache[slug], _ = m.FloorTileType.objects.get_or_create(
                tenant=self.tenant, slug=slug,
                defaults={
                    "name": value.replace("_", " ").capitalize(),
                    "icon": self._TILE_ICONS.get(value, ""),
                    "has_fov": value == "camera",
                },
            )
        return cache[slug]

    def _floorplan_location(self, nb):
        loc = self.ref("locations", nb.get("location"))
        if loc:
            return loc
        site = self.ref("sites", nb.get("site"))
        if not site:
            return None
        cache = getattr(self, "_fploc_cache", None)
        if cache is None:
            cache = self._fploc_cache = {}
        if site.pk not in cache:
            cache[site.pk], _ = m.Location.objects.get_or_create(
                tenant=self.tenant, site=site, slug="imported-floor-plans",
                defaults={"name": "Imported floor plans"},
            )
        return cache[site.pk]

    def imp_floor_plans(self):
        for nb in self.each("floor_plans", "plugins/map/floorplans",
                            optional=True):
            location = self._floorplan_location(nb)
            if not location:
                self.skip("floor_plans", nb, "site not imported")
                continue
            obj = self.upsert(
                "floor_plans", m.FloorPlan, nb,
                {"tenant": self.tenant, "location": location, "name": nb["name"]},
                {
                    "grid_width": min(512, max(1, nb.get("grid_width") or 24)),
                    "grid_height": min(512, max(1, nb.get("grid_height") or 16)),
                    "description": nb.get("description", ""),
                },
                cf=True, tags=True,
            )
            if obj:
                self._fetch_image(
                    obj, "background_image", nb.get("background_image"),
                    label="floor_plans:image",
                )

    def imp_floor_plan_tiles(self):
        TILE_STATUSES = {s for s, _ in m.FloorPlanTile.STATUS_CHOICES}
        link_misses: dict[str, int] = {}
        for nb in self.each("floor_plan_tiles", "plugins/map/floorplan-tiles",
                            optional=True):
            fp = self.ref("floor_plans", nb.get("floorplan"))
            if not fp:
                self.skip("floor_plan_tiles", nb, "floor plan not imported")
                continue
            tile_kind = _val(nb.get("tile_type")) or "empty"
            status = _val(nb.get("status")) or ""
            ori = nb.get("orientation") or 0
            defaults = {
                "width": max(1, nb.get("width") or 1),
                "height": max(1, nb.get("height") or 1),
                "tile_type": self._floor_tile_type(tile_kind),
                "status": status if status in TILE_STATUSES else "",
                "orientation": ori if ori in (90, 180, 270) else 0,
            }
            # At most one link (DB constraint): assigned object wins, then
            # the nested-plan link.
            ot = nb.get("assigned_object_type")
            linked = None
            if ot:
                key, field, kind = self._TILE_LINKS.get(ot, (None, None, None))
                linked = self.ref(key, nb.get("assigned_object_id")) if key else None
                if linked is not None:
                    defaults[field] = linked
                    defaults["link_kind"] = kind
                else:
                    # Tile still imports (position + label survive), just
                    # unlinked — tallied so the loss is visible.
                    link_misses[ot] = link_misses.get(ot, 0) + 1
            if linked is None:
                lfp = self.ref("floor_plans", nb.get("linked_floorplan"))
                if lfp is not None:
                    defaults["linked_floor_plan"] = lfp
                    defaults["link_kind"] = "floorplan"
            if tile_kind == "camera":
                defaults["fov_deg"] = nb.get("fov_angle")
                defaults["fov_distance"] = nb.get("fov_distance")
                defaults["fov_direction"] = nb.get("fov_direction")
            self.upsert(
                "floor_plan_tiles", m.FloorPlanTile, nb,
                {
                    "floor_plan": fp,
                    "x": nb.get("x_position") or 0,
                    "y": nb.get("y_position") or 0,
                    "label": nb.get("label") or "",
                },
                defaults,
            )
        for ot, n in sorted(link_misses.items()):
            self.notes.append(
                f"floor_plan_tiles: {n} tile(s) imported without their link — "
                f"{ot} not imported/supported"
            )

    # ── finalize (break the device/VM ↔ IP cycle) ────────────────────────
    def finalize_device_links(self):
        for nbid, nb in self._nb_devices.items():
            dev = self.idmap.get(("devices", nbid))
            if not dev:
                continue
            fields = {}
            for attr, nbkey in (("primary_ip", "primary_ip"),
                                ("secondary_ip", "secondary_ip"),
                                ("oob_ip", "oob_ip")):
                ip = self.ref("ip_addresses", nb.get(nbkey) or nb.get(nbkey + "4"))
                if ip and getattr(dev, attr + "_id") != ip.id:
                    setattr(dev, attr, ip)
                    fields[attr] = True
            vc = self.ref("virtual_chassis", nb.get("virtual_chassis"))
            if vc and dev.virtual_chassis_id != vc.id:
                dev.virtual_chassis = vc
                dev.vc_position = nb.get("vc_position")
                dev.vc_priority = nb.get("vc_priority")
                fields["vc"] = True
            if fields:
                try:
                    dev.save()
                except Exception as e:  # noqa: BLE001
                    self.failures.append(f"[devices:link] {dev.name}: {e}")

    def finalize_vm_links(self):
        for nbid, nb in self._nb_vms.items():
            vm = self.idmap.get(("virtual_machines", nbid))
            if not vm:
                continue
            ip = self.ref("ip_addresses", nb.get("primary_ip") or nb.get("primary_ip4"))
            if ip and vm.primary_ip_id != ip.id:
                vm.primary_ip = ip
                try:
                    vm.save(update_fields=["primary_ip"])
                except Exception as e:  # noqa: BLE001
                    self.failures.append(f"[vm:link] {vm.name}: {e}")

    # ── report ───────────────────────────────────────────────────────────
    def report(self) -> dict:
        # Roll the skip tallies into notes so an all-skipped type is
        # diagnosable from the report ("front_ports: 700 skipped — rear port
        # not imported (e.g. nb#40, nb#41, nb#42)").
        for (key, reason), entry in sorted(self._skips.items()):
            self.notes.append(
                f"{key}: {entry['count']} skipped — {reason} "
                f"(e.g. {', '.join(entry['samples'])})"
            )
        rows = sorted(self.stats.items())
        self.log("")
        self.log(f"NetBox → Danbyte import  (tenant: {self.tenant.slug})")
        self.log("─" * 69)
        self.log(
            f"{'TYPE':24}{'FETCH':>7}{'NEW':>7}{'EXIST':>7}{'UPD':>7}"
            f"{'FAIL':>7}{'SKIP':>7}"
        )
        self.log("─" * 69)
        tot = {
            "fetched": 0, "created": 0, "existed": 0,
            "updated": 0, "failed": 0, "skipped": 0,
        }
        for key, s in rows:
            self.log(
                f"{key:24}{s['fetched']:>7}{s['created']:>7}{s['existed']:>7}"
                f"{s['updated']:>7}{s['failed']:>7}{s.get('skipped', 0):>7}"
            )
            for k in tot:
                tot[k] += s.get(k, 0)
        self.log("─" * 69)
        self.log(
            f"{'TOTAL':24}{tot['fetched']:>7}{tot['created']:>7}{tot['existed']:>7}"
            f"{tot['updated']:>7}{tot['failed']:>7}{tot['skipped']:>7}"
        )
        if self.images["ok"] or self.images["fail"]:
            self.log(
                f"\nImages: {self.images['ok']} downloaded, {self.images['fail']} failed"
            )
        if self.notes:
            self.log("\nNotes:")
            for n in self.notes[:50]:
                self.log(f"  • {n}")
        if self.failures:
            self.log(f"\nFailures ({len(self.failures)}):")
            for f in self.failures[:100]:
                self.log(f"  ✗ {f}")
            if len(self.failures) > 100:
                self.log(f"  … and {len(self.failures) - 100} more (see JSON report)")
        return {
            "tenant": self.tenant.slug,
            "totals": tot,
            "by_type": {k: v for k, v in rows},
            "notes": self.notes,
            "failures": self.failures,
        }


class Command(BaseCommand):
    help = "Import a NetBox instance into Danbyte via its REST API."

    def add_arguments(self, parser):
        parser.add_argument("--url", required=True, help="NetBox base URL")
        parser.add_argument("--token", required=True, help="NetBox API token")
        parser.add_argument(
            "--tenant", help="Danbyte target tenant slug (default: 'default' or first)"
        )
        parser.add_argument("--org", help="Disambiguate tenant by organization name")
        parser.add_argument("--only", help="Comma list of types to import")
        parser.add_argument("--skip", help="Comma list of types to skip")
        parser.add_argument(
            "--insecure", action="store_true", help="Skip TLS verification"
        )
        parser.add_argument(
            "--with-images", action="store_true",
            help="Download device-type front/rear images from NetBox media",
        )
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Fetch + build everything in a transaction, then roll back",
        )
        parser.add_argument(
            "--update-existing", action="store_true",
            help="Re-apply NetBox values to objects that already exist "
            "(default: existing rows are left untouched). Overwrites local edits.",
        )
        parser.add_argument("--report", help="Write a JSON summary to this path")

    def _resolve_tenant(self, slug, org) -> Tenant:
        qs = Tenant.objects.all()
        if org:
            qs = qs.filter(org__name=org)
        if slug:
            qs = qs.filter(slug=slug)
        else:
            default = qs.filter(slug="default").first()
            if default:
                return default
        n = qs.count()
        if n == 0:
            raise CommandError("No matching Danbyte tenant. Run `bootstrap` first.")
        if n > 1:
            raise CommandError(
                "Ambiguous tenant — pass --tenant <slug> (and --org if needed). "
                f"Candidates: {', '.join(t.slug for t in qs[:10])}"
            )
        return qs.first()

    def handle(self, *args, **o):
        tenant = self._resolve_tenant(o.get("tenant"), o.get("org"))
        seeded = seed_builtin_statuses(tenant)
        self.stdout.write(
            f"Target tenant: {tenant.org.name} / {tenant.slug}  "
            f"(statuses ready: {seeded} seeded/verified)"
        )
        client = NetBoxClient(o["url"], o["token"], verify=not o["insecure"])
        opts = {
            "only": {s.strip() for s in (o.get("only") or "").split(",") if s.strip()},
            "skip": {s.strip() for s in (o.get("skip") or "").split(",") if s.strip()},
            "with_images": bool(o.get("with_images")),
            "dry_run": bool(o["dry_run"]),
            "update_existing": bool(o.get("update_existing")),
        }
        imp = _Importer(self, client, tenant, opts)

        if o["dry_run"]:
            self.stdout.write(self.style.WARNING("DRY RUN — nothing will be saved.\n"))
            try:
                with transaction.atomic():
                    imp.run()
                    raise _Rollback()
            except _Rollback:
                pass
        else:
            imp.run()

        result = imp.report()
        if o.get("report"):
            with open(o["report"], "w") as fh:
                json.dump(result, fh, indent=2, default=str)
            self.stdout.write(f"\nJSON report → {o['report']}")
        if o["dry_run"]:
            self.stdout.write(self.style.WARNING("\n(rolled back — dry run)"))
