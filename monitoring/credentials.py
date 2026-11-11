"""Which login a host is reached with: its own credential, else a shared one.

One place answers "what credentials may be tried for this host, in which
order", so every consumer (Discovery today; Connect, the SSH terminal and
others can adopt it) applies the same rule:

1. the host's own :class:`~monitoring.models.DeviceCredential` of a fitting
   kind (the first fitting kind in ``kinds`` wins, then the name);
2. a shared credential the caller pinned (an inventory profile's
   ``shared_credential``), when it is enabled and of a fitting kind;
3. every enabled :class:`~monitoring.models.SharedCredential` whose scope
   matches the host: lowest ``weight`` first, ties broken by the most
   specific scope (the most dimensions named), then the name.

An empty scope never matches unless the set says ``all_hosts``.

How many of those are *tried* is :func:`attempts`: the first one only,
unless the credential that was refused says ``fall_through`` - trying one
password after another against the same account is how accounts get locked
out - and never more than :data:`MAX_TRIES`.

Nothing here reads a secret. A :class:`Login` carries the credential row;
the consumer calls ``resolve_secret()`` at connect time.
"""
from __future__ import annotations

from dataclasses import dataclass

#: Credentials tried for one host, at most.
MAX_TRIES = 3
#: Scope dimensions: (M2M on SharedCredential, the host attribute it is
#: compared with, whether a VM has it).
DIMENSIONS = (
    ("roles", "role_id", True),
    ("device_types", "device_type_id", False),
    ("platforms", "platform_id", True),
    ("sites", "site_id", True),
)


@dataclass
class Login:
    """One credential to try. ``source`` is ``host`` or ``shared: <name>``."""

    credential: object
    source: str

    @property
    def kind(self) -> str:
        return self.credential.kind

    @property
    def fall_through(self) -> bool:
        return bool(getattr(self.credential, "fall_through", False))


@dataclass
class _Set:
    row: object
    ids: dict
    specificity: int


def _host_kind(host) -> str:
    from api.models import VirtualMachine

    return "virtual_machine" if isinstance(host, VirtualMachine) else "device"


