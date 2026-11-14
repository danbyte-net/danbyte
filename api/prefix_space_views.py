"""The prefix endpoints for free space (api.prefix_space), mixed into
PrefixViewSet:

* ``GET /api/prefixes/?free=1`` - the list, plus ``free`` rows for the
  parents on the page (``length``, ``scope``, ``strategy``, ``limit``);
* ``GET /api/prefixes/available/`` - free blocks inside one parent or across
  every parent the reader may view;
* ``POST /api/prefixes/<id>/allocate/`` - create the next free child;
* ``POST /api/prefixes/<id>/plan/`` - place a set of subnets, dry run first.

Who may see what: free rows and blocks appear only under prefixes the reader
may view. The gaps themselves are computed against every prefix of the
tenant and VRF (prefix_space.load_spaces), so space a hidden prefix takes is
never offered and never named. Creating needs ``add`` on prefixes; the new
prefix goes through the normal serializer, ``perform_create`` and the
site-scope check, inside a transaction that holds a row lock on the parent
and every prefix above it.
"""

from __future__ import annotations

import heapq
from types import SimpleNamespace

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import BooleanField
from django.db.models.expressions import RawSQL
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from . import prefix_space as fs
from .models import Prefix

_TRUE = ("1", "true", "yes", "on")
#: Body keys of allocate that are not prefix fields.
_ALLOCATE_KEYS = ("length", "scope", "strategy")


def lock_holders(tenant_id, vrf_id, cidr) -> None:
    """Row locks on every prefix of ``tenant_id`` and ``vrf_id`` holding
    ``cidr`` (itself included), outermost first. The allocation lock:
    allocate, plan and a manual create (PrefixViewSet.create) all take it,
    so none of them can place a block another is placing. Same order
    everywhere, so they queue rather than deadlock."""
    list(
        Prefix.objects.select_for_update()
        .filter(tenant_id=tenant_id)
        .filter(fs._vrf_q({vrf_id}))
        .annotate(
            _fs_holds=RawSQL('"api_prefix"."cidr"::inet >>= %s::inet', (str(cidr),),
                             output_field=BooleanField()),
            _fs_net=RawSQL('"api_prefix"."cidr"::inet', ()),
        )
        .filter(_fs_holds=True)
        .order_by("_fs_net")
        .values_list("pk", flat=True)
    )


def _truthy(raw) -> bool:
    if isinstance(raw, bool):
        return raw
    return str(raw or "").strip().lower() in _TRUE


def _refuse(exc: fs.SpaceError):
    if exc.status == 403:
        raise PermissionDenied(exc.message) from None
    if exc.status == 409:
        return Response({exc.field_name: [exc.message]}, status=409)
    raise ValidationError({exc.field_name: [exc.message]}) from None


