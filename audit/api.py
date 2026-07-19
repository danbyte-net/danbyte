"""Read-only change-log API for the SPA (tenant-scoped, filterable)."""
from __future__ import annotations

from django.apps import apps as django_apps
from django.core.exceptions import FieldError
from django.db.models import CharField, Q
from django.db.models.functions import Cast
from rest_framework import serializers, viewsets
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated

from api.viewsets import StandardPagination
from api.views import _get_active_tenant

from .models import ChangeLogEntry, JournalEntry


def _viewable_types(request):
    """The set of object-type labels (``app.model`` lower — matching the stored
    ``object_type``) the caller may ``view``, or ``None`` for "all" (superuser).
    Built-in groups hold the ``*`` wildcard so their effective_actions expands
    to every registered slug; a narrow custom role sees only its granted types.
    Keeps audit/journal history from leaking changes on objects the caller
    can't otherwise view."""
    from auth_api import rbac
    from auth_api.object_types import model_for

    user = request.user
    if getattr(user, "is_superuser", False):
        return None
    tenant = _get_active_tenant(request)
    acts = rbac.effective_actions(user, tenant)
    labels = set()
    for slug, actions in acts.items():
        if "view" not in actions:
            continue
        model = model_for(slug)  # RBAC slug (model_name) → model
        if model is not None:
            labels.add(model._meta.label_lower)  # e.g. "api.prefix"
    return labels


def _can_view_object(request, object_type_label, object_id) -> bool:
    """True if the caller may *view* the specific (object_type, object_id) —
    row/site-scoped, not just type-level. Resolves the stored ``app.model``
    label to its model and runs the exact row through restrict_queryset, so a
    Site-A-scoped user can't read a Site-B object's history/notes or attach a
    journal note to it.

    Fail **closed**: superuser → allowed; a non-model type, an unregistered
    slug, or an object that no longer exists → denied (you can't attach a note
    to something the RBAC engine can't vouch for). Reading *history* of a
    deleted object is handled separately by the stored ``object_site_id`` — this
    guard is for "act on the live object" (journal create)."""
    from auth_api import rbac
    from auth_api.object_types import is_registered

    if not object_type_label or object_id is None:
        return False
    try:
        model = django_apps.get_model(object_type_label)
    except (LookupError, ValueError):
        return False  # non-model type — can't verify → deny
    slug = model._meta.model_name
    if not is_registered(slug):
        return False  # not under RBAC → deny
    tenant = _get_active_tenant(request)

    # Tenant is a deployment-global model, but its audit/journal surface belongs
    # to the active tenant. Requiring a switch before targeting another Tenant
    # keeps tenant-less generic references from becoming a cross-tenant IDOR.
    if model._meta.label_lower == "core.tenant":
        if tenant is None or str(object_id) != str(tenant.pk):
            return False
        base = model._default_manager.filter(pk=tenant.pk)
        if getattr(request.user, "is_superuser", False):
            return base.exists()
    elif getattr(request.user, "is_superuser", False):
        return True
    else:
        base = model._default_manager.all()

    if any(f.name == "tenant" for f in model._meta.fields):
        base = base.filter(tenant=tenant)
    scoped = rbac.restrict_queryset(base, request.user, tenant, slug, "view")
    return scoped.filter(pk=object_id).exists()


def _object_site_id(object_type_label, object_id):
    """Best-effort Site pk for a live ``(label, id)`` target, for stamping a new
    journal note's ``object_site_id``. None when the type has no site, the row is
    gone, or the label doesn't resolve to a model."""
    from .site_capture import entry_site_id

    try:
        model = django_apps.get_model(object_type_label)
    except (LookupError, ValueError):
        return None
    obj = model._default_manager.filter(pk=object_id).first()
    return entry_site_id(obj) if obj is not None else None


