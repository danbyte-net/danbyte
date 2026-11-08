"""Read-only change-log API for the SPA (tenant-scoped, filterable)."""
from __future__ import annotations

from django.apps import apps as django_apps
from django.core.exceptions import FieldError
from django.db.models import CharField, Q
from django.db.models.functions import Cast
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.views import _get_active_tenant
from api.viewsets import StandardPagination

from .models import ChangeLogEntry, JournalEntry


def _viewable_types(request):
    """The set of object-type labels (``app.model`` lower - matching the stored
    ``object_type``) the caller may ``view``, or ``None`` for "all" (superuser).
    Built-in groups hold the ``*`` wildcard so their effective_actions expands
    to every registered slug except users, groups and permissions (which only
    a grant naming them reaches); a narrow custom role sees only its granted
    types.
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


def _can_act_on_object(request, object_type_label, object_id, action="view") -> bool:
    """True if the caller may perform ``action`` on the specific
    (object_type, object_id) - row/site-scoped, not just type-level. Resolves
    the stored ``app.model`` label to its model and runs the exact row through
    restrict_queryset, so a Site-A-scoped user can't read a Site-B object's
    history/notes, attach a journal note to it, or apply a planned change to it.

    ``action`` is an RBAC verb: ``"view"`` for read-ish surfaces (journal notes,
    generic links), ``"change"`` before writing the target (planned-change
    apply). The verb is the only difference - the tenant clamp, the tenant-less
    site binding and the fail-closed rules are identical, which is exactly why
    they live in one function.

    Fail **closed**: superuser → allowed; a non-model type, an unregistered
    slug, or an object that no longer exists → denied (you can't act on
    something the RBAC engine can't vouch for). Reading *history* of a
    deleted object is handled separately by the stored ``object_site_id`` - this
    guard is for "act on the live object"."""
    from auth_api import rbac
    from auth_api.object_types import is_registered

    if not object_type_label or object_id is None:
        return False
    try:
        model = django_apps.get_model(object_type_label)
    except (LookupError, ValueError):
        return False  # non-model type - can't verify → deny
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
    else:
        # Tenant-less models (Interface, ports, Module, VMInterface, …) reach
        # their tenant only through their site path. Bind to the active tenant
        # there, or an unscoped grant's restrict_queryset would match another
        # tenant's row and let a note be attached to it.
        from auth_api.site_paths import site_path_for

        sp = site_path_for(slug, tenant)
        if sp and sp != "id":
            from auth_api.site_paths import site_tenant_q

            base = base.filter(site_tenant_q(sp, tenant))
    scoped = rbac.restrict_queryset(base, request.user, tenant, slug, action)
    return scoped.filter(pk=object_id).exists()


def _can_view_object(request, object_type_label, object_id) -> bool:
    """``_can_act_on_object`` with the ``view`` verb - the long-standing name,
    kept because four call sites and their tests read better this way."""
    return _can_act_on_object(request, object_type_label, object_id, "view")


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


def _tenant_gate(tenant):
    """Q selecting audit rows that belong to the active tenant - safe for
    tenant-LESS models (Interface, ports, Module, VMInterface, MAC, floor plans,
    component templates), which stamp tenant_id=NULL. Those are admitted only
    when their stored ``object_site_id`` is a Site in this tenant, so a foreign
    tenant's component history can't be read via the old blanket
    ``tenant__isnull=True`` branch. core.tenant (tenant-less, site-less) is
    admitted here and clamped to the active tenant by ``_visibility_q``;
    tenant-less rows with no resolvable site are NOT admitted (fail closed)."""
    if tenant is None:
        return Q(pk__in=[])
    from api.models import Site

    site_ids = list(
        Site.objects.filter(tenant=tenant).values_list("id", flat=True)
    )
    return (
        Q(tenant=tenant)
        | Q(tenant__isnull=True, object_site_id__in=site_ids)
        | Q(tenant__isnull=True, object_type="core.tenant")
    )


def _visibility_q(request):
    """A ``Q`` selecting only the audit rows the caller may view - row/site
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
    from auth_api.object_types import grant_covers, model_for
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
    site_ids_of = {}
    q = Q()
    matched = False
    # Types some grant shows in full: one ``object_type IN (...)`` for all of
    # them. Any other grant's branch for such a type selects a subset of it,
    # so it is left out instead of growing the OR per type and grant (#342).
    full_types = []
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
            and grant_covers(permission.object_types, slug)
        ]
        for permission in granting:
            if permission.pk not in site_ids_of:
                site_ids_of[permission.pk] = {site.pk for site in permission.sites.all()}

        if any(
            not permission.constraints and not (site_path and site_ids_of[permission.pk])
            for permission in granting
        ):
            # Tenant rows stay clamped to the active tenant.
            if label == "core.tenant":
                q |= Q(object_type=label, object_id=str(tenant.pk))
            else:
                full_types.append(label)
            matched = True
            continue

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
                site_ids = site_ids_of[permission.pk]
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
    if full_types:
        q |= Q(object_type__in=full_types)
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
        if f.is_relation and (f.many_to_one or f.one_to_one):
            out[f.name] = f.related_model
    return out


