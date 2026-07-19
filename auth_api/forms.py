"""Forms for user CRUD + login."""
from __future__ import annotations

from django import forms
from django.contrib.auth.forms import AuthenticationForm
from django.contrib.auth.models import User

from api.widgets import MultiPickerWidget

from core.models import Tenant

from .models import UserProfile
from .permissions import PERMISSIONS


_TEXT = (
    "h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm "
    "placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none "
    "dark:border-zinc-800 dark:bg-zinc-950 dark:focus:border-zinc-600"
)
_SELECT = (
    "h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm "
    "focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
)


class LoginForm(AuthenticationForm):
    """Light wrapper that applies our input styling."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for f in ("username", "password"):
            self.fields[f].widget.attrs["class"] = _TEXT
        self.fields["username"].widget.attrs["placeholder"] = "username"
        self.fields["password"].widget.attrs["placeholder"] = "password"


class UserForm(forms.ModelForm):
    """Create / edit a User + Profile in one form.

    Password is required on create; on edit, leaving it blank keeps the
    existing password. Permissions field is rendered as a multi-checkbox
    grid by the template; we just provide the source list.
    """

    password = forms.CharField(
        required=False,
        widget=forms.PasswordInput(attrs={"class": _TEXT,
                                          "placeholder": "leave blank to keep"}),
        help_text="Leave blank to keep the current password (when editing).",
    )
    role = forms.ChoiceField(
        choices=UserProfile.ROLE_CHOICES,
        widget=forms.Select(attrs={"class": _SELECT}),
    )
    permissions = forms.MultipleChoiceField(
        choices=[(p[0], p[1]) for p in PERMISSIONS],
        required=False,
        widget=forms.CheckboxSelectMultiple(attrs={"class": "ck"}),
        help_text="Only used when role = custom.",
    )
    tenants = forms.ModelMultipleChoiceField(
        queryset=Tenant.objects.filter(is_active=True).order_by("name"),
        required=False,
        widget=MultiPickerWidget(placeholder="Search tenants…"),
        label="Tenants",
        help_text=("Tenants this user can switch to and operate within. "
                   "Ignored for admin / superuser — they see every tenant."),
    )

    class Meta:
        model = User
        fields = ["username", "first_name", "last_name", "email", "is_active"]
        widgets = {
            "username":   forms.TextInput(attrs={"class": _TEXT}),
            "first_name": forms.TextInput(attrs={"class": _TEXT}),
            "last_name":  forms.TextInput(attrs={"class": _TEXT}),
            "email":      forms.EmailInput(attrs={"class": _TEXT}),
            "is_active":  forms.CheckboxInput(attrs={"class": "ck"}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        profile = getattr(self.instance, "profile", None) if self.instance.pk else None
        if profile:
            self.fields["role"].initial = profile.role
            self.fields["permissions"].initial = profile.permissions or []
            self.fields["tenants"].initial = list(
                profile.tenants.values_list("pk", flat=True)
            )
        else:
            self.fields["role"].initial = "reader"
        # Password is mandatory on create.
        if not (self.instance and self.instance.pk):
            self.fields["password"].required = True
            self.fields["password"].help_text = "Required for new users."

    def save(self, commit=True):
        u = super().save(commit=False)
        raw_pw = self.cleaned_data.get("password") or ""
        if raw_pw:
            u.set_password(raw_pw)
        if commit:
            u.save()
            profile, _ = UserProfile.objects.get_or_create(user=u)
            profile.role = self.cleaned_data["role"]
            profile.permissions = list(self.cleaned_data.get("permissions") or [])
            profile.save()
            profile.tenants.set(self.cleaned_data.get("tenants") or [])
        return u
