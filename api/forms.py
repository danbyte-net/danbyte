"""Lightweight ModelForms for the prefix + IP CRUD pages."""
from __future__ import annotations

import ipaddress

from django import forms
from django.db.models import Q
from django.utils.text import slugify

from core.models import Organization, Tag, Tenant

from .models import Device, DeviceType, Manufacturer, VRF, IPAddress, IPRole, Status, Prefix, RouteTarget, Site, VLAN
from .widgets import ColorPickerWidget, MultiPickerWidget, SearchableSelectWidget, TagPickerWidget


_TEXT = (
    "h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm "
    "placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none "
    "focus:ring-0 dark:border-zinc-800 dark:bg-zinc-950 dark:focus:border-zinc-600"
)
_TEXTAREA = (
    "w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm "
    "placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none "
    "dark:border-zinc-800 dark:bg-zinc-950 dark:focus:border-zinc-600"
)
_SELECT = (
    "h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm "
    "focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
)


class PrefixForm(forms.ModelForm):
    """Create / edit a Prefix. Tags use the global picker + inline-add input."""

    class Meta:
        model = Prefix
        fields = ["cidr", "status", "vrf", "site", "vlan", "gateway", "description"]
        widgets = {
            "cidr": forms.TextInput(
                attrs={"class": _TEXT, "placeholder": "10.0.10.0/24 or 2001:db8:1::/64"}
            ),
            "status": forms.Select(attrs={"class": _SELECT}),
            "vrf": forms.Select(attrs={"class": _SELECT}),
            "site": forms.Select(attrs={"class": _SELECT}),
            "vlan": forms.Select(attrs={"class": _SELECT}),
            "gateway": forms.TextInput(
                attrs={
                    "class": _TEXT,
                    "placeholder": "auto from site policy if left blank",
                }
            ),
            "description": forms.Textarea(attrs={"class": _TEXTAREA, "rows": 3}),
        }

    def __init__(self, *args, tenant=None, org=None, **kwargs):
        # `tenant` is the real parameter; `org` is a back-compat alias the
        # old call sites still pass.
        if tenant is None:
            tenant = org
        super().__init__(*args, **kwargs)
        self.tenant = tenant
        if tenant is not None:
            self.fields["site"].queryset = Site.objects.filter(tenant=tenant)
            self.fields["vlan"].queryset = VLAN.objects.filter(tenant=tenant)
            self.fields["vrf"].queryset = VRF.objects.filter(tenant=tenant)
        self.fields["site"].required = False
        self.fields["vlan"].required = False
        self.fields["vrf"].required = False
        self.fields["site"].empty_label = "— no site —"
        self.fields["vlan"].empty_label = "— no VLAN —"
        self.fields["vrf"].empty_label = "Global"
        apply_tag_picker(self, self.instance)

    def clean_cidr(self):
        cidr = (self.cleaned_data.get("cidr") or "").strip()
        if not cidr:
            raise forms.ValidationError("Required.")
        try:
            net = ipaddress.ip_network(cidr, strict=False)
        except ValueError as e:
            raise forms.ValidationError(f"Not a valid CIDR: {e}")
        return str(net)

    def clean(self):
        cleaned = super().clean()
        cidr = cleaned.get("cidr")
        vrf = cleaned.get("vrf")
        if self.tenant is not None and cidr:
            qs = Prefix.objects.filter(tenant=self.tenant, vrf=vrf, cidr=cidr)
            if self.instance and self.instance.pk:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                vrf_label = vrf.name if vrf else "Global"
                raise forms.ValidationError(
                    f"A prefix with CIDR {cidr} already exists in VRF '{vrf_label}'. "
                    f"Pick a different VRF or CIDR."
                )
        return cleaned

    def clean_gateway(self):
        gw = (self.cleaned_data.get("gateway") or "").strip()
        if not gw:
            return None
        try:
            ipaddress.ip_address(gw)
        except ValueError:
            raise forms.ValidationError(f"'{gw}' is not a valid IP address.")
        return gw


