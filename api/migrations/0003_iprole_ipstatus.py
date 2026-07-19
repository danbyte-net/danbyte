"""Replace IPAddress.status / role CharFields with tenant-managed FK catalogs.

One migration that:
  1. Creates IPRole and IPStatus tables.
  2. Adds temporary FK columns ``status_new`` and ``role_new`` on IPAddress.
  3. Walks every IPAddress per tenant, lazily creating IPStatus / IPRole rows
     for the role / status strings actually in use, and re-points each IP to
     the new FK. "assigned" is intentionally renamed to "Active" here — per
     user request: it reads better than "Assigned" for an IP that's live.
  4. Drops the old CharFields, renames status_new → status, role_new → role.
  5. Tightens status so it's non-nullable (every IP must have a status).
"""
from __future__ import annotations

import uuid

from django.db import migrations, models
from django.utils.text import slugify


# Friendly label / colour / weight per default status. Used during the data
# migration so existing rows get sensible swatches. Operators can edit them
# all they want afterwards.
STATUS_PRESETS = {
    # old_value: (new_name, color,    weight, is_default, is_available)
    "assigned":  ("Active",       "#10b981", 10,  True,  False),
    "reserved":  ("Reserved",     "#f59e0b", 20,  False, False),
    "dhcp_pool": ("DHCP",         "#3b82f6", 30,  False, False),
    "floating":  ("Floating",     "#8b5cf6", 40,  False, False),
    "available": ("Available",    "#a1a1aa", 50,  False, True),
}

# Default extra statuses created on first migration so every tenant starts
# with a useful catalog. Tenants can drop or rename freely.
EXTRA_STATUSES = [
    ("Planned",         "#a855f7", 22, False, False),
    ("Decommissioned",  "#71717a", 60, False, False),
    ("For testing",     "#06b6d4", 35, False, False),
]

ROLE_PRESETS = {
    # old_value:    (new_name,    color,     weight, is_gateway)
    "gateway":      ("Gateway",   "#10b981", 10,  True),
    "loopback":     ("Loopback",  "#3b82f6", 20,  False),
    "vip":          ("VIP",       "#f59e0b", 30,  False),
    "hsrp":         ("HSRP",      "#a855f7", 40,  False),
    "vrrp":         ("VRRP",      "#8b5cf6", 50,  False),
    "anycast":      ("Anycast",   "#06b6d4", 60,  False),
    "secondary":    ("Secondary", "#71717a", 70,  False),
}


def migrate_data(apps, schema_editor):
    Tenant = apps.get_model("core", "Tenant")
    IPAddress = apps.get_model("api", "IPAddress")
    IPStatus = apps.get_model("api", "IPStatus")
    IPRole = apps.get_model("api", "IPRole")

    for tenant in Tenant.objects.all():
        status_map: dict[str, object] = {}
        # Seed the presets each tenant's rows actually use, AND the three extra
        # statuses the user explicitly asked for (Planned, Decommissioned, For testing).
        used_statuses = set(
            IPAddress.objects.filter(tenant=tenant)
            .values_list("status", flat=True)
            .distinct()
        )
        for old, (name, color, weight, is_default, is_avail) in STATUS_PRESETS.items():
            if old not in used_statuses:
                continue
            obj, _ = IPStatus.objects.get_or_create(
                tenant=tenant,
                slug=slugify(name),
                defaults={
                    "id": uuid.uuid4(),
                    "name": name,
                    "color": color,
                    "weight": weight,
                    "is_default": is_default,
                    "is_available": is_avail,
                },
            )
            status_map[old] = obj

        for name, color, weight, is_default, is_avail in EXTRA_STATUSES:
            IPStatus.objects.get_or_create(
                tenant=tenant,
                slug=slugify(name),
                defaults={
                    "id": uuid.uuid4(),
                    "name": name,
                    "color": color,
                    "weight": weight,
                    "is_default": is_default,
                    "is_available": is_avail,
                },
            )

        # If the tenant had no rows yet, still seed at least an Active default
        # so future IP creates have a status to fall back to.
        if not status_map:
            obj, _ = IPStatus.objects.get_or_create(
                tenant=tenant,
                slug="active",
                defaults={
                    "id": uuid.uuid4(),
                    "name": "Active",
                    "color": "#10b981",
                    "weight": 10,
                    "is_default": True,
                    "is_available": False,
                },
            )
            status_map["assigned"] = obj

        role_map: dict[str, object] = {}
        used_roles = set(
            IPAddress.objects.filter(tenant=tenant)
            .exclude(role="")
            .values_list("role", flat=True)
            .distinct()
        )
        for old, (name, color, weight, is_gw) in ROLE_PRESETS.items():
            if old not in used_roles:
                continue
            obj, _ = IPRole.objects.get_or_create(
                tenant=tenant,
                slug=slugify(name),
                defaults={
                    "id": uuid.uuid4(),
                    "name": name,
                    "color": color,
                    "weight": weight,
                    "is_gateway": is_gw,
                },
            )
            role_map[old] = obj

        # Re-point every IPAddress.
        for ip in IPAddress.objects.filter(tenant=tenant):
            ip.status_new = status_map.get(ip.status) or status_map.get("assigned")
            ip.role_new = role_map.get(ip.role) if ip.role else None
            ip.save(update_fields=["status_new", "role_new"])