def _canonical_changes(model_label: str, changes: dict) -> dict:
    """``changes`` keyed by field name. Older bulk edits logged a
    relation under its column (``status_id``); show those as the field
    (``status``) so the label resolves like a single edit's."""
    try:
        model = django_apps.get_model(model_label)
    except (LookupError, ValueError):
        return changes
    attnames = {
        f.attname: f.name
        for f in model._meta.concrete_fields
        if f.is_relation and (f.many_to_one or f.one_to_one)
    }
    if not any(k in attnames for k in changes):
        return changes
    out = {}
    for k, v in changes.items():
        name = attnames.get(k, k)
        out[name if name not in changes else k] = v
    return out


#: Label-map value for a related row the caller may not view (#413): the
#: entry shows neither its name nor its id.
HIDDEN = object()


class _RelatedScope:
    """Which related rows a change-log reader may see named, for one page.
    A related row is shown (label and id) only when the caller may view it
    under that type's own row and site scope - the same answer the object's
    API gives (``rbac.ViewableRows``) - and it belongs to the active tenant.
    A row that is gone cannot be vouched for, so a scoped caller sees it
    hidden too. Superusers see everything."""

    def __init__(self, user, tenant):
        from auth_api import rbac

        self.tenant = tenant
        self.open = bool(getattr(user, "is_superuser", False))
        self.viewable = None if self.open else rbac.ViewableRows(user, tenant)

    def visible(self, model, pks) -> set:
        """The subset of ``pks`` (valid pks of ``model``) the caller may view.
        One query per call at most; none for an open or ungranted type."""
        if self.open or not pks:
            return set(pks)
        label = model._meta.label_lower
        if label == "core.tenant":
            # The active tenant is the caller's own context, not a secret.
            return {pk for pk in pks if self.tenant is not None and str(pk) == str(self.tenant.pk)}
        slug = model._meta.model_name
        self.viewable.prime(slug, pks)
        return {pk for pk in pks if self.viewable.may_view(slug, pk)}


def _resolve_labels(model, ids, scope=None) -> dict:
    """``{str(pk): label | None | HIDDEN}`` for ``ids`` of ``model``: one
    visibility query (scoped callers only) and one label query. A value that
    is not a pk of ``model`` references nothing and resolves to None."""
    from django.core.exceptions import ValidationError

    pk_field = model._meta.pk
    parsed: dict = {}
    for i in ids:
        try:
            parsed[i] = pk_field.to_python(i)
        except (ValidationError, ValueError, TypeError):
            continue
    out: dict = dict.fromkeys(ids)
    if not parsed:
        return out
    shown = set(parsed.values())
    if scope is not None:
        try:
            shown = scope.visible(model, shown)
        except Exception:  # noqa: BLE001 - can't vouch for the rows: hide them
            shown = set()
    found: dict = {}
    if shown:
        has_tenant = (
            scope is not None and not scope.open
            and any(f.name == "tenant" for f in model._meta.concrete_fields)
        )
        try:
            for obj in model.objects.filter(pk__in=shown):
                if has_tenant and obj.tenant_id not in (None, getattr(scope.tenant, "pk", None)):
                    continue  # another tenant's row is never named
                found[obj.pk] = str(obj)[:120]
        except Exception:  # noqa: BLE001 - stale label: nothing to resolve
            found = {}
    for raw, pk in parsed.items():
        if pk in found:
            out[raw] = found[pk]
        elif scope is not None and not scope.open:
            out[raw] = HIDDEN
    return out


