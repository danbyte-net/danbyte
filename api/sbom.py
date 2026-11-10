"""A CycloneDX 1.6 software bill of materials for devices and VMs.

``GET /api/sbom/`` answers a CycloneDX JSON document, as a download, for the
active tenant's devices and virtual machines the caller may view. Each host
is a component - ``device`` for a device, ``platform`` for a VM - with its
platform as a nested ``operating-system`` component and every installed
application as a nested ``application`` component. Each carries its name,
version, supplier (the manufacturer), licence, and package URL and CPE when
they resolve (``api.package_ids``). The ``dependencies``
section links each host to what runs on it.

Filters, each repeatable or comma-separated, any-of within one filter and
all-of across filters:

``site``             site ids, names or slugs (case-insensitive);
``tag``              tag ids or slugs;
``role``             device role ids;
``device``           device ids;
``virtual_machine``  virtual machine ids.

``device`` and ``virtual_machine`` pick hosts by id: given either, only the
listed hosts of each kind are in the document. ``POST`` takes the same
filters as a JSON body, for a selection of more ids than a URL holds.

A licence is the install's own, else its application's; the operating
system's is its platform's. An unknown licence is left out, never guessed;
``metadata.properties`` counts the components without one
(``danbyte:components_without_license``) and names them
(``danbyte:unlicensed``) so the gaps can be fixed before the document goes
out.
"""
from __future__ import annotations

import json
import uuid
from collections.abc import Mapping

from django.db.models import Prefetch, Q
from django.http import HttpResponse
from django.utils import timezone
from django.utils.text import slugify
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes, renderer_classes
from rest_framework.exceptions import ParseError
from rest_framework.permissions import IsAuthenticated
from rest_framework.renderers import JSONRenderer

from auth_api.rbac import restrict_queryset

from .natural import natural
from .package_ids import render_cpe, render_purl
from .spdx import license_entry

SPEC_VERSION = "1.6"
SCHEMA = "http://cyclonedx.org/schema/bom-1.6.schema.json"
CONTENT_TYPE = "application/vnd.cyclonedx+json; version=1.6"
#: The most ids one filter takes.
MAX_IDS = 10_000
FILTERS = ("site", "tag", "role", "device", "virtual_machine")


# ─── parameters ──────────────────────────────────────────────────────────────


def _values(params, key) -> list[str] | None:
    """The ``key`` values: repeated, comma-separated, or a JSON list. None
    when the filter is absent."""
    if hasattr(params, "getlist"):
        raw = params.getlist(key)
        if not raw:
            return None
    else:
        raw = params.get(key)
        if raw is None:
            return None
        if not isinstance(raw, (list, tuple)):
            raw = [raw]
    out: list[str] = []
    for item in raw:
        out.extend(p.strip() for p in str(item).split(",") if p.strip())
    if len(out) > MAX_IDS:
        raise ParseError(f"{key}: at most {MAX_IDS:,} values")
    return list(dict.fromkeys(out))


def _uuids(params, key) -> list[uuid.UUID] | None:
    vals = _values(params, key)
    if vals is None:
        return None
    try:
        return [uuid.UUID(v) for v in vals]
    except ValueError:
        raise ParseError(f"{key}: not a valid id") from None


def _params(request):
    if request.method != "POST":
        return request.query_params
    if not isinstance(request.data, Mapping):
        raise ParseError("The body must be a JSON object.")
    return request.data


def _site_ids(request, tenant, params) -> list[uuid.UUID] | None:
    """The ``site`` filter as ids. A value is an id, else a site name
    (exact case first, then case-insensitive) or the slug of one, looked up
    among the sites the caller may view: a site out of scope is as unknown
    as a name nobody uses, and matches no host (#468)."""
    from .models import Site

    vals = _values(params, "site")
    if vals is None:
        return None
    out: list[uuid.UUID] = []
    names: list[str] = []
    for v in vals:
        try:
            out.append(uuid.UUID(v))
        except ValueError:
            names.append(v)
    if names:
        visible = list(restrict_queryset(
            Site.objects.filter(tenant=tenant), request.user, tenant, "site", "view",
        ).values_list("pk", "name"))
        for v in names:
            low = v.lower()
            hits = ([pk for pk, n in visible if n == v]
                    or [pk for pk, n in visible if n.lower() == low]
                    or [pk for pk, n in visible if slugify(n) == low])
            out.extend(hits)
    return list(dict.fromkeys(out))


def _tag_q(values: list[str]) -> Q:
    ids = [int(v) for v in values if v.isdigit()]
    slugs = [v for v in values if not v.isdigit()]
    return Q(tags__id__in=ids) | Q(tags__slug__in=slugs)


