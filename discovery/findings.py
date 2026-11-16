"""The review queue (#451 B3): proposals built from observed services.

Nothing here writes on its own. Each current observation (an open port on an
address) may propose, for a person to accept or ignore:

``service``   its device or VM has no Service on that port: add one
              (needs *add* on services, site scope included);
``software``  a fingerprint named a product, and the host has no install of
              an application of that name: add the install, and the
              application when the tenant has none of that name (needs
              *add* on installed software, and on applications for a new
              one). The version comes from the banner; an existing install
              is never touched;
``cpe``       the product has a CPE guess and the tenant's application of
              that name is not mapped: map it, through the vulnerability
              data's own bulk create (``POST /api/vulnerabilities/mappings/
              bulk-create/``), with *change* on the application.

An observation on an address with no device or VM, and an open port nothing
recognised, propose nothing; they are listed as observed services only.

Ignore is remembered per observation and kind (``FindingDecision``) until
the observation's evidence changes (product, version, CPE or service name).
Banner fingerprints never create vulnerability matches (decision 7).
"""
from __future__ import annotations

from django.db.models import Q
from django.utils.text import slugify

KINDS = ("service", "software", "cpe")
MAX_ROWS = 5000


def visible_observations(request, tenant, *, current=True):
    """Observations (current ones: the port was open at the last scan) on
    addresses the caller may view."""
    from api.models import IPAddress
    from auth_api import rbac

    from .models import ObservedService

    qs = ObservedService.objects.filter(tenant=tenant)
    if current:
        qs = qs.filter(gone_at__isnull=True)
    if not request.user.is_superuser:
        ips = rbac.restrict_queryset(IPAddress.objects.filter(tenant=tenant), request.user,
                                     tenant, "ipaddress", "view")
        qs = qs.filter(ip_address__in=ips.values("pk"))
    return qs.select_related("device", "virtual_machine", "ip_address")


def _host(o):
    if o.device_id:
        return "device", o.device
    if o.virtual_machine_id:
        return "virtual_machine", o.virtual_machine
    return "", None


def _ref(obj, label="name"):
    return None if obj is None else {"id": str(obj.pk), "name": str(getattr(obj, label))}


def evidence(o) -> dict:
    return {"observed_id": str(o.pk), "address": o.address, "port": o.port,
            "protocol": o.protocol, "service_name": o.service_name,
            "banner": o.banner[:200], "source": o.source, "rule": o.rule,
            "confidence": o.confidence, "product": o.product, "vendor": o.vendor,
            "version": o.version, "cpe": o.cpe, "last_seen": o.last_seen}


def service_name(o) -> str:
    return (o.service_name or o.product or f"tcp-{o.port}")[:128]


def build(tenant, observations, *, vulnerabilities_on: bool, include_ignored=False) -> list:
    """Every proposal for ``observations`` (a list of ObservedService)."""
    from api.models import Application, InstalledSoftware, Service

    from .models import FindingDecision

    obs = list(observations[:MAX_ROWS])
    if not obs:
        return []
    ignored = {(d.observed_id, d.kind): d.evidence for d in FindingDecision.objects.filter(
        tenant=tenant, observed__in=[o.pk for o in obs])}

    def is_ignored(o, kind):
        return ignored.get((o.pk, kind)) == o.evidence_key()

    dev_ids = {o.device_id for o in obs if o.device_id}
    vm_ids = {o.virtual_machine_id for o in obs if o.virtual_machine_id}
    have_ports: set = set()
    for dev, vm, pm, proto, ports in Service.objects.filter(tenant=tenant).filter(
            Q(device_id__in=dev_ids) | Q(virtual_machine_id__in=vm_ids)).values_list(
            "device_id", "virtual_machine_id", "protocol_ports", "protocol", "ports"):
        port_map = {k: v for k, v in (pm or {}).items() if v} or {proto: ports or []}
        for p_, ps in port_map.items():
            for port in ps or []:
                have_ports.add((dev, vm, p_, int(port)))
    names = {o.product.strip().lower() for o in obs if o.product}
    apps = {}
    for a in Application.objects.filter(tenant=tenant).filter(
            Q(name__in=[o.product for o in obs if o.product])
            | Q(slug__in=[slugify(n) for n in names])):
        apps.setdefault(a.name.lower(), a)
        apps.setdefault(a.slug, a)
    installs = set(InstalledSoftware.objects.filter(tenant=tenant).filter(
        Q(device_id__in=dev_ids) | Q(virtual_machine_id__in=vm_ids)).values_list(
        "application_id", "device_id", "virtual_machine_id"))
    mapped: set = set()
    if vulnerabilities_on:
        from vulnerabilities.models import ProductMapping

        mapped = set(ProductMapping.objects.filter(
            tenant=tenant, application__isnull=False, enabled=True).values_list(
            "application_id", flat=True))

    out: list[dict] = []
    cpe_rows: dict = {}
    for o in obs:
        kind, host = _host(o)
        if host is None:
            continue
        ev = evidence(o)
        hostref = {"kind": kind, **_ref(host)}
        known = bool(o.service_name or o.product)
        if known and (o.device_id, o.virtual_machine_id, o.protocol, o.port) not in have_ports:
            ign = is_ignored(o, "service")
            if include_ignored or not ign:
                out.append({"id": f"service:{o.pk}", "kind": "service", "host": hostref,
                            "title": f"Add service {service_name(o)} ({o.protocol}/{o.port})",
                            "proposal": {"name": service_name(o), "protocol": o.protocol,
                                         "port": o.port, "ip_address": str(o.ip_address_id)},
                            "confidence": o.confidence, "ignored": ign, "evidence": [ev]})
        if not o.product:
            continue
        app = apps.get(o.product.strip().lower()) or apps.get(slugify(o.product))
        if app is None or (app.pk, o.device_id, o.virtual_machine_id) not in installs:
            ign = is_ignored(o, "software")
            if include_ignored or not ign:
                label = f"{o.product} {o.version}".strip()
                out.append({"id": f"software:{o.pk}", "kind": "software", "host": hostref,
                            "title": f"Add installed software {label}",
                            "proposal": {"application": _ref(app),
                                         "application_name": o.product[:128],
                                         "version": o.version[:64]},
                            "confidence": o.confidence, "ignored": ign, "evidence": [ev]})
        if vulnerabilities_on and o.cpe and app is not None and app.pk not in mapped \
                and not (app.cpe_template or app.purl_template):
            parts = o.cpe.split(":")
            if len(parts) >= 5 and parts[2] in ("a", "o"):
                ident = ":".join(parts[:5])
                key = (app.pk, ident)
                ign = is_ignored(o, "cpe")
                if not include_ignored and ign:
                    continue
                row = cpe_rows.get(key)
                if row is None:
                    row = {"id": f"cpe:{app.pk}:{ident}", "kind": "cpe", "host": None,
                           "title": f"Map {app.name} to {ident}",
                           "proposal": {"application": _ref(app), "identifier": ident},
                           "confidence": o.confidence, "ignored": ign, "evidence": []}
                    cpe_rows[key] = row
                    out.append(row)
                row["evidence"].append(ev)
                row["ignored"] = row["ignored"] and ign
    rank = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda r: (KINDS.index(r["kind"]), rank.get(r["confidence"], 3), r["title"]))
    return out