def _label_for(model, pk, scope=None):
    """The label of one related row: str(), None if it can't be resolved
    (deleted, for an unrestricted caller), or ``HIDDEN``."""
    if pk in (None, ""):
        return None
    return _resolve_labels(model, [str(pk)], scope)[str(pk)]


def _valid_pks(model, ids) -> set:
    """The ids that parse as ``model``'s primary-key type. A stored diff can
    hold anything (a hand-written import, an older schema); one malformed
    value must cost only its own label, never the whole model's page (#199)."""
    from django.core.exceptions import ValidationError

    pk = model._meta.pk
    out = set()
    for i in ids:
        try:
            pk.to_python(i)
        except (ValidationError, ValueError, TypeError):
            continue
        out.add(i)
    return out


def _snapshot_relations(model_label: str) -> dict:
    """``{key: related_model}`` for the snapshot keys that hold a related
    pk - the field name, and the column name older rows may carry."""
    try:
        model = django_apps.get_model(model_label)
    except (LookupError, ValueError):
        return {}
    out = {}
    for f in model._meta.concrete_fields:
        if f.is_relation and (f.many_to_one or f.one_to_one):
            out[f.name] = f.related_model
            out[f.attname] = f.related_model
    return out


def _labels_for_rows(rows, scope=None, snapshots=False) -> dict:
    """``{(model_label, str(pk)): label | None | HIDDEN}`` for every FK value
    in the changes (and, with ``snapshots``, the pre/post snapshots) of
    ``rows`` - one ``pk__in`` query per related model for the whole page,
    instead of one query per changed relation per row (#190). With a
    ``scope``, a row the caller may not view resolves to ``HIDDEN`` (#413),
    at one more query per related model."""
    wanted: dict = {}
    for r in rows:
        rels = _relation_fields(r.object_type)
        if not rels:
            continue
        for field, diff in _canonical_changes(r.object_type, r.changes or {}).items():
            model = rels.get(field)
            if model is None or not isinstance(diff, dict):
                continue
            for pk in (diff.get("old"), diff.get("new")):
                if pk not in (None, ""):
                    wanted.setdefault(model, set()).add(str(pk))
        if snapshots:
            snap_rels = _snapshot_relations(r.object_type)
            for snap in (r.pre_change, r.post_change):
                if not isinstance(snap, dict):
                    continue
                for key, v in snap.items():
                    model = snap_rels.get(key)
                    if model is not None and v not in (None, ""):
                        wanted.setdefault(model, set()).add(str(v))
    out: dict = {}
    for model, ids in wanted.items():
        label = model._meta.label_lower
        for i, value in _resolve_labels(model, ids, scope).items():
            out[(label, i)] = value
    return out


