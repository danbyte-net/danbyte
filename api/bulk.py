"""Bulk-action helpers for list pages.

Every Danbyte list page (Prefixes, IPs, Devices, Tags, …) opts into the
shared "select rows + act on them" UX by:

  1. Passing ``bulk_id`` (a stable string, e.g. ``"prefixes"``) and
     ``bulk_action_url`` to the list-view's template context.
  2. Adding ``{% bulk_th %}`` as the first ``<th>`` and ``{% bulk_td obj.id %}``
     as the first ``<td>`` (the template tags live in ``api_extras``).
  3. Routing ``bulk_action_url`` to ``bulk_action_view(model, ...)`` from
     this module — it handles the POST in a single transaction.

Why a single factory rather than a CBV mixin? List views in Danbyte are
plain function-views, and the bulk handler is genuinely tiny — model + perm
+ a couple of optional hooks is all it needs. Anything bigger gets pulled
out into per-model views.
"""
from __future__ import annotations

from typing import Any, Callable

from django import forms
from django.contrib import messages
from django.db import transaction
from django.http import HttpRequest, HttpResponse
from django.shortcuts import redirect, render
from django.views.decorators.http import require_POST

from auth_api.permissions import require_perm, user_has_perm


# Action slugs we recognise. The bar in `_bulk_bar.html` posts one of these
# in the ``action`` field; the view dispatches accordingly.
ACTION_DELETE = "delete"
ACTION_EDIT = "edit"
ACTION_EDIT_APPLY = "edit_apply"


# ─── Bulk-edit form base ─────────────────────────────────────────────────
#
# A "set this field?" toggle pattern: every editable field has a
# sibling ``_set_<name>`` BooleanField. Only fields whose toggle is ticked
# are written to the queryset — that lets a user clear a value (blank +
# tick = clear) without accidentally blanking every field they didn't
# touch.
#
# Subclass like a normal Form; declare only the editable fields. The base
# auto-adds the matching ``_set_<name>`` toggles in ``__init__``.

class BulkEditFormBase(forms.Form):
    """Mixin/base that auto-adds a "set this field?" toggle per declared field.

    Subclasses declare editable fields like a normal Form. After binding +
    cleaning, call ``apply(queryset)`` to write the chosen changes in one
    transaction. M2M fields are supported via ``M2M_FIELDS`` — they're
    handled separately because ``.update()`` can't touch them.
    """

    #: Names of M2M fields on the target model. Handled per-row instead of
    #: with a single ``.update()``. Semantics: REPLACE the row's M2M set.
    M2M_FIELDS: tuple[str, ...] = ()

    #: Names of M2M fields the subclass exposes as ``<name>_add`` +
    #: ``<name>_remove`` pairs. The base routes each picked value via
    #: ``manager.add(*qs)`` / ``manager.remove(*qs)`` — keeps the rest of
    #: each row's M2M set untouched.
    M2M_ADD_REMOVE_FIELDS: tuple[str, ...] = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Inject a toggle for every declared editable field. Toggles render
        # as the project's .ck checkbox (never a default browser checkbox)
        # so bulk-edit looks identical to every other form.
        editable = [n for n in list(self.fields.keys()) if not n.startswith("_set_")]
        for name in editable:
            self.fields[f"_set_{name}"] = forms.BooleanField(
                required=False,
                label=f"Set {name}",
                widget=forms.CheckboxInput(attrs={"class": "ck"}),
            )
        self._editable_names = tuple(editable)

    def chosen_fields(self) -> dict[str, Any]:
        """Return ``{field_name: cleaned_value}`` for fields whose toggle was ticked."""
        out = {}
        for name in self._editable_names:
            if self.cleaned_data.get(f"_set_{name}"):
                out[name] = self.cleaned_data.get(name)
        return out

    def editable_pairs(self):
        """Yield ``(toggle_bound_field, value_bound_field)`` for templates."""
        for name in self._editable_names:
            yield self[f"_set_{name}"], self[name]

    def apply(self, queryset) -> int:
        """Apply chosen edits to ``queryset``; return the row count touched.

        Scalar fields go through ``.update()`` for one round-trip; M2M
        fields are applied per-row because Django's manager API requires
        the parent instance. Add/remove pairs (``<name>_add``,
        ``<name>_remove``) are dispatched against the matching M2M
        manager and can both be set in the same submission.
        """
        chosen = self.chosen_fields()
        # Split inputs into three buckets: scalars (use .update()),
        # replace-M2M (.set()), and add/remove pairs (.add() / .remove()).
        addrem_targets = set(self.M2M_ADD_REMOVE_FIELDS)
        scalars, m2m_replace, addrem = {}, {}, {}
        for k, v in chosen.items():
            if k in self.M2M_FIELDS:
                m2m_replace[k] = v
            elif k.endswith("_add") and k[:-4] in addrem_targets:
                addrem.setdefault(k[:-4], {})["add"] = v
            elif k.endswith("_remove") and k[:-7] in addrem_targets:
                addrem.setdefault(k[:-7], {})["remove"] = v
            else:
                scalars[k] = v

        with transaction.atomic():
            touched = queryset.count()
            if scalars:
                queryset.update(**scalars)
            if m2m_replace or addrem:
                ids = list(queryset.values_list("id", flat=True))
                model = queryset.model
                for obj in model.objects.filter(id__in=ids):
                    for fname, value in m2m_replace.items():
                        getattr(obj, fname).set(value)
                    for fname, ops in addrem.items():
                        mgr = getattr(obj, fname)
                        if ops.get("add"):
                            mgr.add(*list(ops["add"]))
                        if ops.get("remove"):
                            mgr.remove(*list(ops["remove"]))
        return touched