# ─── accepting ───────────────────────────────────────────────────────────────


class Refused(Exception):
    pass


def _check_created(user, tenant, slug, obj):
    """The caller may add this exact object (row and site scope included)."""
    from auth_api import rbac

    if user.is_superuser:
        return
    if not rbac.can_act_on(user, tenant, slug, "add", obj):
        raise Refused(f"{slug}.add required for this host.")


def accept_service(request, tenant, o) -> dict:
    from api.models import Service

    kind, host = _host(o)
    if host is None:
        raise Refused("The address has no device or VM.")
    if Service.objects.filter(tenant=tenant, **{kind: host}).filter(
            Q(ports__contains=[o.port], protocol=o.protocol)
            | Q(**{f"protocol_ports__{o.protocol}__contains": [o.port]})).exists():
        raise Refused("The host already has a service on this port.")
    svc = Service(tenant=tenant, name=service_name(o), protocol=o.protocol, ports=[o.port],
                  ip_address=o.ip_address, **{kind: host},
                  description=f"Found by a service scan on {o.last_seen:%Y-%m-%d}.")
    svc.save()
    _check_created(request.user, tenant, "service", svc)
    return {"kind": "service", "id": str(svc.pk), "name": str(svc)}


def accept_software(request, tenant, o) -> dict:
    from api.models import Application, InstalledSoftware
    from auth_api import rbac

    kind, host = _host(o)
    if host is None or not o.product:
        raise Refused("Nothing to add.")
    user = request.user
    app = Application.objects.filter(tenant=tenant).filter(
        Q(name__iexact=o.product) | Q(slug=slugify(o.product))).first()
    created_app = None
    if app is None:
        if not user.is_superuser and (
                not rbac.has_action(user, tenant, "application", "add")
                or rbac.site_scope(user, tenant, "application", "add") is not None):
            raise Refused("application.add required to add a new application.")
        base = slugify(o.product)[:120] or "application"
        slug, n = base, 1
        while Application.objects.filter(tenant=tenant, slug=slug).exists():
            n += 1
            slug = f"{base}-{n}"
        app = Application(tenant=tenant, name=o.product[:128], slug=slug,
                          description="Found by a service scan.")
        app.save()
        created_app = app
    if InstalledSoftware.objects.filter(tenant=tenant, application=app, **{kind: host}).exists():
        raise Refused("The host already has this application.")
    inst = InstalledSoftware(tenant=tenant, application=app, version=o.version[:64],
                             source="discovery", last_seen=o.last_seen, **{kind: host})
    inst.save()
    _check_created(user, tenant, "installedsoftware", inst)
    out = {"kind": "software", "id": str(inst.pk), "name": f"{app.name} {inst.version}".strip()}
    if created_app is not None:
        out["application"] = {"id": str(created_app.pk), "name": created_app.name}
    return out
