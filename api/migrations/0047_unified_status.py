"""Unify object status into one definable Status catalog.

Renames IPStatus → Status, adds ``available_to`` / ``default_for`` scope, and
converts the 12 enum ``status`` CharFields to ``ForeignKey(Status)``. Existing
values are backfilled (a temp column reads the old enum before it's dropped),
and built-in statuses are seeded/merged per tenant so the tenant's existing IP
"Active" becomes the shared device/prefix/… "Active" too.
"""
from __future__ import annotations

import django.db.models.deletion
from django.db import migrations, models


# (ModelName, reverse related_name, default value, object-type slug)
CONV = [
    ("Device", "devices", "active", "device"),
    ("Prefix", "prefixes", "active", "prefix"),
    ("Cable", "cables", "connected", "cable"),
    ("Cluster", "clusters", "active", "cluster"),
    ("VirtualMachine", "virtual_machines", "active", "virtualmachine"),
    ("Rack", "racks", "active", "rack"),
    ("IPRange", "ip_ranges", "active", "iprange"),
    ("Circuit", "circuits", "active", "circuit"),
    ("PowerFeed", "power_feeds", "active", "powerfeed"),
    ("WirelessLAN", "wireless_lans", "active", "wirelesslan"),
    ("Tunnel", "tunnels", "active", "tunnel"),
    ("Location", "locations", "active", "location"),
]


def seed_ip_statuses(apps, schema_editor):
    """Existing rows are the per-tenant IP-status catalog: scope them to IPs and
    carry the old ``is_default`` flag into ``default_for``."""
    Status = apps.get_model("api", "Status")
    for s in Status.objects.all():
        changed = False
        if "ipaddress" not in (s.available_to or []):
            s.available_to = (s.available_to or []) + ["ipaddress"]
            changed = True
        if getattr(s, "is_default", False) and "ipaddress" not in (s.default_for or []):
            s.default_for = (s.default_for or []) + ["ipaddress"]
            changed = True
        if changed:
            s.save()


def seed_and_link(apps, schema_editor):
    """Per tenant: ensure a shared Status row for each enum value used by the 12
    models (merging into the tenant's existing rows by slug), then point every
    object's temp FK at it."""
    from api.status_registry import BUILTIN_STATUS_COLORS

    Status = apps.get_model("api", "Status")
    Tenant = apps.get_model("core", "Tenant")

    for tenant in Tenant.objects.all():
        cache = {s.slug: s for s in Status.objects.filter(tenant=tenant)}

        def ensure(value, model_slug, is_default):
            s = cache.get(value)
            if s is None:
                s = Status.objects.create(
                    tenant=tenant,
                    name=value.replace("_", " ").title(),
                    slug=value,
                    color=BUILTIN_STATUS_COLORS.get(value, ""),
                    available_to=[],
                    default_for=[],
                )
                cache[value] = s
            changed = False
            if model_slug not in (s.available_to or []):
                s.available_to = (s.available_to or []) + [model_slug]
                changed = True
            if is_default and model_slug not in (s.default_for or []):
                s.default_for = (s.default_for or []) + [model_slug]
                changed = True
            if changed:
                s.save()
            return s

        for model_name, _related, default_value, model_slug in CONV:
            Model = apps.get_model("api", model_name)
            objs = list(Model.objects.filter(tenant=tenant))
            used = {o.status for o in objs if o.status}
            used.add(default_value)
            for value in used:
                ensure(value, model_slug, value == default_value)
            for o in objs:
                value = o.status or default_value
                o.status_tmp = ensure(value, model_slug, value == default_value)
                o.save(update_fields=["status_tmp"])


_JSON = dict(default=list, blank=True)


class Migration(migrations.Migration):

    # Non-atomic: the per-table data backfills (UPDATEs) and the following
    # schema ALTERs on the same tables can't share one transaction on Postgres
    # ("pending trigger events"). Each operation auto-commits instead.
    atomic = False

    dependencies = [
        ("api", "0046_device_airflow_device_cluster_device_comments_and_more"),
        # Renaming IPStatus must come AFTER every migration that references
        # ``api.ipstatus`` as a relation, or the graph can order them after the
        # rename and fail to resolve the (now gone) model name.
        ("monitoring", "0013_monitoringsettings_flap_exclude_ip_statuses"),
    ]

    operations = [
        # 1. Rename the catalog model + its uniqueness constraint.
        migrations.RenameModel("IPStatus", "Status"),
        migrations.AlterModelOptions(
            name="status",
            options={"ordering": ["weight", "name"], "verbose_name_plural": "statuses"},
        ),
        migrations.RemoveConstraint(model_name="status", name="uniq_ipstatus_tenant_slug"),
        # 2. Add scope, fold is_default → default_for, then drop is_default.
        migrations.AddField(
            "status", "available_to",
            models.JSONField(help_text="Object-type slugs this status can be used on (see STATUSABLE_MODELS).", **_JSON),
        ),
        migrations.AddField(
            "status", "default_for",
            models.JSONField(help_text="Object-type slugs for which this status is the default (≤1 per type).", **_JSON),
        ),
        migrations.RunPython(seed_ip_statuses, migrations.RunPython.noop),
        migrations.RemoveField("status", "is_default"),
        migrations.AlterField(
            "status", "is_available",
            models.BooleanField(
                default=False,
                help_text=("Counts this status as 'free' in utilisation maths and the "
                           "Show-available toggle (IP addresses)."),
            ),
        ),
        migrations.AddConstraint(
            model_name="status",
            constraint=models.UniqueConstraint(fields=["tenant", "slug"], name="uniq_status_tenant_slug"),
        ),
        # 3. Drop the tenant+status indexes that ride on the enum column (prefix
        #    & iprange) — they're recreated below once `status` is a FK.
        migrations.RemoveIndex(model_name="prefix", name="api_prefix_tenant__fbd674_idx"),
        migrations.RemoveIndex(model_name="iprange", name="api_iprange_tenant__8bc3ac_idx"),
        # 4. Temp FK on each of the 12 models (real value backfilled below).
        *[
            migrations.AddField(
                mn.lower(), "status_tmp",
                models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.PROTECT,
                    related_name=rel, to="api.status",
                ),
            )
            for mn, rel, _dv, _ms in CONV
        ],
        # 5. Seed/merge built-ins per tenant + backfill the temp FK from the enum.
        migrations.RunPython(seed_and_link, migrations.RunPython.noop),
        # 6. Drop the enum column, promote the FK to `status`.
        *[
            op
            for mn, _rel, _dv, _ms in CONV
            for op in (
                migrations.RemoveField(mn.lower(), "status"),
                migrations.RenameField(mn.lower(), "status_tmp", "status"),
            )
        ],
        # 7. Recreate the tenant+status indexes (now over the FK column).
        migrations.AddIndex("prefix", models.Index(fields=["tenant", "status"], name="api_prefix_tenant__8a9b52_idx")),
        migrations.AddIndex("iprange", models.Index(fields=["tenant", "status"], name="api_iprange_tenant__64a546_idx")),
    ]