class ChangeLogSerializer(serializers.ModelSerializer):
    action_display = serializers.CharField(source="get_action_display", read_only=True)
    change_count = serializers.SerializerMethodField()
    changes = serializers.SerializerMethodField()
    object_exists = serializers.SerializerMethodField()

    class Meta:
        model = ChangeLogEntry
        fields = [
            "id", "timestamp", "user_name", "action", "action_display",
            "object_type", "object_label", "object_id", "object_repr",
            "object_exists", "changes", "change_count", "request_id", "via",
            "cause",
        ]

    def get_change_count(self, obj) -> int:
        return len(obj.changes or {})

    def to_representation(self, obj):
        """A field the object's API hides from this caller (a contract's
        cost without view_cost) is left out of the diff and the snapshots."""
        from core.hidden_fields import hidden_history_fields, strip_history

        data = super().to_representation(obj)
        request = self.context.get("request")
        if request is None:
            return data
        memo = self.context.setdefault("_hidden_history", {})
        if "_tenant" not in memo:
            memo["_tenant"] = _get_active_tenant(request)
        hidden = hidden_history_fields(request.user, memo["_tenant"], obj.object_type, memo)
        if hidden:
            for key in ("changes", "pre_change", "post_change"):
                if key in data:
                    data[key] = strip_history(data[key], hidden)
            data["change_count"] = len(data.get("changes") or {})
        masker = self._name_masker(obj, memo)
        if masker is not None:
            data = masker.mask_history(obj, data)
        return data

    def _name_masker(self, obj, memo):
        """The masker of ``obj``'s type (a generated flow's name, #453),
        primed on the page's first entry of that type."""
        from core.hidden_fields import name_masker

        masker = name_masker(obj.object_type, self.context["request"].user, memo["_tenant"],
                             memo=memo.setdefault("_names", {}))
        if masker is not None and id(masker) not in memo.setdefault("_names_primed", set()):
            memo["_names_primed"].add(id(masker))
            rows = (
                list(self.parent.instance)
                if self.parent is not None and self.parent.instance is not None
                else [obj]
            )
            masker.prime_history(rows)
        return masker

    def get_object_exists(self, obj) -> bool:
        """Whether the entry's target row is still alive - the UI only links
        to living objects (an object deleted after the entry would 404).
        Resolved in bulk: the first row of a page batches one pk__in query
        per object type for every row on that page."""
        cache = self.context.setdefault("_object_exists", {})
        key = (obj.object_type, str(obj.object_id))
        if key in cache:
            return cache[key]
        rows = (
            list(self.parent.instance)
            if self.parent is not None and self.parent.instance is not None
            else [obj]
        )
        by_type: dict[str, set[str]] = {}
        for r in rows:
            if r.object_id is not None:
                by_type.setdefault(r.object_type, set()).add(str(r.object_id))
        for label, ids in by_type.items():
            try:
                model = django_apps.get_model(label)
                valid = _valid_pks(model, ids)
                alive = {
                    str(pk)
                    for pk in model.objects.filter(pk__in=valid).values_list(
                        "pk", flat=True
                    )
                } if valid else set()
            except Exception:
                # Stale label: nothing to link to.
                alive = set()
            for i in ids:
                cache[(label, i)] = i in alive
        return cache.get(key, False)

    #: The detail view also resolves the FK values of its snapshots.
    _label_snapshots = False

    def _scope(self):
        """The page's related-row scope (#413), or None without a request."""
        if "_related_scope" not in self.context:
            request = self.context.get("request")
            user = getattr(request, "user", None)
            self.context["_related_scope"] = (
                _RelatedScope(user, _get_active_tenant(request))
                if user is not None and getattr(user, "is_authenticated", False)
                else None
            )
        return self.context["_related_scope"]

    def _label(self, obj, model, pk):
        """The label of one related value of ``obj``'s entry: a string, None
        (no row to name) or ``HIDDEN``. The page's map is built on its first
        row - one visibility and one label query per related model for every
        row on the page."""
        labels = self.context.get("_fk_labels")
        if labels is None:
            rows = (
                list(self.parent.instance)
                if self.parent is not None and self.parent.instance is not None
                else [obj]
            )
            labels = self.context["_fk_labels"] = _labels_for_rows(
                rows, self._scope(), snapshots=self._label_snapshots
            )
        if pk in (None, ""):
            return None
        key = (model._meta.label_lower, str(pk))
        if key not in labels:
            labels[key] = _label_for(model, pk, self._scope())
        return labels[key]

    def get_changes(self, obj) -> dict:
        """Enrich FK fields with a resolved label so the UI can show the VLAN /
        site / role name next to its UUID. Non-relation fields pass through.
        A related row the caller may not view is named neither by label nor
        by id: its value is null and ``old_hidden`` / ``new_hidden`` is set
        (#413)."""
        rels = _relation_fields(obj.object_type)
        if not rels:
            return obj.changes or {}
        raw = _canonical_changes(obj.object_type, obj.changes or {})
        out = {}
        for field, diff in raw.items():
            related = rels.get(field)
            if related is None or not isinstance(diff, dict):
                out[field] = diff
                continue
            enriched = dict(diff)
            for side in ("old", "new"):
                label = self._label(obj, related, diff.get(side))
                if label is HIDDEN:
                    enriched[side] = None
                    enriched[f"{side}_hidden"] = True
                elif label is not None:
                    enriched[f"{side}_label"] = label
            out[field] = enriched
        return out