def bulk_action_view(
    *,
    model,
    delete_perm: str,
    redirect_url: str,
    tenant_field: str = "tenant",
    edit_perm: str | None = None,
    edit_redirect: Callable[[list[str]], str] | None = None,
    edit_form: type[forms.Form] | None = None,
    edit_template: str = "api/_bulk_edit_page.html",
    edit_title: str = "Bulk edit",
    pre_delete: Callable[[Any], None] | None = None,
    label_plural: str = "items",
):
    """Build a view function that handles POSTed bulk actions.

    Parameters
    ----------
    model:
        The Django model the bulk action targets. Must have ``id`` + a
        tenant FK named by ``tenant_field`` (set to ``""`` to disable
        tenant scoping for global models like ``Tag``).
    delete_perm:
        The permission slug required to bulk-delete (e.g. ``"prefixes.delete"``).
    redirect_url:
        Where to send the user after the action runs.
    tenant_field:
        Name of the tenant FK on the model; pass ``""`` for tenant-less
        models. The factory uses this to scope the queryset to the active
        tenant so you can't delete across tenant boundaries.
    edit_perm:
        Permission required for bulk-edit. ``None`` disables the bulk-edit
        button (the sticky bar hides it).
    edit_redirect:
        Callable ``ids -> url`` that decides where to send the user when
        they click Edit. Only used when ``edit_form`` is also ``None``.
    edit_form:
        A ``BulkEditFormBase`` subclass. When provided, clicking Edit
        renders the bulk-edit page inline (no redirect) with the selected
        IDs preserved in hidden inputs; the same factory view handles the
        apply-step POST.
    edit_template:
        Template used to render the bulk-edit page. Defaults to the shared
        one at ``api/_bulk_edit_page.html``; override only if a page needs
        custom chrome.
    edit_title:
        Page title shown on the bulk-edit page.
    pre_delete:
        Optional hook invoked once per object before ``.delete()`` — use
        it for audit logging or to skip protected rows.
    label_plural:
        Used in the success message: ``"Deleted 4 prefixes."``.
    """
    from api.views import _get_active_tenant
    import inspect as _inspect

    def _make_form(form_cls, *, tenant=None, data=None):
        """Instantiate ``form_cls``, passing ``tenant=`` only if accepted.

        Lets per-tenant forms filter their dropdowns while keeping the
        scaffold compatible with simpler forms that don't need it.
        """
        try:
            sig = _inspect.signature(form_cls.__init__)
            accepts_tenant = "tenant" in sig.parameters
        except (TypeError, ValueError):
            accepts_tenant = False
        kwargs = {}
        if accepts_tenant and tenant is not None:
            kwargs["tenant"] = tenant
        if data is not None:
            return form_cls(data, **kwargs)
        return form_cls(**kwargs)

    def _scope(request: HttpRequest, ids):
        """Return the model queryset scoped to ``ids`` + the active tenant.
        Returns ``None`` if the active tenant is missing (caller redirects).
        """
        qs = model.objects.filter(id__in=ids)
        if tenant_field:
            tenant = _get_active_tenant(request)
            if tenant is None:
                return None, None
            qs = qs.filter(**{tenant_field: tenant})
            return qs, tenant
        return qs, None

    @require_POST
    @require_perm(delete_perm)
    def view(request: HttpRequest) -> HttpResponse:
        ids = request.POST.getlist("bulk_ids")
        action = request.POST.get("action", "")
        if not ids:
            messages.error(request, "No rows selected.")
            return redirect(redirect_url)

        # ── Edit-step 1: render the bulk-edit form ────────────────────
        # Surfaces the shared form scaffold with the chosen IDs hidden
        # inside it; submission posts ``action=edit_apply`` back here.
        if action == ACTION_EDIT:
            if not edit_perm or not user_has_perm(request.user, edit_perm):
                messages.error(request, "You don't have permission to edit these.")
                return redirect(redirect_url)
            if edit_form is not None:
                qs, tenant = _scope(request, ids)
                if qs is None:
                    messages.error(request, "No tenant selected.")
                    return redirect(redirect_url)
                return render(
                    request,
                    edit_template,
                    {
                        "form": _make_form(edit_form, tenant=tenant),
                        "ids": list(qs.values_list("id", flat=True)),
                        "count": qs.count(),
                        "title": edit_title,
                        "label_plural": label_plural,
                        "submit_url": request.path,
                        "cancel_url": redirect_url,
                    },
                )
            # Legacy fallback for pages that opted into a separate
            # bulk-edit page via ``edit_redirect`` instead of the
            # shared template.
            if edit_redirect is not None:
                return redirect(edit_redirect(ids))
            messages.info(request, "Bulk edit is not available for this page yet.")
            return redirect(redirect_url)

        # ── Edit-step 2: apply the form ──────────────────────────────
        if action == ACTION_EDIT_APPLY:
            if not edit_perm or not user_has_perm(request.user, edit_perm):
                messages.error(request, "You don't have permission to edit these.")
                return redirect(redirect_url)
            if edit_form is None:
                messages.error(request, "Bulk edit is not configured for this page.")
                return redirect(redirect_url)
            qs, tenant = _scope(request, ids)
            if qs is None:
                messages.error(request, "No tenant selected.")
                return redirect(redirect_url)
            form = _make_form(edit_form, tenant=tenant, data=request.POST)
            if not form.is_valid():
                return render(
                    request,
                    edit_template,
                    {
                        "form": form,
                        "ids": ids,
                        "count": qs.count(),
                        "title": edit_title,
                        "label_plural": label_plural,
                        "submit_url": request.path,
                        "cancel_url": redirect_url,
                    },
                )
            touched = form.apply(qs)
            messages.success(request, f"Updated {touched} {label_plural}.")
            return redirect(redirect_url)

        # ── Delete ───────────────────────────────────────────────────
        if action != ACTION_DELETE:
            messages.error(request, f"Unknown bulk action: {action!r}.")
            return redirect(redirect_url)

        qs, _ = _scope(request, ids)
        if qs is None:
            messages.error(request, "No tenant selected.")
            return redirect(redirect_url)

        deleted = 0
        with transaction.atomic():
            for obj in qs:
                if pre_delete is not None:
                    pre_delete(obj)
                obj.delete()
                deleted += 1

        messages.success(request, f"Deleted {deleted} {label_plural}.")
        return redirect(redirect_url)

    return view