def _visibility_q(request):
    """A ``Q`` selecting only the audit rows the caller may view — row/site
    aware via the stored ``object_site_id`` (so it still works after the object
    is deleted, unlike re-fetching the object). Returns ``Q(pk__in=[])`` when
    the caller may view nothing. Superusers remain unrestricted except that
    global Tenant history is clamped to the active tenant.

    Each granting permission contributes its own branch: arbitrary constraints
    and that permission's site scope are ANDed, then branches are ORed. This is
    the same composition as ``rbac.restrict_queryset``. Deleted rows remain
    readable through unconstrained grants because their stored site survives;
    constrained grants fail closed once the live object is gone."""
    from auth_api import rbac
    from auth_api.object_types import model_for
    from auth_api.site_paths import site_path_for

    user = request.user
    tenant = _get_active_tenant(request)
    if getattr(user, "is_superuser", False):
        # Even superusers operate inside an active tenant. Global Tenant rows
        # have tenant_id=NULL, so clamp that type explicitly while leaving the
        # normal superuser bypass intact for every other type.
        part = ~Q(object_type="core.tenant")
        if tenant is not None:
            part |= Q(object_type="core.tenant", object_id=str(tenant.pk))
        return part
    if tenant is None:
        return Q(pk__in=[])

    acts = rbac.effective_actions(user, tenant)
    applicable = list(rbac.applicable_permissions(user, tenant))
    q = Q()
    matched = False
    for slug, actions in acts.items():
        if "view" not in actions:
            continue
        model = model_for(slug)
        if model is None:
            continue
        label = model._meta.label_lower
        site_path = site_path_for(slug, tenant)
        granting = [
            permission
            for permission in applicable
            if "view" in (permission.actions or [])
            and (
                slug in (permission.object_types or [])
                or "*" in (permission.object_types or [])
            )
        ]

        for permission in granting:
            if permission.constraints:
                base = model._default_manager.all()
                if label == "core.tenant":
                    base = base.filter(pk=tenant.pk)
                elif any(f.name == "tenant" for f in model._meta.fields):
                    base = base.filter(tenant=tenant)
                try:
                    # Reuse RBAC's single-grant primitive so constraints and this
                    # permission's sites stay in the same AND branch.
                    row_q = rbac._perm_q(permission, site_path, "view")
                    live_ids = (
                        base.filter(row_q)
                        .order_by()
                        .annotate(
                            audit_object_id=Cast("pk", output_field=CharField())
                        )
                        .values("audit_object_id")
                    )
                except (FieldError, TypeError, ValueError):
                    continue
                part = Q(object_type=label, object_id__in=live_ids)
            else:
                site_ids = {site.pk for site in permission.sites.all()}
                if site_path and site_ids:
                    scope_q = Q(object_site_id__in=site_ids)
                    if site_path != "id":
                        scope_q |= Q(object_site_id__isnull=True)
                    part = Q(object_type=label) & scope_q
                else:
                    part = Q(object_type=label)

            if label == "core.tenant":
                part &= Q(object_id=str(tenant.pk))
            q |= part
            matched = True
    return q if matched else Q(pk__in=[])


def _relation_fields(model_label: str) -> dict:
    """Map {field_name: related_model} for the FK fields of a model, so the
    changelog can turn a stored UUID into a human label. Returns {} for an
    unknown / non-model object_type."""
    try:
        model = django_apps.get_model(model_label)
    except (LookupError, ValueError):
        return {}
    out = {}
    for f in model._meta.concrete_fields:
        if f.is_relation and f.many_to_one:
            out[f.name] = f.related_model
    return out


def _label_for(model, pk):
    """str() of the related row, or None if it can't be resolved (deleted)."""
    if pk in (None, ""):
        return None
    obj = model.objects.filter(pk=pk).first()
    return str(obj)[:120] if obj is not None else None