class IPAddressForm(forms.ModelForm):
    """Create / edit a single IPAddress."""

    class Meta:
        model = IPAddress
        fields = ["ip_address", "status", "role", "reservation_note", "description", "assigned_device"]
        widgets = {
            "ip_address": forms.TextInput(
                attrs={"class": _TEXT, "placeholder": "10.0.10.42"}
            ),
            "status": forms.Select(attrs={"class": _SELECT}),
            "role": forms.Select(attrs={"class": _SELECT}),
            "reservation_note": forms.TextInput(
                attrs={
                    "class": _TEXT,
                    "placeholder": "Who's holding this / why? (shown on hover)",
                }
            ),
            "description": forms.Textarea(attrs={"class": _TEXTAREA, "rows": 2}),
            "assigned_device": SearchableSelectWidget(
                placeholder="Search devices…", empty_label="— unassigned —",
            ),
        }

    def __init__(self, *args, prefix=None, tenant=None, org=None, **kwargs):
        if tenant is None:
            tenant = org
        super().__init__(*args, **kwargs)
        self.prefix_obj = prefix
        self.tenant = tenant
        # Scope the status / role / device choices to the active tenant's catalogs.
        if tenant is not None:
            ip_statuses = Status.objects.filter(
                tenant=tenant, available_to__contains=["ipaddress"]
            )
            self.fields["status"].queryset = ip_statuses
            self.fields["role"].queryset = IPRole.objects.filter(tenant=tenant)
            self.fields["role"].empty_label = "—"
            self.fields["assigned_device"].queryset = Device.objects.filter(tenant=tenant)
            self.fields["assigned_device"].empty_label = "— unassigned —"
            # Default status on new records: the row flagged default_for ipaddress,
            # else the first IP-available row by weight.
            if not (self.instance and self.instance.pk) and not self.initial.get("status"):
                default_status = (
                    ip_statuses.filter(default_for__contains=["ipaddress"]).first()
                    or ip_statuses.first()
                )
                if default_status:
                    self.initial["status"] = default_status.pk
        apply_tag_picker(self, self.instance)

    def clean(self):
        cleaned = super().clean()
        status = cleaned.get("status")
        note = (cleaned.get("reservation_note") or "").strip()
        # When the chosen status requires a note (Reserved, by default), make
        # sure the user actually wrote one.
        if status and getattr(status, "requires_note", False) and not note:
            self.add_error(
                "reservation_note",
                f"'{status.name}' requires a short note — who's holding it / why?",
            )
        cleaned["reservation_note"] = note
        return cleaned

    def clean_ip_address(self):
        raw = (self.cleaned_data.get("ip_address") or "").strip()
        if not raw:
            raise forms.ValidationError("Required.")
        try:
            addr = ipaddress.ip_address(raw)
        except ValueError as e:
            raise forms.ValidationError(f"Not a valid IP address: {e}")
        if self.prefix_obj is not None:
            net = self.prefix_obj.network
            if net is not None and addr not in net:
                raise forms.ValidationError(
                    f"{addr} is not inside {self.prefix_obj.cidr}."
                )
        if self.tenant is not None:
            vrf = self.prefix_obj.vrf if self.prefix_obj else None
            qs = IPAddress.objects.filter(tenant=self.tenant, vrf=vrf, ip_address=str(addr))
            if self.instance and self.instance.pk:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                vrf_label = vrf.name if vrf else "Global"
                raise forms.ValidationError(
                    f"{addr} is already registered in VRF '{vrf_label}'."
                )
        return str(addr)


# ─── Scoped models (Tenant / VRF / Site / Tag / VLAN / Org) ───────────────


# ─── Tag picker helpers ──────────────────────────────────────────────────


def make_tag_field():
    """ModelMultipleChoiceField bound to the Tag catalog."""
    return forms.ModelMultipleChoiceField(
        queryset=Tag.objects.all().order_by("name"),
        required=False,
        widget=TagPickerWidget,
        label="Tags",
        help_text="Pick from existing tags. Hold Ctrl/⌘ to select multiple.",
    )


def make_new_tags_field():
    """Companion text field for inline tag creation."""
    return forms.CharField(
        required=False,
        label="Add new tags",
        widget=forms.TextInput(attrs={
            "class": ("h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 "
                      "text-sm placeholder:text-zinc-400 focus:border-zinc-400 "
                      "focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 "
                      "dark:focus:border-zinc-600"),
            "placeholder": "comma-separated, created on the fly (colorless)",
        }),
        help_text="Names you type here are created in the global tag catalog with no color. Edit colors on the Tags page.",
    )