class ChangeLogDetailSerializer(ChangeLogSerializer):
    """Detail adds the full pre/post snapshots (kept off the list payload -
    they're whole-row dumps and the list can run hundreds of entries)."""

    related_labels = serializers.SerializerMethodField()
    hidden_related = serializers.SerializerMethodField()

    _label_snapshots = True

    class Meta(ChangeLogSerializer.Meta):
        fields = ChangeLogSerializer.Meta.fields + [
            "pre_change", "post_change", "related_labels", "hidden_related",
        ]

    def get_hidden_related(self, obj) -> dict:
        """``{"pre_change": [keys], "post_change": [keys]}``: the snapshot
        keys whose related row the caller may not view. Their values are
        nulled in the snapshots (#413)."""
        out: dict[str, list[str]] = {"pre_change": [], "post_change": []}
        rels = _snapshot_relations(obj.object_type)
        for key in out:
            snap = getattr(obj, key)
            if not rels or not isinstance(snap, dict):
                continue
            for field, v in snap.items():
                model = rels.get(field)
                if model is not None and self._label(obj, model, v) is HIDDEN:
                    out[key].append(field)
        return out

    def to_representation(self, obj):
        data = super().to_representation(obj)
        for key, fields in (data.get("hidden_related") or {}).items():
            snap = data.get(key)
            if isinstance(snap, dict):
                for field in fields:
                    if field in snap:
                        snap[field] = None
        return data

    def get_related_labels(self, obj) -> dict:
        """Flat ``{uuid: human label}`` for every resolvable FK value anywhere
        in this entry - the compact diff *and* both full snapshots. A UUID is
        globally unique, so one map lets the UI swap in the site / device /
        interface name wherever that UUID appears, without caring which field
        or snapshot it came from. Unresolvable ids (deleted rows) and rows the
        caller may not view are omitted; the UI falls back to the raw value."""
        rels = _relation_fields(obj.object_type)
        if not rels:
            return {}
        snap_rels = _snapshot_relations(obj.object_type)
        values = []
        for snap in (obj.pre_change or {}, obj.post_change or {}):
            if isinstance(snap, dict):
                for field, v in snap.items():
                    if field in snap_rels and v not in (None, ""):
                        values.append((snap_rels[field], v))
        for field, diff in _canonical_changes(obj.object_type, obj.changes or {}).items():
            model = rels.get(field)
            if model is not None and isinstance(diff, dict):
                for side in ("old", "new"):
                    if diff.get(side) not in (None, ""):
                        values.append((model, diff[side]))
        labels: dict[str, str] = {}
        for model, v in values:
            key = str(v)
            if key in labels:
                continue
            label = self._label(obj, model, v)
            if label is not None and label is not HIDDEN:
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
        # object_site_id - so it holds even for DELETE entries whose object is
        # gone (re-fetching the object, as before, made deleted-object history
        # unreadable and leaked cross-site rows the type filter let through).
        vis = _visibility_q(self.request)
        tenant = _get_active_tenant(self.request)

        # Detail: one entry by id, within the active tenant (+ tenant-less
        # entries for global models) so a foreign entry UUID can't be read by IDOR.
        if self.action == "retrieve":
            qs = self.queryset.filter(_tenant_gate(tenant))
            return qs.filter(vis) if vis is not None else qs

        p = self.request.query_params
        object_id = p.get("object_id")

        # Multi-object history (the device time machine: one device plus its
        # interfaces). Same tenant/visibility gates as the single-id path;
        # bounded so the filter can't become a table scan.
        object_ids = p.get("object_ids")
        if object_ids:
            ids = [x for x in object_ids.split(",") if x][:500]
            qs = self.queryset.filter(object_id__in=ids).filter(
                _tenant_gate(tenant)
            )
            otype = p.get("object_type")
            if otype:
                qs = qs.filter(object_type=otype)
            return qs.filter(vis) if vis is not None else qs

        # Per-object history (a detail-page History tab): scope to that object,
        # within the active tenant (tenant-less component rows bound by site).
        if object_id:
            qs = self.queryset.filter(object_id=object_id).filter(
                _tenant_gate(tenant)
            )
            otype = p.get("object_type")
            if otype:
                qs = qs.filter(object_type=otype)
            return qs.filter(vis) if vis is not None else qs

        # Global list: tenant-scoped.
        qs = self.queryset.filter(tenant=tenant) if tenant else self.queryset.none()
        for key in ("action", "object_type", "via"):
            v = p.get(key)
            if v:
                qs = qs.filter(**{key: v})
        user = p.get("user")
        if user:
            # The filter is a dropdown of exact actor names now - a substring
            # match made "admin" also return "administrator"'s rows.
            qs = qs.filter(user_name=user)
        search = p.get("search")
        if search:
            qs = qs.filter(object_repr__icontains=search)
            qs = qs.filter(vis) if vis is not None else qs
            # A generated flow's stored name may name a host the caller
            # may not view; it matches only as the caller reads it (#453).
            from core.hidden_fields import MASKED_NAMES, name_masker

            memo: dict = {}
            done: set = set()
            for label in MASKED_NAMES:
                masker = name_masker(label, self.request.user, tenant, memo=memo)
                if masker is not None and id(masker) not in done:
                    done.add(id(masker))
                    qs = masker.narrow_history_search(qs, search)
            return qs
        return qs.filter(vis) if vis is not None else qs

    @action(detail=False, methods=["get"], url_path="users")
    def users(self, request):
        """Distinct actors in the change log the caller can see - the User
        filter's dropdown. Deliberately NOT the user directory: it lists who
        actually made changes here, needs no user-management permission, and
        rides the same row-visibility gate as the entries themselves."""
        names = (
            self.get_queryset()
            .exclude(user_name="")
            .values_list("user_name", flat=True)
            .distinct()
            .order_by("user_name")
        )
        return Response({"results": list(names[:500])})


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

    def to_representation(self, obj):
        """A requirement's note on a pair names it by its flow's name: an
        end the caller may not view reads Hidden there (#453)."""
        data = super().to_representation(obj)
        if obj.object_type != "api.applicationflowrequirement":
            return data
        from core.hidden_fields import name_masker

        request = self.context.get("request")
        if request is None:
            return data
        memo = self.context.setdefault("_hidden_names", {})
        if "_tenant" not in memo:
            memo["_tenant"] = _get_active_tenant(request)
        masker = name_masker("api.applicationflow", request.user, memo["_tenant"], memo=memo)
        if masker is not None:
            data["comments"] = masker.journal_note(obj, data.get("comments") or "")
        return data


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
        # Row/site visibility via the stored object_site_id - consistent with the
        # change log, and (unlike re-fetching the object) it doesn't leak
        # cross-site notes the type filter would let through.
        vis = _visibility_q(self.request)
        if otype and oid:
            # Active-tenant gate that is safe for tenant-less component models
            # (bound by object_site_id), so a foreign object UUID can't leak its
            # notes by IDOR.
            out = qs.filter(object_type=otype, object_id=oid).filter(
                _tenant_gate(tenant)
            )
            return out.filter(vis) if vis is not None else out
        out = qs.filter(tenant=tenant) if tenant else qs.none()
        return out.filter(vis) if vis is not None else out

    def perform_create(self, serializer):
        # A journal note may only be attached to an object the caller can view
        # (row/site-scoped) - otherwise object_type+object_id are attacker-set.
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
        # Task comments carry personal notifications (assignees, creator,
        # earlier commenters, @mentions). Best-effort - a note always saves.
        if otype == "planning.task":
            from planning import notifications
            from planning.models import Task

            entry = serializer.instance
            task = Task.objects.filter(pk=oid).first()
            if task is not None:
                mentioned = [
                    u.pk
                    for u in notifications.parse_mentions(entry.comments, task.tenant)
                ]
                notifications.enqueue(
                    notifications.send_commented,
                    str(task.pk), str(entry.pk), user.pk, mentioned,
                )

    def _guard_owner(self, instance):
        user = self.request.user
        if not (instance.created_by_id == user.id or user.is_superuser):
            raise PermissionDenied("You can only edit your own journal entries.")

    def perform_update(self, serializer):
        self._guard_owner(serializer.instance)
        # A note is bound to the object it was created on - retargeting it
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
