"""Login / logout + user CRUD pages.

Login + logout reuse Django's built-in views with our own templates.
User management is locked behind the ``users.manage`` permission.
"""
from __future__ import annotations

import json

from django.contrib import messages
from django.contrib.auth import login as auth_login, logout as auth_logout
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from django.db.models import Q
from django.http import HttpResponseBadRequest, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST, require_http_methods

from .forms import LoginForm, UserForm
from .permissions import PERMISSIONS, can_manage_admin, require_perm, user_perms


def login_view(request):
    if request.user.is_authenticated:
        return redirect("api:prefixes")
    form = LoginForm(request, data=request.POST or None)
    if request.method == "POST" and form.is_valid():
        auth_login(request, form.get_user())
        next_url = request.GET.get("next") or reverse("api:prefixes")
        return redirect(next_url)
    return render(request, "auth/login.html", {"form": form})


@require_POST
def logout_view(request):
    auth_logout(request)
    return redirect("auth_api:login")


@require_perm("users.manage")
def user_list(request):
    qs = User.objects.select_related("profile").order_by("username")
    q = (request.GET.get("q") or "").strip()
    if q:
        qs = qs.filter(
            Q(username__icontains=q) | Q(email__icontains=q)
            | Q(first_name__icontains=q) | Q(last_name__icontains=q)
        )
    role = request.GET.get("role")
    if role:
        qs = qs.filter(profile__role=role)
    return render(request, "auth/user_list.html", {
        "active_nav": "users",
        "page_title": "Users",
        "noun": "user",
        "create_url": reverse("auth_api:user-create"),
        "create_label": "Add user",
        "search_placeholder": "Filter by username / email / name…",
        "users": qs,
        "all_total": qs.count(),
        "active_filters": [],
        "bulk_action_url": reverse("auth_api:user-bulk"),
        "bulk_label_plural": "users",
    })


@require_http_methods(["GET", "POST"])
@require_perm("users.manage")
def user_create(request):
    if request.method == "POST":
        form = UserForm(request.POST)
        if form.is_valid():
            u = form.save()
            messages.success(request, f"User '{u.username}' created.")
            return redirect("auth_api:users")
    else:
        form = UserForm()
    return render(request, "auth/user_form.html", {
        "active_nav": "users", "form": form,
        "title": "Add user", "submit_label": "Create user",
        "permissions_grouped": _group_permissions(),
        "cancel_url": reverse("auth_api:users"),
    })


@require_http_methods(["GET", "POST"])
@require_perm("users.manage")
def user_edit(request, pk):
    obj = get_object_or_404(User, pk=pk)
    if request.method == "POST":
        form = UserForm(request.POST, instance=obj)
        if form.is_valid():
            form.save()
            messages.success(request, f"User '{obj.username}' updated.")
            return redirect("auth_api:users")
    else:
        form = UserForm(instance=obj)
    return render(request, "auth/user_form.html", {
        "active_nav": "users", "form": form,
        "title": f"Edit {obj.username}", "submit_label": "Save changes",
        "permissions_grouped": _group_permissions(),
        "cancel_url": reverse("auth_api:users"),
        "delete_url": reverse("auth_api:user-delete", args=[obj.pk]),
        "delete_confirm": f"Delete user '{obj.username}'? Their sessions are revoked immediately.",
        "user_obj": obj,
    })


@require_POST
@require_perm("users.manage")
def user_delete(request, pk):
    obj = get_object_or_404(User, pk=pk)
    if obj == request.user:
        messages.error(request, "You can't delete yourself.")
        return redirect("auth_api:user-edit", pk=pk)
    name = obj.username
    obj.delete()
    messages.success(request, f"User '{name}' deleted.")
    return redirect("auth_api:users")


def _settings_sites_payload(user, tenant):
    from core.site_settings import manageable_settings_sites

    allowed = manageable_settings_sites(user, tenant)
    if allowed == "all":
        return "all"
    return sorted(str(sid) for sid in allowed)