def apply_tag_picker(form, instance):
    """Wire tags + new_tags onto a form already initialised from `instance`.

    Call from each form's __init__ AFTER super().__init__:
        apply_tag_picker(self, self.instance)
    """
    form.fields["tags"] = make_tag_field()
    form.fields["new_tags"] = make_new_tags_field()
    if instance is not None and instance.pk is not None:
        form.fields["tags"].initial = list(
            instance.tags.all().values_list("id", flat=True)
        )


def save_tag_picker(form, instance):
    """Combine the dropdown selection + freshly-typed names and apply them
    to ``instance.tags``. Call AFTER the instance has a pk."""
    if instance.pk is None:
        return
    picked = list(form.cleaned_data.get("tags") or [])
    raw_new = (form.cleaned_data.get("new_tags") or "").strip()
    new_names = []
    for piece in raw_new.replace("\n", ",").split(","):
        name = piece.strip()
        if not name:
            continue
        new_names.append(name)
    instance.tags.set([t.name for t in picked] + new_names)


_COLOR = (
    "h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 font-mono "
    "text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none "
    "dark:border-zinc-800 dark:bg-zinc-950 dark:focus:border-zinc-600"
)
_CHECKBOX = forms.CheckboxInput(attrs={"class": "ck"})


class _ColorMixin:
    """Treat empty color as ``""`` and accept blank, but validate hex when set."""

    def clean_color(self):
        v = (self.cleaned_data.get("color") or "").strip()
        if v == "":
            return ""
        if not (len(v) == 7 and v.startswith("#")):
            raise forms.ValidationError("Use 7-char hex like #10b981, or leave blank.")
        try:
            int(v[1:], 16)
        except ValueError:
            raise forms.ValidationError("Not a valid hex color.")
        return v


class OrganizationForm(forms.ModelForm):
    class Meta:
        model = Organization
        fields = ["name", "slug", "description"]
        widgets = {
            "name":        forms.TextInput(attrs={"class": _TEXT}),
            "slug":        forms.TextInput(attrs={"class": _TEXT, "placeholder": "auto from name"}),
            "description": forms.Textarea(attrs={"class": _TEXTAREA, "rows": 3}),
        }

    def clean_slug(self):
        s = (self.cleaned_data.get("slug") or "").strip()
        if not s:
            s = slugify(self.cleaned_data.get("name") or "")
        return s