class ChangeLogSerializer(serializers.ModelSerializer):
    action_display = serializers.CharField(source="get_action_display", read_only=True)
    change_count = serializers.SerializerMethodField()
    changes = serializers.SerializerMethodField()

    class Meta:
        model = ChangeLogEntry
        fields = [
            "id", "timestamp", "user_name", "action", "action_display",
            "object_type", "object_label", "object_id", "object_repr",
            "changes", "change_count", "request_id",
        ]

    def get_change_count(self, obj) -> int:
        return len(obj.changes or {})

    def get_changes(self, obj) -> dict:
        """Enrich FK fields with a resolved label so the UI can show the VLAN /
        site / role name next to its UUID. Non-relation fields pass through."""
        raw = obj.changes or {}
        rels = _relation_fields(obj.object_type)
        if not rels:
            return raw
        out = {}
        for field, diff in raw.items():
            related = rels.get(field)
            if related is None or not isinstance(diff, dict):
                out[field] = diff
                continue
            enriched = dict(diff)
            old_label = _label_for(related, diff.get("old"))
            new_label = _label_for(related, diff.get("new"))
            if old_label is not None:
                enriched["old_label"] = old_label
            if new_label is not None:
                enriched["new_label"] = new_label
            out[field] = enriched
        return out


class ChangeLogDetailSerializer(ChangeLogSerializer):
    """Detail adds the full pre/post snapshots (kept off the list payload —
    they're whole-row dumps and the list can run hundreds of entries)."""

    related_labels = serializers.SerializerMethodField()

    class Meta(ChangeLogSerializer.Meta):
        fields = ChangeLogSerializer.Meta.fields + [
            "pre_change", "post_change", "related_labels",
        ]

    def get_related_labels(self, obj) -> dict:
        """Flat ``{uuid: human label}`` for every resolvable FK value anywhere
        in this entry — the compact diff *and* both full snapshots. A UUID is
        globally unique, so one map lets the UI swap in the site / device /
        interface name wherever that UUID appears, without caring which field
        or snapshot it came from. Unresolvable ids (deleted rows) are omitted;
        the UI falls back to the raw UUID for those."""
        rels = _relation_fields(obj.object_type)
        if not rels:
            return {}
        labels: dict[str, str] = {}
        snaps = (obj.pre_change or {}, obj.post_change or {})
        changes = obj.changes or {}
        for field, model in rels.items():
            values = set()
            for snap in snaps:
                v = snap.get(field)
                if v not in (None, ""):
                    values.add(v)
            diff = changes.get(field)
            if isinstance(diff, dict):
                for key in ("old", "new"):
                    if diff.get(key) not in (None, ""):
                        values.add(diff[key])
            for v in values:
                key = str(v)
                if key in labels:
                    continue
                label = _label_for(model, v)
                if label is not None:
                    labels[key] = label
        return labels


class ChangeLogViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = ChangeLogEntry.objects.select_related("user").all()
    serializer_class = ChangeLogSerializer
    permission_classes = [IsAuthenticated]
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "retrieve":
            return ChangeLogDetailSerializer
        return ChangeLogSerializer

    def get_queryset(self):
        # One row/site visibility gate for every branch, driven by the stored
        # object_site_id — so it holds even for DELETE entries whose object is
        # gone (re-fetching the object, as before, made deleted-object history
        # unreadable and leaked cross-site rows the type filter let through).
        vis = _visibility_q(self.request)
        tenant = _get_active_tenant(self.request)

        # Detail: one entry by id, within the active tenant (+ tenant-less
        # entries for global models) so a foreign entry UUID can't be read by IDOR.
        if self.action == "retrieve":
            qs = self.queryset.filter(Q(tenant=tenant) | Q(tenant__isnull=True))
            return qs.filter(vis) if vis is not None else qs

        p = self.request.query_params
        object_id = p.get("object_id")

        # Per-object history (a detail-page History tab): scope to that object,
        # within the active tenant (+ tenant-less global models).
        if object_id:
            qs = self.queryset.filter(object_id=object_id).filter(
                Q(tenant=tenant) | Q(tenant__isnull=True)
            )
            otype = p.get("object_type")
            if otype:
                qs = qs.filter(object_type=otype)
            return qs.filter(vis) if vis is not None else qs

        # Global list: tenant-scoped.
        qs = self.queryset.filter(tenant=tenant) if tenant else self.queryset.none()
        for key in ("action", "object_type"):
            v = p.get(key)
            if v:
                qs = qs.filter(**{key: v})
        user = p.get("user")
        if user:
            qs = qs.filter(user_name__icontains=user)
        search = p.get("search")
        if search:
            qs = qs.filter(object_repr__icontains=search)
        return qs.filter(vis) if vis is not None else qs