class PrefixSpaceMixin:
    """Free space on PrefixViewSet. See the module docstring."""

    space_rbac_actions = {"available": "view", "allocate": "add", "plan": "add"}

    # ── helpers ─────────────────────────────────────────────────────────

    def _space_viewable(self, qs):
        from auth_api import rbac

        from .views import _get_active_tenant

        return rbac.restrict_queryset(
            qs, self.request.user, _get_active_tenant(self.request), "prefix", "view")

    def _space_parent(self):
        """The detail prefix, which the reader must be able to view: ``add``
        does not narrow the queryset, so it is checked here (a 404, as for
        any prefix the reader cannot see)."""
        parent = self.get_object()
        if not self._space_viewable(Prefix.objects.filter(pk=parent.pk)).exists():
            raise NotFound()
        return Prefix.objects.select_related("status").get(pk=parent.pk)

    def _space_lock(self, parent):
        """Row locks on the parent and every prefix holding it, outermost
        first, so allocations in nested parents queue behind each other."""
        lock_holders(parent.tenant_id, parent.vrf_id, parent.cidr)

    def _space_blockers(self, parent, targets) -> list[str]:
        """What a site-limited caller may not create: ``targets`` are
        ``(cidr, site_id)``. A new block is free, so the prefixes it
        overlaps are the parent and those above it; every one must belong
        to the caller's sites, as for any new prefix. Nothing is named but
        the parent, which the caller can see."""
        from auth_api import rbac

        from .views import _get_active_tenant

        user = self.request.user
        if getattr(user, "is_superuser", False):
            return []
        tenant = _get_active_tenant(self.request)
        sites = rbac.site_scope(user, tenant, "prefix", "add")
        if sites is None:
            return []
        out = []
        holders = (
            Prefix.objects.filter(tenant_id=parent.tenant_id)
            .filter(fs._vrf_q({parent.vrf_id}))
            .annotate(_fs_holds=RawSQL('"api_prefix"."cidr"::inet >>= %s::inet',
                                       (parent.cidr,), output_field=BooleanField()))
            .filter(_fs_holds=True)
            .values_list("site_id", flat=True)
        )
        if any(s not in sites for s in holders):
            out.append(f"prefixes in {parent.cidr}: it is not your site's space")
        default = next(iter(sites)) if len(sites) == 1 else None
        for cidr, site_id in targets:
            site = site_id or default
            if site is None or str(site) not in {str(s) for s in sites}:
                out.append(f"{cidr} outside your sites")
        return out

    def _space_create(self, data):
        """One new prefix through the normal create path."""
        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        self._assert_write_in_site_scope(
            SimpleNamespace(data={"id": str(serializer.instance.pk)}), "add")
        return serializer

    @staticmethod
    def _space_fields(parent, cidr, fields) -> dict:
        data = {**fields, "cidr": cidr,
                "vrf_id": str(parent.vrf_id) if parent.vrf_id else None}
        if "site_id" not in fields and parent.site_id:
            data["site_id"] = str(parent.site_id)
        return data

    # ── the list ────────────────────────────────────────────────────────

    def list(self, request, *args, **kwargs):
        params = request.query_params
        want = _truthy(params.get("free"))
        if want:
            try:
                length = fs.parse_length(params.get("length"), required=False)
                scope = fs.parse_network(params["scope"]) if params.get("scope") else None
                strategy = fs.parse_strategy(params.get("strategy"))
                limit = fs.parse_limit(
                    params.get("limit"), fs.LIST_LIMIT if length is None else fs.SIZE_LIMIT)
            except fs.SpaceError as exc:
                return _refuse(exc)
        response = super().list(request, *args, **kwargs)
        if not want or not isinstance(response.data, dict):
            return response
        page = getattr(self.paginator, "page", None)
        rows = list(page.object_list) if page is not None else []
        free, totals = [], {}
        if rows:
            tenant_id = rows[0].tenant_id
            for pk, space in fs.load_spaces(tenant_id, rows, scope).items():
                if not space.occupied and not fs.is_container(space.parent):
                    continue  # a leaf: its own space is not "free space"
                blocks, total = fs.space_rows(space, length, strategy, limit)
                if total:
                    free.extend(blocks)
                    totals[str(pk)] = total
        response.data["free"] = free
        response.data["free_totals"] = totals
        return response

    # ── available ───────────────────────────────────────────────────────

    @action(detail=False, methods=["get"], url_path="available")
    def available(self, request):
        """Free blocks: of ``length`` (lowest first, or ``strategy=best``),
        or the largest aligned ones without it, inside ``within`` (a prefix
        id or CIDR) or every parent the reader may view, clipped to
        ``scope``. ``vrf`` and ``site`` narrow the parents."""
        params = request.query_params
        tenant = self._tenant_or_403()
        try:
            within = (params.get("within") or "").strip()
            scope = fs.parse_network(params["scope"]) if params.get("scope") else None
            strategy = fs.parse_strategy(params.get("strategy"))
            length = fs.parse_length(params.get("length"), required=False)
            limit = fs.parse_limit(params.get("limit"), fs.SIZE_LIMIT)
            vrf = (params.get("vrf") or "").strip()
            site = (params.get("site") or "").strip()
            base = Prefix.objects.filter(tenant=tenant).select_related("status", "vrf")
            if vrf:
                base = base.filter(vrf__isnull=True) if vrf in ("global", "null") else (
                    base.filter(vrf_id=vrf))
            if site:
                base = base.filter(site_id=site)
            if within:
                parent = self._space_within(base, within, vrf)
                fs.check_scope(parent, scope)
                parents = [parent]
            else:
                qs = self._space_viewable(base)
                if scope is not None:
                    qs = qs.annotate(_fs_ov=RawSQL(
                        '"api_prefix"."cidr"::inet && %s::inet', (str(scope),),
                        output_field=BooleanField(),
                    )).filter(_fs_ov=True)
                parents = list(qs)
            spaces = fs.load_spaces(tenant.id, parents, scope)
            if within:
                space = spaces.get(parents[0].pk)
                if space is not None and length is not None:
                    fs.check_length(space, length)
            else:
                spaces = {
                    pk: s for pk, s in spaces.items()
                    if s.occupied or fs.is_container(s.parent)
                }
        except DjangoValidationError:
            raise ValidationError({"detail": ["vrf and site take an id."]}) from None
        except fs.SpaceError as exc:
            return _refuse(exc)

        def ranked(space):
            if length is None:
                for addr, ln in space.blocks():
                    yield (space.version, addr), space, addr, ln
                return
            if length < space.root_len or length > space.width:
                return
            if strategy == "first":
                for addr in space.candidates(length, "first"):
                    yield (space.version, addr), space, addr, length
                return
            free = space.free(length)
            pieces = sorted(
                (-ln, a) for s, e in free for a, ln in fs.aligned_blocks(s, e, space.width)
                if ln <= length
            )
            for neg, a in pieces:
                end = a + (1 << (space.width - -neg)) - 1
                for addr in fs.sized_blocks(a, end, space.width, length):
                    yield (neg, space.version, addr), space, addr, length

        out = []
        streams = [ranked(s) for s in spaces.values()]
        for _key, space, addr, ln in heapq.merge(*streams, key=lambda r: r[0]):
            p = space.parent
            out.append({
                "cidr": fs.cidr_of(addr, ln, space.version),
                "prefixlen": ln,
                "family": space.version,
                "parent": {"id": str(p.pk), "cidr": p.cidr},
                "vrf": {"id": str(p.vrf_id), "name": p.vrf.name} if p.vrf_id else None,
            })
            if len(out) >= limit:
                break
        return Response(out)

    def _space_within(self, base, within, vrf):
        """``within`` as one prefix the reader may view: its id, or its CIDR
        in ``vrf`` (the global table when no VRF is given)."""
        import uuid

        try:
            uuid.UUID(within)
            qs = base.filter(pk=within)
        except ValueError:
            net = fs.parse_network(within, field_name="within")
            qs = base.filter(cidr=str(net))
            if not vrf:
                qs = qs.filter(vrf__isnull=True)
        parent = self._space_viewable(qs).first()
        if parent is None:
            raise fs.SpaceError("No such prefix.", field_name="within")
        return parent

    # ── allocate ────────────────────────────────────────────────────────

    @action(detail=True, methods=["post"], url_path="allocate")
    def allocate(self, request, pk=None):
        """Create the next free child of ``length`` (inside ``scope``, by
        ``strategy``) with the other body keys as its fields. Two callers
        never get the same block: the parent's row is locked."""
        parent = self._space_parent()
        body = request.data if isinstance(request.data, dict) else {}
        for key in ("cidr", "vrf_id"):
            if key in body:
                raise ValidationError({key: ["Chosen by the allocation."]})
        try:
            length = fs.parse_length(body.get("length"), parent.family)
            scope = fs.parse_network(body["scope"]) if body.get("scope") else None
            fs.check_scope(parent, scope)
            strategy = fs.parse_strategy(body.get("strategy"))
        except fs.SpaceError as exc:
            return _refuse(exc)
        fields = {k: v for k, v in body.items() if k not in _ALLOCATE_KEYS}
        from audit import context as audit_context

        try:
            with transaction.atomic():
                self._space_lock(parent)
                space = fs.load_spaces(parent.tenant_id, [parent], scope)[parent.pk]
                fs.check_length(space, length)
                addr = next(iter(space.candidates(length, strategy)), None)
                if addr is None:
                    raise fs.SpaceError(fs.no_room(space, length), status=409)
                cidr = fs.cidr_of(addr, length, space.version)
                with audit_context.cause(f"Allocated in {parent.cidr}"):
                    serializer = self._space_create(self._space_fields(parent, cidr, fields))
        except fs.SpaceError as exc:
            return _refuse(exc)
        return Response(serializer.data, status=201)

    # ── plan ────────────────────────────────────────────────────────────

    @action(detail=True, methods=["post"], url_path="plan")
    def plan(self, request, pk=None):
        """Place ``requests`` (count × length, with optional fields) inside
        this prefix: largest first, aligned, by ``strategy``, optionally
        holding the next block of each size free (``reserve_growth``).
        ``dry_run`` (default true) returns the placement; false creates it
        in one transaction, all or nothing, each change logged with the
        cause "Planned in <parent>". ``cidrs``, the dry run's answer, makes
        the apply refuse (409) when the space changed in between."""
        parent = self._space_parent()
        body = request.data if isinstance(request.data, dict) else {}
        dry_run = body.get("dry_run", True)
        dry_run = dry_run if isinstance(dry_run, bool) else str(dry_run).lower() not in (
            "false", "0", "no")
        try:
            scope = fs.parse_network(body["scope"]) if body.get("scope") else None
            fs.check_scope(parent, scope)
            strategy = fs.parse_strategy(body.get("strategy"))
            requests = fs.plan_requests(body.get("requests"))
            width = 32 if parent.family == 4 else 128
            for i, r in enumerate(requests):
                if r["length"] > width:
                    raise fs.SpaceError(
                        f"Row {i + 1}: an IPv{parent.family} prefix length is at most {width}.",
                        field_name="requests")
        except fs.SpaceError as exc:
            return _refuse(exc)
        growth = _truthy(body.get("reserve_growth"))

        def place():
            space = fs.load_spaces(parent.tenant_id, [parent], scope)[parent.pk]
            items, reserved = fs.plan(space, requests, strategy, growth)
            return space, items, reserved

        def blockers(items):
            return self._space_blockers(parent, [
                (it.cidr, it.fields.get("site_id") or parent.site_id)
                for it in items if it.cidr
            ])

        if dry_run:
            space, items, reserved = place()
            blocked = blockers(items)
            if blocked:
                raise PermissionDenied("You can't create " + "; ".join(blocked) + ".")
            return Response(fs.describe_plan(space, items, reserved, strategy=strategy,
                                             dry_run=True))

        from audit import context as audit_context

        expected = body.get("cidrs")
        created = []
        try:
            with transaction.atomic():
                self._space_lock(parent)
                space, items, reserved = place()
                misses = [it for it in items if not it.cidr]
                if misses:
                    raise fs.SpaceError(
                        "Not everything fits: " + misses[0].reason, field_name="requests")
                if isinstance(expected, list) and expected != [it.cidr for it in items]:
                    raise fs.SpaceError(
                        "The free space changed since the preview; preview again.",
                        status=409, field_name="requests")
                blocked = blockers(items)
                if blocked:
                    raise fs.SpaceError(
                        "You can't create " + "; ".join(blocked) + ".", status=403)
                with audit_context.cause(f"Planned in {parent.cidr}"):
                    for it in items:
                        try:
                            ser = self._space_create(
                                self._space_fields(parent, it.cidr, it.fields))
                        except ValidationError as exc:
                            raise ValidationError(
                                {"requests": [f"{it.cidr}: {_flat(exc.detail)}"]}) from None
                        created.append({"id": str(ser.instance.pk), "cidr": it.cidr})
        except fs.SpaceError as exc:
            return _refuse(exc)
        return Response(fs.describe_plan(space, items, reserved, strategy=strategy,
                                         dry_run=False, applied=True, created=created))


def _flat(detail) -> str:
    if isinstance(detail, dict):
        return "; ".join(f"{k}: {_flat(v)}" for k, v in detail.items())
    if isinstance(detail, list):
        return " ".join(_flat(v) for v in detail)
    return str(detail)