@require_GET
@ensure_csrf_cookie
def me_json(request):
    """Identity + effective permissions for the React frontend.

    Deliberately *not* ``@login_required`` — an anonymous caller gets a clean
    ``{"is_authenticated": false, "perms": []}`` (HTTP 200) instead of a 302
    redirect to the login page, which ``fetch`` would otherwise follow and
    hand the SPA a chunk of login HTML. The client decides what to do with an
    unauthenticated answer.

    ``@ensure_csrf_cookie`` guarantees the ``csrftoken`` cookie is set even for
    an anonymous visitor — the React login page calls this on mount, so the
    follow-up ``POST /api/auth/login/`` has a token to send.
    """
    user = request.user
    if not user.is_authenticated:
        return JsonResponse({"is_authenticated": False, "perms": []})

    from api.views import _get_active_tenant
    from core.effective_settings import (
        effective_separation,
        effective_sharing,
        effective_ui,
    )
    from core.models import DeploymentSettings
    from .permissions import can_manage_deployment
    from .rbac import editable_sites, effective_actions

    perms = user_perms(user)  # legacy flat slugs (kept for back-compat)
    tenant = _get_active_tenant(request)
    # New fine-grained map: {object_type_slug: [actions]} in the active tenant.
    permissions = {
        slug: sorted(acts) for slug, acts in effective_actions(user, tenant).items()
    }
    # Single source of truth for "can reach admin surfaces" — same helper the
    # tenant-settings / monitoring settings endpoints gate on. Deployment-wide
    # surfaces (global email/LDAP/updates) additionally need the stricter flag.
    can_manage_users = can_manage_admin(user, tenant)
    profile = getattr(user, "profile", None)

    # Sharing & delegation / UI policy — per-tenant override or deployment
    # default (core.effective_settings). deployment_name stays global.
    ds = DeploymentSettings.load()
    sharing = effective_sharing(tenant)
    ui = effective_ui(tenant)
    delegation_on = sharing.allow_site_editor_delegation
    # The sites this user may WRITE in: None = all (admins, unscoped editors),
    # a set = site-scoped local IT. Computed once — the delegation flags and
    # the separation payload both read it.
    own_sites = None if can_manage_users else editable_sites(user, tenant)
    can_delegate_sites = []  # "all" | [site_id]; only meaningful when on
    if delegation_on:
        can_delegate_sites = (
            "all" if own_sites is None else sorted(str(sid) for sid in own_sites)
        )
    separation = effective_separation(tenant)

    return JsonResponse({
        "is_authenticated": True,
        "username": user.get_username(),
        "email": user.email,
        "is_staff": user.is_staff,
        "is_superuser": user.is_superuser,
        "perms": perms,
        "permissions": permissions,
        "can_manage_users": can_manage_users,
        "can_manage_deployment": can_manage_deployment(user),
        "mfa": {
            "require_mfa": bool(profile and profile.require_mfa),
            "totp_confirmed": bool(profile and profile.mfa_totp_confirmed),
            "email_available": bool(profile and profile.mfa_email and user.email),
        },
        "can_edit_tenant": "tenants.edit" in perms or "tenant" in permissions,
        "deployment_name": ds.deployment_name,
        # Whether the SPA should surface per-tenant human-readable numbers (numid).
        "human_ids_enabled": ui.human_ids_enabled,
        # Sharing & delegation feature flags for the SPA (per-tenant effective).
        "site_delegation_enabled": delegation_on,
        "can_delegate_sites": can_delegate_sites,
        # Enhanced site separation (per-tenant effective): when on, the SPA
        # filters site pickers to editable_sites and locks single-site users'
        # site fields. "all" = unscoped (admins / cross-site editors).
        "site_separation": bool(separation.enhanced_site_separation),
        "editable_sites": (
            "all" if own_sites is None else sorted(str(sid) for sid in own_sites)
        ),
        # Per-site settings: the allow switch + which sites this user may
        # manage settings for ("all" | [ids]; [] = the section stays hidden).
        "site_settings_enabled": bool(separation.allow_site_settings),
        "settings_sites": _settings_sites_payload(request.user, tenant),
        "active_tenant": (
            {"id": str(tenant.id), "name": tenant.name, "slug": tenant.slug}
            if tenant is not None else None
        ),
    })


