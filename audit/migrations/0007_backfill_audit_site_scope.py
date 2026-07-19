"""Repair site metadata on databases that already applied audit.0005.

The v0.8.3 implementation changed 0005 after v0.8.2 had shipped, so upgraded
databases never ran its fail-closed backfill. This forward migration repairs
those rows without rewriting migration history.
"""

import uuid

from django.db import migrations


UNKNOWN_SITE = uuid.UUID(int=0)

# Frozen copies of the site paths that existed when this migration shipped.
SITE_PATHS = {
    "device": "site",
    "prefix": "site",
    "vlan": "site",
    "ipaddress": "site",
    "rack": "site",
    "cluster": "site",
    "virtualmachine": "site",
    "powerpanel": "site",
    "location": "site",
    "powerfeed": "power_panel__site",
    "interface": "device__site",
    "frontport": "device__site",
    "rearport": "device__site",
    "vminterface": "vm__site",
    "site": "id",
    "sitesettings": "site",
}

CATALOG_SITE_PATHS = {
    "tag": "owning_site",
    "devicetype": "owning_site",
    "manufacturer": "owning_site",
    "status": "owning_site",
    "iprole": "owning_site",
    "vrf": "owning_site",
    "routetarget": "owning_site",
    "customfield": "owning_site",
    "customfieldgroup": "owning_site",
    "zone": "owning_site",
}


def _separation_checker(apps):
    DeploymentSettings = apps.get_model("core", "DeploymentSettings")
    TenantSettings = apps.get_model("core", "TenantSettings")
    deployment = DeploymentSettings.objects.order_by("pk").first()
    deployment_enabled = bool(
        deployment and deployment.enhanced_site_separation
    )
    cache = {}

    def enabled(tenant_id):
        if tenant_id is None:
            return deployment_enabled
        if tenant_id not in cache:
            row = TenantSettings.objects.filter(tenant_id=tenant_id).first()
            cache[tenant_id] = (
                bool(row.enhanced_site_separation)
                if row is not None and row.override_separation
                else deployment_enabled
            )
        return cache[tenant_id]

    return enabled


def _resolve(row, apps, separation_enabled):
    slug = row.object_type.rsplit(".", 1)[-1].lower()
    path = SITE_PATHS.get(slug)
    catalog_path = CATALOG_SITE_PATHS.get(slug)
    if path is None and catalog_path is None:
        return None, True, False

    try:
        model = apps.get_model(row.object_type)
        obj = model._default_manager.filter(pk=row.object_id).first()
    except (LookupError, TypeError, ValueError):
        obj = None

    tenant_id = getattr(obj, "tenant_id", None) if obj is not None else row.tenant_id
    if catalog_path is not None:
        is_site_bound = separation_enabled(tenant_id)
        path = catalog_path
    else:
        is_site_bound = True

    if obj is None:
        return None, False, is_site_bound
    if not is_site_bound:
        return None, True, False
    if path == "id":
        return obj.pk, True, True

    current = obj
    for part in path.split("__")[:-1]:
        current = getattr(current, part, None)
        if current is None:
            return None, True, True
    site_id = getattr(current, f"{path.split('__')[-1]}_id", None)
    return site_id, True, True


def backfill_site_scope(apps, schema_editor):
    separation_enabled = _separation_checker(apps)
    for model_name in ("ChangeLogEntry", "JournalEntry"):
        Model = apps.get_model("audit", model_name)
        cache = {}
        batch = []
        rows = Model.objects.filter(object_site_id__isnull=True)
        for row in rows.iterator(chunk_size=1000):
            key = (row.object_type, row.object_id, row.tenant_id)
            if key not in cache:
                cache[key] = _resolve(row, apps, separation_enabled)
            site_id, object_exists, is_site_bound = cache[key]
            if site_id is not None:
                row.object_site_id = site_id
            elif not object_exists and is_site_bound:
                row.object_site_id = UNKNOWN_SITE
            else:
                continue
            batch.append(row)
            if len(batch) >= 1000:
                Model.objects.bulk_update(batch, ["object_site_id"])
                batch = []
        if batch:
            Model.objects.bulk_update(batch, ["object_site_id"])


class Migration(migrations.Migration):
    dependencies = [
        ("audit", "0006_scrub_webhook_headers"),
        ("core", "0020_tag_tenant_data"),
        ("customization", "0005_customfield_owning_site_customfieldgroup_owning_site"),
    ]

    operations = [
        migrations.RunPython(backfill_site_scope, migrations.RunPython.noop),
    ]