class TenantForm(_ColorMixin, forms.ModelForm):
    class Meta:
        model = Tenant
        fields = ["name", "slug", "color", "description", "is_active"]
        widgets = {
            "name":        forms.TextInput(attrs={"class": _TEXT}),
            "slug":        forms.TextInput(attrs={"class": _TEXT, "placeholder": "auto from name"}),
            "color":       ColorPickerWidget(placeholder="#3b82f6"),
            "description": forms.Textarea(attrs={"class": _TEXTAREA, "rows": 3}),
            "is_active":   forms.CheckboxInput(attrs={"class": "ck"}),
        }

    def __init__(self, *args, org=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.org = org

    def clean_slug(self):
        s = (self.cleaned_data.get("slug") or "").strip()
        if not s:
            s = slugify(self.cleaned_data.get("name") or "")
        if self.org is not None:
            qs = Tenant.objects.filter(org=self.org, slug=s)
            if self.instance and self.instance.pk:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise forms.ValidationError("Another tenant in this org already uses that slug.")
        return s


class RouteTargetForm(forms.ModelForm):
    class Meta:
        model = RouteTarget
        fields = ["name", "description"]
        widgets = {
            "name":        forms.TextInput(attrs={"class": _TEXT, "placeholder": "65000:100"}),
            "description": forms.Textarea(attrs={"class": _TEXTAREA, "rows": 3}),
        }

    def __init__(self, *args, tenant=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.tenant = tenant

    def clean_name(self):
        n = (self.cleaned_data.get("name") or "").strip()
        if not n:
            raise forms.ValidationError("Required.")
        if self.tenant is not None:
            qs = RouteTarget.objects.filter(tenant=self.tenant, name=n)
            if self.instance and self.instance.pk:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise forms.ValidationError(
                    f"A route target named '{n}' already exists in this tenant."
                )
        return n


class VRFForm(_ColorMixin, forms.ModelForm):
    class Meta:
        model = VRF
        fields = ["name", "rd", "color", "description", "enforce_unique",
                  "import_targets", "export_targets"]
        widgets = {
            "name":           forms.TextInput(attrs={"class": _TEXT, "placeholder": "production"}),
            "rd":             forms.TextInput(attrs={"class": _TEXT, "placeholder": "65001:100"}),
            "color":          ColorPickerWidget(placeholder="#10b981"),
            "description":    forms.Textarea(attrs={"class": _TEXTAREA, "rows": 3}),
            "enforce_unique": forms.CheckboxInput(attrs={"class": "ck"}),
            "import_targets": MultiPickerWidget(placeholder="Search route targets…"),
            "export_targets": MultiPickerWidget(placeholder="Search route targets…"),
        }

    def __init__(self, *args, tenant=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.tenant = tenant
        if tenant is not None:
            rts = RouteTarget.objects.filter(tenant=tenant).order_by("name")
            self.fields["import_targets"].queryset = rts
            self.fields["export_targets"].queryset = rts
        self.fields["import_targets"].required = False
        self.fields["export_targets"].required = False
        self.fields["import_targets"].help_text = (
            "Route targets this VRF accepts routes from. Pick from the catalog "
            "— add new ones on the Route targets page."
        )
        self.fields["export_targets"].help_text = (
            "Route targets this VRF tags its own routes with. Other VRFs "
            "importing these RTs receive the routes."
        )

    def clean_name(self):
        n = (self.cleaned_data.get("name") or "").strip()
        if not n:
            raise forms.ValidationError("Required.")
        if self.tenant is not None:
            qs = VRF.objects.filter(tenant=self.tenant, name=n)
            if self.instance and self.instance.pk:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise forms.ValidationError(
                    f"A VRF named '{n}' already exists in this tenant."
                )
        return n


class SiteForm(forms.ModelForm):
    class Meta:
        model = Site
        fields = ["name", "location", "description", "gateway_policy", "vrfs"]
        widgets = {
            "name":           forms.TextInput(attrs={"class": _TEXT, "placeholder": "dc-fra-01"}),
            "location":       forms.TextInput(attrs={"class": _TEXT, "placeholder": "Frankfurt — Equinix FR4"}),
            "description":    forms.Textarea(attrs={"class": _TEXTAREA, "rows": 3}),
            "gateway_policy": forms.Select(attrs={"class": _SELECT}),
            "vrfs":           forms.SelectMultiple(attrs={"class": _SELECT, "size": 5}),
        }

    def __init__(self, *args, tenant=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.tenant = tenant
        if tenant is not None:
            self.fields["vrfs"].queryset = VRF.objects.filter(tenant=tenant)
        self.fields["vrfs"].required = False
        self.fields["vrfs"].help_text = (
            "Documentation only — which VRFs operate at this site. Not enforced."
        )

    def clean_name(self):
        n = (self.cleaned_data.get("name") or "").strip()
        if not n:
            raise forms.ValidationError("Required.")
        if self.tenant is not None:
            qs = Site.objects.filter(tenant=self.tenant, name=n)
            if self.instance and self.instance.pk:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise forms.ValidationError(
                    f"A site named '{n}' already exists in this tenant."
                )
        return n


class VLANForm(forms.ModelForm):
    class Meta:
        model = VLAN
        fields = ["vlan_id", "name", "site", "description"]
        widgets = {
            "vlan_id":     forms.NumberInput(attrs={"class": _TEXT, "min": 1, "max": 4094}),
            "name":        forms.TextInput(attrs={"class": _TEXT, "placeholder": "prod"}),
            "site":        forms.Select(attrs={"class": _SELECT}),
            "description": forms.Textarea(attrs={"class": _TEXTAREA, "rows": 3}),
        }

    def __init__(self, *args, tenant=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.tenant = tenant
        if tenant is not None:
            self.fields["site"].queryset = Site.objects.filter(tenant=tenant)
        self.fields["site"].required = False
        self.fields["site"].empty_label = "— no site —"

    def clean_vlan_id(self):
        v = self.cleaned_data.get("vlan_id")
        if v is None:
            raise forms.ValidationError("Required.")
        if v < 1 or v > 4094:
            raise forms.ValidationError("VLAN id must be between 1 and 4094.")
        if self.tenant is not None:
            qs = VLAN.objects.filter(tenant=self.tenant, vlan_id=v)
            if self.instance and self.instance.pk:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise forms.ValidationError(
                    f"VLAN {v} is already registered in this tenant."
                )
        return v


class TagForm(_ColorMixin, forms.ModelForm):
    """Tag is still tenant-global today; per-tenant scoping is Phase 5."""

    class Meta:
        model = Tag
        fields = ["name", "slug", "color"]
        widgets = {
            "name":  forms.TextInput(attrs={"class": _TEXT, "placeholder": "critical"}),
            "slug":  forms.TextInput(attrs={"class": _TEXT, "placeholder": "auto from name"}),
            "color": ColorPickerWidget(placeholder="#ef4444"),
        }

    def clean_slug(self):
        s = (self.cleaned_data.get("slug") or "").strip()
        if not s:
            s = slugify(self.cleaned_data.get("name") or "")
        qs = Tag.objects.filter(slug=s)
        if self.instance and self.instance.pk:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise forms.ValidationError("Another tag already uses that slug.")
        return s


class _LabeledChoiceForm(_ColorMixin, forms.ModelForm):
    """Shared form behaviour for Status and IPRole CRUD."""

    class Meta:
        fields = ["name", "slug", "color", "description", "weight"]
        widgets = {
            "name":        forms.TextInput(attrs={"class": _TEXT}),
            "slug":        forms.TextInput(attrs={"class": _TEXT, "placeholder": "auto from name"}),
            "description": forms.Textarea(attrs={"class": _TEXTAREA, "rows": 2}),
            "weight":      forms.NumberInput(attrs={"class": _TEXT, "placeholder": "100"}),
        }

    def __init__(self, *args, tenant=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.tenant = tenant

    def clean_slug(self):
        s = (self.cleaned_data.get("slug") or "").strip()
        if not s:
            s = slugify(self.cleaned_data.get("name") or "")
        if self.tenant is not None:
            qs = self.Meta.model.objects.filter(tenant=self.tenant, slug=s)
            if self.instance and self.instance.pk:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise forms.ValidationError(
                    f"Another {self.Meta.model._meta.verbose_name} already uses that slug."
                )
        return s


class StatusForm(_LabeledChoiceForm):
    class Meta(_LabeledChoiceForm.Meta):
        from .models import Status as _Status
        model = _Status
        fields = _LabeledChoiceForm.Meta.fields + ["is_available", "requires_note"]
        widgets = {
            **_LabeledChoiceForm.Meta.widgets,
            "color":          ColorPickerWidget(placeholder="#10b981"),
            "is_available":   forms.CheckboxInput(attrs={"class": "ck"}),
            "requires_note":  forms.CheckboxInput(attrs={"class": "ck"}),
        }


class IPRoleForm(_LabeledChoiceForm):
    class Meta(_LabeledChoiceForm.Meta):
        from .models import IPRole as _IPRole
        model = _IPRole
        fields = _LabeledChoiceForm.Meta.fields + ["is_gateway", "is_virtual", "icon"]
        widgets = {
            **_LabeledChoiceForm.Meta.widgets,
            "color":      ColorPickerWidget(placeholder="#10b981"),
            "is_gateway": forms.CheckboxInput(attrs={"class": "ck"}),
            "is_virtual": forms.CheckboxInput(attrs={"class": "ck"}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Late import to avoid pulling templatetags into form module load.
        from .templatetags.api_extras import ROLE_ICON_CHOICES
        self.fields["icon"] = forms.ChoiceField(
            label="Icon",
            required=False,
            choices=[("", "— none —")] + [(n, n) for n in ROLE_ICON_CHOICES],
            widget=forms.Select(attrs={"class": _SELECT}),
            help_text=("Lucide icon shown inside the role chip. "
                       "crown = active master, crown-off = standby, "
                       "shield-check = healthy, anchor = anycast / VIP, "
                       "router = physical interface."),
        )
        if self.instance and self.instance.pk:
            self.fields["icon"].initial = self.instance.icon


# ─── Devices ──────────────────────────────────────────────────────────────


class ManufacturerForm(forms.ModelForm):
    class Meta:
        model = Manufacturer
        fields = ["name", "slug", "url", "description"]
        widgets = {
            "name":        forms.TextInput(attrs={"class": _TEXT, "placeholder": "Cisco"}),
            "slug":        forms.TextInput(attrs={"class": _TEXT, "placeholder": "auto from name"}),
            "url":         forms.URLInput(attrs={"class": _TEXT, "placeholder": "https://"}),
            "description": forms.Textarea(attrs={"class": _TEXTAREA, "rows": 3}),
        }

    def __init__(self, *args, tenant=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.tenant = tenant

    def clean_slug(self):
        s = (self.cleaned_data.get("slug") or "").strip()
        if not s:
            s = slugify(self.cleaned_data.get("name") or "")
        if self.tenant is not None:
            qs = Manufacturer.objects.filter(tenant=self.tenant, slug=s)
            if self.instance and self.instance.pk:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise forms.ValidationError("Another manufacturer in this tenant already uses that slug.")
        return s


class DeviceTypeForm(forms.ModelForm):
    class Meta:
        model = DeviceType
        fields = ["name", "manufacturer", "model", "part_number", "u_height", "description"]
        widgets = {
            "name":         forms.TextInput(attrs={"class": _TEXT, "placeholder": "R650"}),
            "manufacturer": forms.Select(attrs={"class": _SELECT}),
            "model":        forms.TextInput(attrs={"class": _TEXT, "placeholder": "PowerEdge R650"}),
            "part_number":  forms.TextInput(attrs={"class": _TEXT, "placeholder": "210-AKLF"}),
            "u_height":     forms.NumberInput(attrs={"class": _TEXT, "min": 0, "max": 60}),
            "description":  forms.Textarea(attrs={"class": _TEXTAREA, "rows": 3}),
        }

    def __init__(self, *args, tenant=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.tenant = tenant
        if tenant is not None:
            self.fields["manufacturer"].queryset = Manufacturer.objects.filter(tenant=tenant)
        self.fields["manufacturer"].required = False
        self.fields["manufacturer"].empty_label = "— pick a manufacturer —"
        apply_tag_picker(self, self.instance)


class DeviceForm(forms.ModelForm):
    class Meta:
        model = Device
        fields = ["name", "device_type", "site", "status", "serial_number",
                  "asset_tag", "primary_ip", "description"]
        widgets = {
            "name":          forms.TextInput(attrs={"class": _TEXT, "placeholder": "core-sw-01"}),
            "device_type":   SearchableSelectWidget(placeholder="Search device types…", empty_label="— pick a device type —"),
            "site":          SearchableSelectWidget(placeholder="Search sites…", empty_label="— no site —"),
            "status":        forms.Select(attrs={"class": _SELECT}),
            "serial_number": forms.TextInput(attrs={"class": _TEXT}),
            "asset_tag":     forms.TextInput(attrs={"class": _TEXT}),
            "primary_ip":    SearchableSelectWidget(placeholder="Search assigned IPs…", empty_label="— not set —"),
            "description":   forms.Textarea(attrs={"class": _TEXTAREA, "rows": 3}),
        }

    def __init__(self, *args, tenant=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.tenant = tenant
        if tenant is not None:
            self.fields["device_type"].queryset = DeviceType.objects.filter(tenant=tenant)
            self.fields["site"].queryset = Site.objects.filter(tenant=tenant)
            # primary_ip is restricted to IPs already assigned to this device
            # (avoids picking some random IP that isn't tied to the box).
            if self.instance and self.instance.pk:
                self.fields["primary_ip"].queryset = IPAddress.objects.filter(
                    tenant=tenant, assigned_device=self.instance,
                )
            else:
                self.fields["primary_ip"].queryset = IPAddress.objects.none()
        self.fields["device_type"].required = False
        self.fields["device_type"].empty_label = "— pick a device type —"
        self.fields["site"].required = False
        self.fields["site"].empty_label = "— no site —"
        self.fields["primary_ip"].required = False
        self.fields["primary_ip"].empty_label = "— not set —"
        apply_tag_picker(self, self.instance)