class CredentialResolver:
    """Resolve logins for many hosts of one tenant with a fixed number of
    queries: load the tenant's enabled shared credentials (and the host
    credentials of the hosts asked about) once, then answer per host.

    ``user``: when given (a person pressing Run now), only credentials that
    person may view are used - ``devicecredential`` and
    ``sharedcredential`` view, row scope included."""

    def __init__(self, tenant, *, kinds, user=None, pinned=None):
        from auth_api import rbac

        from .models import SharedCredential

        self.tenant = tenant
        self.kinds = tuple(kinds)
        self.user = user if user is not None and not user.is_superuser else None
        qs = SharedCredential.objects.filter(tenant=tenant, enabled=True,
                                             kind__in=self.kinds)
        if self.user is not None:
            qs = rbac.restrict_queryset(qs, self.user, tenant, "sharedcredential", "view")
        self._sets: list[_Set] = []
        rows = list(qs.prefetch_related("roles", "device_types", "platforms", "sites",
                                        "tags"))
        for row in rows:
            ids = {dim: {o.pk for o in getattr(row, dim).all()}
                   for dim, _attr, _vm in DIMENSIONS}
            ids["tags"] = {t.pk for t in row.tags.all()}
            spec = sum(1 for v in ids.values() if v)
            self._sets.append(_Set(row, ids, spec))
        self._sets.sort(key=lambda s: (s.row.weight, -s.specificity, s.row.name.lower(),
                                       str(s.row.pk)))
        self.pinned = None
        if pinned is not None and pinned.tenant_id == tenant.pk and pinned.enabled \
                and pinned.kind in self.kinds:
            visible = [s.row for s in self._sets if s.row.pk == pinned.pk]
            self.pinned = visible[0] if visible else (pinned if self.user is None else None)
        self._own: dict = {}

    # ── host credentials ────────────────────────────────────────────────────

    def load_hosts(self, hosts) -> None:
        """Prime the host credentials of ``hosts`` (``[(kind, host)]``)."""
        from django.db.models import Q

        from auth_api import rbac

        from .models import DeviceCredential

        dev_ids = [h.pk for k, h in hosts if k == "device"]
        vm_ids = [h.pk for k, h in hosts if k == "virtual_machine"]
        qs = DeviceCredential.objects.filter(tenant=self.tenant, kind__in=self.kinds).filter(
            Q(device_id__in=dev_ids) | Q(virtual_machine_id__in=vm_ids))
        if self.user is not None:
            qs = rbac.restrict_queryset(qs, self.user, self.tenant, "devicecredential", "view")
        for c in qs.order_by("name", "pk"):
            key = ("device", c.device_id) if c.device_id else ("virtual_machine",
                                                               c.virtual_machine_id)
            best = self._own.get(key)
            if best is None or self.kinds.index(c.kind) < self.kinds.index(best.kind):
                self._own[key] = c

    # ── shared credentials ──────────────────────────────────────────────────

    @staticmethod
    def _tag_ids(host) -> set:
        try:
            return {t.pk for t in host.tags.all()}
        except Exception:  # noqa: BLE001 - a host without tags matches no tag scope
            return set()

    def matches(self, s: _Set, kind: str, host, tag_ids=None) -> bool:
        row = s.row
        if kind == "device" and not row.applies_to_devices:
            return False
        if kind == "virtual_machine" and not row.applies_to_vms:
            return False
        if not s.specificity:
            return bool(row.all_hosts)
        for dim, attr, on_vm in DIMENSIONS:
            wanted = s.ids[dim]
            if not wanted:
                continue
            if kind == "virtual_machine" and not on_vm:
                return False
            if getattr(host, attr, None) not in wanted:
                return False
        if s.ids["tags"]:
            tags = self._tag_ids(host) if tag_ids is None else tag_ids
            if not tags & s.ids["tags"]:
                return False
        return True

    def shared_for(self, host) -> list:
        kind = _host_kind(host)
        tags = self._tag_ids(host) if any(s.ids["tags"] for s in self._sets) else set()
        return [s.row for s in self._sets if self.matches(s, kind, host, tags)]

    # ── the answer ──────────────────────────────────────────────────────────

    def logins(self, host) -> list[Login]:
        """Every credential that may be tried for ``host``, in order."""
        kind = _host_kind(host)
        out: list[Login] = []
        own = self._own.get((kind, host.pk))
        if own is not None:
            out.append(Login(own, "host"))
        seen = set()
        if self.pinned is not None:
            out.append(Login(self.pinned, f"shared: {self.pinned.name}"))
            seen.add(self.pinned.pk)
        for row in self.shared_for(host):
            if row.pk not in seen:
                out.append(Login(row, f"shared: {row.name}"))
                seen.add(row.pk)
        return out


def attempts(logins: list[Login]) -> list[Login]:
    """The logins actually tried, in order: the first, and the next only
    while the one before it may fall through. At most :data:`MAX_TRIES`.
    The consumer stops at the first that is not refused."""
    out: list[Login] = []
    for login in logins[:MAX_TRIES]:
        out.append(login)
        if not login.fall_through:
            break
    return out


def matching_hosts(shared):
    """Devices and VMs of the set's tenant its scope matches (the "Matches N
    hosts" preview). Returns ``(devices_qs, vms_qs)``."""
    ids = {dim: list(getattr(shared, dim).values_list("pk", flat=True))
           for dim, _a, _v in DIMENSIONS}
    ids["tags"] = list(shared.tags.values_list("pk", flat=True))
    return matching_hosts_for(shared, ids)


def matching_hosts_for(shared, ids: dict):
    """:func:`matching_hosts` for a scope given as ``{dimension: [ids]}``
    (an unsaved set: the create dialog's preview). Same rule as
    :meth:`CredentialResolver.matches`."""
    from django.db.models import Q

    from api.models import Device, VirtualMachine

    tenant = shared.tenant
    tags = list(ids.get("tags") or [])
    ids = {dim: list(ids.get(dim) or []) for dim, _a, _v in DIMENSIONS}
    empty = not any(ids.values()) and not tags

    def build(model, kind):
        qs = model.objects.filter(tenant=tenant)
        if (kind == "device" and not shared.applies_to_devices) or \
                (kind == "virtual_machine" and not shared.applies_to_vms):
            return qs.none()
        if empty:
            return qs if shared.all_hosts else qs.none()
        q = Q()
        for dim, attr, on_vm in DIMENSIONS:
            if not ids[dim]:
                continue
            if kind == "virtual_machine" and not on_vm:
                return qs.none()
            q &= Q(**{f"{attr}__in": ids[dim]})
        qs = qs.filter(q)
        if tags:
            qs = qs.filter(tags__in=tags).distinct()
        return qs

    return build(Device, "device"), build(VirtualMachine, "virtual_machine")