def _hosts(request, tenant, params):
    """The devices and VMs the document covers: the tenant's, the caller may
    view, narrowed by the filters. Each comes with what its components read,
    so the document costs the same few queries however many hosts it has."""
    from .models import Device, InstalledSoftware, VirtualMachine

    sites = _site_ids(request, tenant, params)
    roles = _uuids(params, "role")
    tags = _values(params, "tag")
    device_ids = _uuids(params, "device")
    vm_ids = _uuids(params, "virtual_machine")
    by_id = device_ids is not None or vm_ids is not None

    installs = restrict_queryset(
        InstalledSoftware.objects.filter(tenant=tenant), request.user, tenant,
        "installedsoftware", "view",
    )

    def narrow(qs, ids):
        if by_id:
            qs = qs.filter(pk__in=ids or [])
        if sites is not None:
            qs = qs.filter(site_id__in=sites)
        if roles is not None:
            qs = qs.filter(role_id__in=roles)
        if tags is not None:
            qs = qs.filter(pk__in=qs.model.objects.filter(_tag_q(tags)).values("pk"))
        return qs

    devices = restrict_queryset(
        Device.objects.filter(tenant=tenant), request.user, tenant, "device", "view",
    )
    vms = restrict_queryset(
        VirtualMachine.objects.filter(tenant=tenant), request.user, tenant,
        "virtualmachine", "view",
    )
    devices, vms = what_runs_where(narrow(devices, device_ids), narrow(vms, vm_ids),
                                   installs)
    return devices, vms, sites


def what_runs_where(devices, vms, installs):
    """The hosts with what runs on them: each device and VM with its
    platform (a device's type's platform too), its device type and every
    install of ``installs`` with its application, in a fixed number of
    queries however many hosts there are. The SBOM and the vulnerability
    matcher (``vulnerabilities.matching``) both read these rows; the caller
    scopes the three querysets (by tenant, by RBAC, by filters)."""
    installs = installs.select_related("application", "application__manufacturer").order_by(
        natural("application__name"), "version",
    )
    devices = devices.select_related(
        "site", "role", "device_type__manufacturer", "device_type__platform",
        "platform__manufacturer",
    ).prefetch_related(
        Prefetch("installed_software", queryset=installs),
    ).order_by(natural("name"))
    vms = vms.select_related(
        "site", "role", "cluster", "platform__manufacturer",
    ).prefetch_related(
        Prefetch("installed_software", queryset=installs),
    ).order_by(natural("name"))
    return devices, vms


# ─── components ──────────────────────────────────────────────────────────────


def _prop(name: str, value) -> dict:
    return {"name": f"danbyte:{name}", "value": str(value)}


def _component(kind: str, ref: str, name: str, *, version="", supplier=None,
               license="", purl="", cpe="", properties=()) -> dict:
    """One CycloneDX component; blank facts are left out."""
    c = {"type": kind, "bom-ref": ref, "name": name}
    if version:
        c["version"] = version
    if supplier is not None:
        c["supplier"] = {"name": supplier.name}
    if cpe:
        c["cpe"] = cpe
    if purl:
        c["purl"] = purl
    entry = license_entry(license)
    if entry is not None:
        c["licenses"] = [entry]
    if properties:
        c["properties"] = list(properties)
    return c


class _Builder:
    """Builds the components and dependencies and counts the licence gaps."""

    def __init__(self):
        self.components: list[dict] = []
        self.dependencies: list[dict] = []
        self.total = 0
        self.missing = 0
        self.unlicensed: dict[str, None] = {}

    def _software(self, kind, ref, name, *, license, **kw) -> dict:
        self.total += 1
        if not license:
            self.missing += 1
            self.unlicensed[name] = None
        return _component(kind, ref, name, license=license, **kw)

    def host(self, obj, kind: str) -> str:
        is_device = kind == "device"
        ref = f"danbyte:{kind}:{obj.pk}"
        children = []
        platform = obj.platform
        os_version = obj.software_version
        if platform is not None:
            children.append(self._software(
                "operating-system", f"{ref}:os", platform.name,
                version=os_version, supplier=platform.manufacturer,
                license=platform.license,
                purl=render_purl(platform.purl_template, version=os_version,
                                 os_version=os_version),
                cpe=render_cpe(platform.cpe_template, version=os_version,
                               os_version=os_version),
                properties=[_prop("platform", platform.slug)],
            ))
        for inst in obj.installed_software.all():
            app = inst.application
            children.append(self._software(
                "application", f"danbyte:installedsoftware:{inst.pk}", app.name,
                version=inst.version, supplier=app.manufacturer,
                license=inst.effective_license,
                purl=inst.effective_purl, cpe=inst.effective_cpe,
                properties=[_prop("application", app.slug), _prop("source", inst.source)],
            ))
        props = [_prop("kind", kind), _prop("id", obj.pk)]
        if obj.site_id:
            props.append(_prop("site", obj.site.name))
        if obj.role_id:
            props.append(_prop("role", obj.role.name))
        if not is_device and obj.cluster_id:
            props.append(_prop("cluster", obj.cluster.name))
        supplier = None
        if is_device and obj.device_type_id:
            supplier = obj.device_type.manufacturer
            props.append(_prop("device_type", obj.device_type.model))
        comp = _component("device" if is_device else "platform", ref, obj.name,
                          supplier=supplier, properties=props)
        if children:
            comp["components"] = children
        self.components.append(comp)
        self.dependencies.append(
            {"ref": ref, "dependsOn": [c["bom-ref"] for c in children]}
        )
        return ref


