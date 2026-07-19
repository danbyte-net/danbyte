"""Wire a documented Service's ports into monitoring checks.

A :class:`api.models.Service` with ``monitored=True`` gets one ``tcp``/``udp``
:class:`~monitoring.models.CheckAssignment` per port against its *target IP*
(the service's own IP, else the parent device/VM's primary IP). Toggling
``monitored`` off — or a service that has no target IP / no ports yet — removes
the assignments this service owns and leaves everything else alone.

This is the single reconciliation path behind the Services-tab toggle, the
``POST /api/services/{id}/monitor/`` action, and device-type service
materialisation. See ``docs/architecture/service-monitoring.md``.
"""
from __future__ import annotations


def service_target_ip(service):
    """The IP a service's checks run against, or None if none can be resolved.

    Order: the service's own IP, then the parent device's primary IP, then the
    parent VM's primary IP."""
    if service.ip_address_id:
        return service.ip_address
    dev = service.device
    if dev is not None and dev.primary_ip_id:
        return dev.primary_ip
    vm = service.virtual_machine
    if vm is not None and vm.primary_ip_id:
        return vm.primary_ip
    return None


def sync_service_checks(service, *, created_by=None) -> dict:
    """Reconcile a service's monitoring checks with its ``monitored`` flag.

    Idempotent and safe to call on every save. Returns
    ``{"monitored": <ports now checked>, "ip": <target ip str or None>}``.
    """
    from api.models import IPAddress

    from .models import CheckAssignment, CheckTemplate
    from .scheduler import materialise_ip

    target = service_target_ip(service)
    ports = service.ports or []

    # Teardown: flag off, no target IP, or no ports. Only remove what this
    # service owns; manual assignments (service IS NULL) are untouched.
    if not service.monitored or target is None or not ports:
        owned = CheckAssignment.objects.filter(service=service)
        affected = set(owned.values_list("ip_address_id", flat=True))
        owned.delete()
        for ip in IPAddress.objects.filter(id__in=affected):
            materialise_ip(ip)
        return {"monitored": 0, "ip": target.ip_address if target else None}

    kind = service.protocol if service.protocol in ("tcp", "udp") else "tcp"
    # Drop any owned assignments that no longer match (IP changed, or a port was
    # removed) before (re)creating the current set.
    stale = CheckAssignment.objects.filter(service=service).exclude(
        ip_address=target
    )
    restale = set(stale.values_list("ip_address_id", flat=True))
    stale.delete()

    n = 0
    for port in ports:
        tmpl, _ = CheckTemplate.objects.get_or_create(
            tenant=service.tenant,
            slug=f"{kind}-{port}",
            defaults={
                "name": f"{kind.upper()} {port}",
                "kind": kind,
                "params": {"port": port},
                "secret_params": {},
            },
        )
        CheckAssignment.objects.get_or_create(
            tenant=service.tenant,
            template=tmpl,
            ip_address=target,
            defaults={"created_by": created_by, "service": service},
        )
        n += 1

    # Remove owned assignments for ports this service no longer exposes.
    keep_slugs = {f"{kind}-{p}" for p in ports}
    dropped = CheckAssignment.objects.filter(
        service=service, ip_address=target
    ).exclude(template__slug__in=keep_slugs)
    dropped.delete()

    materialise_ip(target)
    for ip in IPAddress.objects.filter(id__in=restale - {target.id}):
        materialise_ip(ip)
    return {"monitored": n, "ip": target.ip_address}