@require_http_methods(["GET", "PUT"])
def me_prefs(request):
    """The signed-in user's display preferences, over auth_api.user_prefs.

    GET → ``{values, defaults, user_set}`` where ``values`` are the effective
    prefs (user override → tenant default → built-in). PUT a partial dict of
    ``{key: value}`` to set user-level overrides. Unknown keys 400.
    """
    if not request.user.is_authenticated:
        return JsonResponse({"error": "auth required"}, status=401)

    from . import user_prefs
    from api.views import _get_active_tenant

    if not hasattr(request.user, "profile"):
        from .models import UserProfile
        UserProfile.objects.create(user=request.user)

    if request.method == "PUT":
        try:
            body = json.loads(request.body or b"{}")
        except json.JSONDecodeError:
            return HttpResponseBadRequest("invalid JSON")
        if not isinstance(body, dict):
            return HttpResponseBadRequest("body must be a JSON object")
        bad = [k for k in body if k not in user_prefs.DEFAULTS]
        if bad:
            return JsonResponse({"error": f"unknown keys: {', '.join(bad)}"}, status=400)
        for k, v in body.items():
            user_prefs.set_user(request.user, k, v)

    tenant = _get_active_tenant(request)
    values = {k: user_prefs.get(request.user, k, tenant=tenant) for k in user_prefs.DEFAULTS}
    user_blob = getattr(request.user.profile, "prefs", {}) or {}
    return JsonResponse({
        "values": values,
        "defaults": user_prefs.DEFAULTS,
        "user_set": list(user_blob.keys()),
    })


def _group_permissions():
    """Group the perm registry by area for the edit form's checkbox grid."""
    by_area: dict[str, list[tuple[str, str]]] = {}
    for slug, label, area in PERMISSIONS:
        by_area.setdefault(area, []).append((slug, label))
    return [(area, items) for area, items in by_area.items()]


# ─── Settings (per-user + admin tenant-wide) ──────────────────────────────


@login_required
@require_http_methods(["GET", "POST"])
def user_settings(request):
    """Per-user preferences: theme, density, page size, default tenant, …"""
    from .settings_forms import UserSettingsForm
    # Ensure the user has a profile so .prefs writes succeed.
    if not hasattr(request.user, "profile"):
        from .models import UserProfile
        UserProfile.objects.create(user=request.user)
    if request.method == "POST":
        form = UserSettingsForm(request.POST, user=request.user)
        if form.is_valid():
            form.save()
            messages.success(request, "Settings saved.")
            return redirect("auth_api:user-settings")
    else:
        form = UserSettingsForm(user=request.user)
    return render(request, "auth/user_settings.html", {
        "active_nav": "settings",
        "active_settings_tab": "user",
        "form": form,
        "title": "Your settings",
    })


@require_perm("tenants.edit")
@require_http_methods(["GET", "POST"])
def admin_tenant_settings(request):
    """Admin-only — tenant-wide defaults that apply to every user."""
    from api.views import _get_active_tenant
    from .settings_forms import AdminTenantSettingsForm
    tenant = _get_active_tenant(request)
    if tenant is None:
        return render(request, "api/no_org.html", status=200)
    if request.method == "POST":
        form = AdminTenantSettingsForm(request.POST, tenant=tenant)
        if form.is_valid():
            form.save()
            messages.success(request, f"Tenant settings for '{tenant.name}' saved.")
            return redirect("auth_api:admin-settings")
    else:
        form = AdminTenantSettingsForm(tenant=tenant)
    return render(request, "auth/admin_settings.html", {
        "active_nav": "settings",
        "active_settings_tab": "admin",
        "form": form,
        "tenant": tenant,
        "title": f"Admin settings · {tenant.name}",
    })