class JournalEntrySerializer(serializers.ModelSerializer):
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    can_edit = serializers.SerializerMethodField()

    class Meta:
        model = JournalEntry
        fields = [
            "id", "object_type", "object_id", "kind", "kind_display",
            "comments", "author_name", "created_at", "updated_at", "can_edit",
        ]
        read_only_fields = ["id", "author_name", "created_at", "updated_at"]

    def get_can_edit(self, obj) -> bool:
        user = getattr(self.context.get("request"), "user", None)
        return bool(user and (obj.created_by_id == user.id or user.is_superuser))


class JournalEntryViewSet(viewsets.ModelViewSet):
    """Per-object journal notes. List is scoped to one object via
    ?object_type=&object_id= (the detail-page Journal tab); a tenant-wide list
    otherwise. Authors (or superusers) may edit/delete their own notes."""

    serializer_class = JournalEntrySerializer
    permission_classes = [IsAuthenticated]
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = JournalEntry.objects.select_related("created_by")
        p = self.request.query_params
        otype, oid = p.get("object_type"), p.get("object_id")
        tenant = _get_active_tenant(self.request)
        # Row/site visibility via the stored object_site_id — consistent with the
        # change log, and (unlike re-fetching the object) it doesn't leak
        # cross-site notes the type filter would let through.
        vis = _visibility_q(self.request)
        if otype and oid:
            # Scope to the active tenant (+ tenant-less global models) so a
            # foreign object UUID can't leak its notes by IDOR.
            out = qs.filter(object_type=otype, object_id=oid).filter(
                Q(tenant=tenant) | Q(tenant__isnull=True)
            )
            return out.filter(vis) if vis is not None else out
        out = qs.filter(tenant=tenant) if tenant else qs.none()
        return out.filter(vis) if vis is not None else out

    def perform_create(self, serializer):
        # A journal note may only be attached to an object the caller can view
        # (row/site-scoped) — otherwise object_type+object_id are attacker-set.
        otype = serializer.validated_data.get("object_type")
        oid = serializer.validated_data.get("object_id")
        if not _can_view_object(self.request, otype, oid):
            raise PermissionDenied(
                "You can't add a note to an object you can't view."
            )
        user = self.request.user
        serializer.save(
            tenant=_get_active_tenant(self.request),
            created_by=user,
            author_name=user.get_username(),
            object_site_id=_object_site_id(otype, oid),
        )

    def _guard_owner(self, instance):
        user = self.request.user
        if not (instance.created_by_id == user.id or user.is_superuser):
            raise PermissionDenied("You can only edit your own journal entries.")

    def perform_update(self, serializer):
        self._guard_owner(serializer.instance)
        # A note is bound to the object it was created on — retargeting it
        # (changing object_type/object_id) would let an owner move a note onto
        # an object they can't view, bypassing the create-time gate. Reject any
        # such change rather than re-authorizing a new target.
        inst = serializer.instance
        new_type = serializer.validated_data.get("object_type", inst.object_type)
        new_id = serializer.validated_data.get("object_id", inst.object_id)
        if str(new_type) != str(inst.object_type) or str(new_id) != str(inst.object_id):
            raise PermissionDenied("A journal note can't be moved to another object.")
        serializer.save()

    def perform_destroy(self, instance):
        self._guard_owner(instance)
        instance.delete()