def reverse_noop(apps, schema_editor):
    # We never reverse this — rolling back drops the new tables outright.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0002_initial"),
        ("core", "0001_initial"),
    ]

    operations = [
        # ─── New catalog tables ───
        migrations.CreateModel(
            name="IPStatus",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=64)),
                ("slug", models.SlugField(max_length=80)),
                ("color", models.CharField(blank=True, default="", max_length=7)),
                ("description", models.TextField(blank=True)),
                ("weight", models.PositiveIntegerField(default=100,
                    help_text="Lower weights sort first in dropdowns and lists.")),
                ("is_default", models.BooleanField(default=False,
                    help_text="Used as the default when no status is picked (only one per tenant).")),
                ("is_available", models.BooleanField(default=False,
                    help_text="Counts this status as 'free' in utilisation maths and the Show-available toggle.")),
                ("tenant", models.ForeignKey(on_delete=models.CASCADE, to="core.tenant")),
            ],
            options={"ordering": ["weight", "name"], "abstract": False},
        ),
        migrations.AddConstraint(
            model_name="IPStatus",
            constraint=models.UniqueConstraint(fields=["tenant", "slug"],
                                               name="uniq_ipstatus_tenant_slug"),
        ),
        migrations.CreateModel(
            name="IPRole",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=64)),
                ("slug", models.SlugField(max_length=80)),
                ("color", models.CharField(blank=True, default="", max_length=7)),
                ("description", models.TextField(blank=True)),
                ("weight", models.PositiveIntegerField(default=100,
                    help_text="Lower weights sort first in dropdowns and lists.")),
                ("is_gateway", models.BooleanField(default=False,
                    help_text="Mark IPs with this role as the parent prefix's gateway, and use it for the gateway autospawn flow on prefix create.")),
                ("tenant", models.ForeignKey(on_delete=models.CASCADE, to="core.tenant")),
            ],
            options={"ordering": ["weight", "name"], "abstract": False},
        ),
        migrations.AddConstraint(
            model_name="IPRole",
            constraint=models.UniqueConstraint(fields=["tenant", "slug"],
                                               name="uniq_iprole_tenant_slug"),
        ),

        # ─── Temporary FK columns on IPAddress ───
        migrations.AddField(
            model_name="ipaddress",
            name="status_new",
            field=models.ForeignKey(null=True, blank=True, on_delete=models.PROTECT,
                                    related_name="ips_pending", to="api.ipstatus"),
        ),
        migrations.AddField(
            model_name="ipaddress",
            name="role_new",
            field=models.ForeignKey(null=True, blank=True, on_delete=models.SET_NULL,
                                    related_name="ips", to="api.iprole"),
        ),

        # ─── Walk every tenant + IP and migrate ───
        migrations.RunPython(migrate_data, reverse_noop),

        # ─── Drop the old CharFields ───
        migrations.RemoveField(model_name="ipaddress", name="status"),
        migrations.RemoveField(model_name="ipaddress", name="role"),

        # ─── Rename the new FKs to take the old names ───
        migrations.RenameField(model_name="ipaddress",
                               old_name="status_new", new_name="status"),
        migrations.RenameField(model_name="ipaddress",
                               old_name="role_new", new_name="role"),

        # ─── Tighten related_name on the renamed status FK + drop nullability. ───
        migrations.AlterField(
            model_name="ipaddress",
            name="status",
            field=models.ForeignKey(
                help_text="Operational status — pick from your tenant's status catalog.",
                null=True, on_delete=models.PROTECT, related_name="ips",
                to="api.ipstatus",
            ),
        ),
        migrations.AlterField(
            model_name="ipaddress",
            name="role",
            field=models.ForeignKey(
                help_text="Optional functional role (gateway, VIP, loopback, …).",
                blank=True, null=True, on_delete=models.SET_NULL,
                related_name="ips", to="api.iprole",
            ),
        ),
    ]
