"""Forms for the settings pages.

Two surfaces:

* :class:`UserSettingsForm` — every user. Writes to ``UserProfile.prefs``.
* :class:`AdminTenantSettingsForm` — admin-only. Writes to ``Tenant.prefs``
  + the tenant model's identity fields (name, description, color).

Both read the canonical registry in :mod:`auth_api.user_prefs` for choices
and validation. Adding a new pref means: add a `DEFAULTS` entry + a form
field + a render line in the template.
"""
from __future__ import annotations

from django import forms

from api.forms import _SELECT, _TEXT, _TEXTAREA
from api.models import IPRole, Status
from api.widgets import SearchableSelectWidget
from core.models import Tenant

from .user_prefs import PAGE_SIZE_CHOICES


def _page_size_choices() -> list[tuple[str, str]]:
    return [(str(n), f"{n} rows") for n in PAGE_SIZE_CHOICES]


THEME_CHOICES = [
    ("system", "Match system"),
    ("light",  "Light"),
    ("dark",   "Dark"),
]

DENSITY_CHOICES = [
    ("comfortable", "Comfortable — taller rows, more whitespace"),
    ("compact",     "Compact — denser"),
]


class UserSettingsForm(forms.Form):
    """Every authenticated user can change these on their own profile."""

    # ─── Tables ─────────────────────────────────────────────────────────
    page_size = forms.ChoiceField(
        label="Default page size",
        choices=_page_size_choices(),
        widget=forms.Select(attrs={"class": _SELECT}),
        help_text="How many rows list pages render at once.",
    )
    table_density = forms.ChoiceField(
        label="Row density",
        choices=DENSITY_CHOICES,
        widget=forms.Select(attrs={"class": _SELECT}),
    )
    table_stripes = forms.BooleanField(
        label="Striped rows by default",
        required=False,
        widget=forms.CheckboxInput(attrs={"class": "ck"}),
        help_text="Alternating row backgrounds — quicker to track values across a wide table.",
    )

    # ─── Visual ─────────────────────────────────────────────────────────
    theme = forms.ChoiceField(
        label="Theme",
        choices=THEME_CHOICES,
        widget=forms.Select(attrs={"class": _SELECT}),
        help_text="`Match system` follows your OS dark/light setting; the topbar toggle still wins per-session.",
    )

    # ─── Safety ─────────────────────────────────────────────────────────
    confirm_destructive = forms.BooleanField(
        label="Confirm destructive actions",
        required=False,
        widget=forms.CheckboxInput(attrs={"class": "ck"}),
        help_text="Bulk delete buttons require a second click to confirm. Turn off if you delete a lot and trust your aim.",
    )

    # ─── Tenant ─────────────────────────────────────────────────────────
    default_tenant_id = forms.ModelChoiceField(
        label="Default tenant on login",
        queryset=None,
        required=False,
        widget=SearchableSelectWidget(
            placeholder="Search tenants…",
            empty_label="— first available —",
        ),
        help_text="Pre-select this tenant when you sign in. Empty = your first allowed tenant.",
    )

    def __init__(self, *args, user=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = user
        # Tenants the user can actually access.
        from .permissions import user_tenants
        self.fields["default_tenant_id"].queryset = user_tenants(user) if user else Tenant.objects.none()
        # Seed initial values from the current prefs blob.
        if user is not None:
            from .user_prefs import DEFAULTS, get
            self.fields["page_size"].initial = str(get(user, "page_size"))
            self.fields["table_density"].initial = get(user, "table_density")
            self.fields["table_stripes"].initial = get(user, "table_stripes")
            self.fields["theme"].initial = get(user, "theme")
            self.fields["confirm_destructive"].initial = get(user, "confirm_destructive")
            self.fields["default_tenant_id"].initial = get(user, "default_tenant_id")

    def save(self):
        """Write each field into the user's prefs blob via the accessor."""
        from .user_prefs import set_user
        u = self.user
        cd = self.cleaned_data
        set_user(u, "page_size", int(cd["page_size"]))
        set_user(u, "table_density", cd["table_density"])
        set_user(u, "table_stripes", bool(cd["table_stripes"]))
        set_user(u, "theme", cd["theme"])
        set_user(u, "confirm_destructive", bool(cd["confirm_destructive"]))
        # ModelChoiceField returns the Tenant instance or None.
        tid = cd.get("default_tenant_id")
        set_user(u, "default_tenant_id", str(tid.id) if tid else None)


class AdminTenantSettingsForm(forms.Form):
    """Admin-only — sets defaults that apply to every user in the tenant
    who hasn't set their own override. Also edits the tenant's identity
    fields (name, description, color) in the same form so admins don't
    have to bounce between two pages.
    """

    # ─── Identity (writes to Tenant model directly) ─────────────────────
    name = forms.CharField(
        label="Tenant name",
        widget=forms.TextInput(attrs={"class": _TEXT, "placeholder": "Acme Networks"}),
    )
    description = forms.CharField(
        label="Description",
        required=False,
        widget=forms.Textarea(attrs={"class": _TEXTAREA, "rows": 2}),
    )

    # ─── Table defaults ─────────────────────────────────────────────────
    page_size = forms.ChoiceField(
        label="Default page size for new users",
        choices=_page_size_choices(),
        widget=forms.Select(attrs={"class": _SELECT}),
        help_text="Users can still pick their own on the user settings page.",
    )

    # ─── IPAM catalog defaults ──────────────────────────────────────────
    default_ip_status_id = forms.ModelChoiceField(
        label="Default IP status",
        queryset=Status.objects.none(),
        required=False,
        widget=SearchableSelectWidget(
            placeholder="Search statuses…",
            empty_label="— catalog default (is_default) —",
        ),
        help_text="Auto-filled on new IPs. Empty = whichever Status is flagged is_default in the catalog.",
    )
    default_ip_role_id = forms.ModelChoiceField(
        label="Default IP role",
        queryset=IPRole.objects.none(),
        required=False,
        widget=SearchableSelectWidget(
            placeholder="Search roles…",
            empty_label="— no role —",
        ),
        help_text="Auto-filled on new IPs.",
    )
    gateway_role_id = forms.ModelChoiceField(
        label="Gateway role",
        queryset=IPRole.objects.none(),
        required=False,
        widget=SearchableSelectWidget(
            placeholder="Search roles…",
            empty_label="— use catalog is_gateway flag —",
        ),
        help_text="Role used when auto-spawning a prefix's gateway IP.",
    )

    def __init__(self, *args, tenant: Tenant, **kwargs):
        super().__init__(*args, **kwargs)
        self.tenant = tenant
        # Scope catalog choices to this tenant.
        for fname in ("default_ip_status_id", "default_ip_role_id", "gateway_role_id"):
            model = Status if fname == "default_ip_status_id" else IPRole
            self.fields[fname].queryset = model.objects.filter(tenant=tenant)
        # Seed initial values.
        from .user_prefs import get
        self.fields["name"].initial = tenant.name
        self.fields["description"].initial = tenant.description
        self.fields["page_size"].initial = str(get(None, "page_size", tenant=tenant))
        for fname in ("default_ip_status_id", "default_ip_role_id", "gateway_role_id"):
            stored = (tenant.prefs or {}).get(fname)
            if stored:
                model = Status if fname == "default_ip_status_id" else IPRole
                obj = model.objects.filter(tenant=tenant, pk=stored).first()
                if obj is not None:
                    self.fields[fname].initial = obj

    def save(self):
        from .user_prefs import set_tenant
        t = self.tenant
        cd = self.cleaned_data
        t.name = cd["name"]
        t.description = cd["description"]
        t.save(update_fields=["name", "description"])
        set_tenant(t, "page_size", int(cd["page_size"]))
        for fname in ("default_ip_status_id", "default_ip_role_id", "gateway_role_id"):
            obj = cd.get(fname)
            set_tenant(t, fname, str(obj.id) if obj else None)