def build_sbom(request, tenant, params) -> tuple[dict, str]:
    """The CycloneDX document and its file name."""
    from danbyte import __version__

    from .models import Site

    b = _Builder()
    site = None
    refs: list[str] = []
    if tenant is not None:
        devices, vms, sites = _hosts(request, tenant, params)
        if sites is not None and len(sites) == 1:
            # Through the caller's site scope, as the site list reads it: a
            # site they can't view is named nowhere - the subject is then
            # "selection", the same as an unknown id (#468).
            site = restrict_queryset(
                Site.objects.filter(tenant=tenant), request.user, tenant, "site", "view",
            ).filter(pk=sites[0]).first()
        refs = [b.host(d, "device") for d in devices] + [
            b.host(vm, "virtual_machine") for vm in vms
        ]

    if site is not None:
        subject = {"type": "platform", "bom-ref": f"danbyte:site:{site.pk}",
                   "name": site.name}
        stem = slugify(site.name) or "site"
    else:
        subject = {"type": "platform", "bom-ref": "danbyte:selection",
                   "name": "selection"}
        stem = "selection"
    now = timezone.now()
    unlicensed = sorted(b.unlicensed, key=str.lower)
    doc = {
        "$schema": SCHEMA,
        "bomFormat": "CycloneDX",
        "specVersion": SPEC_VERSION,
        "serialNumber": f"urn:uuid:{uuid.uuid4()}",
        "version": 1,
        "metadata": {
            "timestamp": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tools": {"components": [
                {"type": "application", "name": "Danbyte", "version": __version__},
            ]},
            "component": subject,
            "properties": [
                _prop("hosts", len(refs)),
                _prop("components", b.total),
                _prop("components_without_license", b.missing),
                *([_prop("unlicensed", ", ".join(unlicensed))] if unlicensed else []),
            ],
        },
        "components": b.components,
        "dependencies": [{"ref": subject["bom-ref"], "dependsOn": refs},
                         *b.dependencies],
    }
    return doc, f"sbom-{stem}-{now:%Y%m%d}.cdx.json"


class CycloneDXRenderer(JSONRenderer):
    """Lets a client ask for ``application/vnd.cyclonedx+json``; errors
    render as JSON either way."""

    media_type = "application/vnd.cyclonedx+json"
    format = "cdx"


@extend_schema(
    summary="CycloneDX 1.6 SBOM of the active tenant's devices and VMs",
    tags=["inventory"],
    request=OpenApiTypes.OBJECT,
    parameters=[
        OpenApiParameter(k, OpenApiTypes.STR, OpenApiParameter.QUERY, description=d)
        for k, d in (
            ("site", "Site ids, names or slugs, repeatable or comma-separated."),
            ("tag", "Tag ids or slugs, repeatable or comma-separated."),
            ("role", "Device role ids, repeatable or comma-separated."),
            ("device", "Device ids. Given this or virtual_machine, only the "
                       "listed hosts are included."),
            ("virtual_machine", "Virtual machine ids."),
        )
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="A CycloneDX 1.6 JSON document, as an attachment.",
    ),
)
@api_view(["GET", "POST"])
@renderer_classes([JSONRenderer, CycloneDXRenderer])
@permission_classes([IsAuthenticated])
def sbom(request):
    from .views import _get_active_tenant

    doc, filename = build_sbom(request, _get_active_tenant(request), _params(request))
    resp = HttpResponse(json.dumps(doc, indent=2), content_type=CONTENT_TYPE)
    resp["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp
