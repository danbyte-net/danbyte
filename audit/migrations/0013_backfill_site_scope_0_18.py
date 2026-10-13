"""Stamp a site on the history of the types that became site-scoped in 0.18.

Change-log and journal rows carry the object's site (``object_site_id``),
captured when written, so site-scoped readers keep their scope after the
object is gone. NULL means shared and is readable under any site-limited
grant. Rows written before 0.18 for the types below have NULL, because their
site path did not exist yet (#414), and an address in another site's prefix
had NULL when its own site was empty (#413). Left alone, a site-limited
reader would still see that history.

Each such row gets its object's site through the same paths
``auth_api.site_paths`` now uses (frozen below). A row whose object is gone
gets ``UNKNOWN_SITE``, never in any site's scope - fail closed, as 0007 did.
A row whose object exists with no site stays NULL: it is shared.

A second run changes nothing. Reverse is a no-op.
"""

import uuid

from django.db import migrations

UNKNOWN_SITE = uuid.UUID(int=0)

# Frozen copies of the 0.18 site paths for the types they added or changed.
SITE_PATHS = {
    "api.ipaddress": "site|prefix__site",
    "api.service": (
        "device__site|virtual_machine__site|ip_address__site|ip_address__prefix__site"
    ),
    "api.natrule": "device__site",
    "api.vlangroup": "site|cluster__site",
    "api.iprange": "prefix__site",
    "api.virtualchassis": "master__site",
    "api.fhrpgroupassignment": "interface__device__site|vm_interface__vm__site",
    "api.l2vpntermination": "interface__device__site|vm_interface__vm__site|vlan__site",
    "api.tunneltermination": "interface__device__site|vm_interface__vm__site",
    "api.sitemarker": "device__site",
    "api.virtualdisk": "vm__site",
    "api.virtualswitch": "cluster__site",
    "routing.redistribution": (
        "bgp_af__instance__device__site|bgp_af__instance__virtual_machine__site"
        "|ospf_instance__device__site|ospf_instance__virtual_machine__site"
        "|isis_instance__device__site|isis_instance__virtual_machine__site"
        "|eigrp_instance__device__site|eigrp_instance__virtual_machine__site"
    ),
    "integrations.deviceconfigsnapshot": "device__site",
    "integrations.deviceconfigstate": "device__site",
    "monitoring.redfishendpoint": "device__site",
    "monitoring.portutilizationrule": "device__site",
    "zabbix.zabbixhostlink": "device__site",
    "zabbix.zabbixchange": "device__site",
    "integrations.dhcpscope": "prefix__site",
    "integrations.dhcpreservation": "scope__prefix__site",
    "integrations.dhcplease": "scope__prefix__site",
    "integrations.dnsrecord": "ip_address__site|ip_address__prefix__site",
    "integrations.dnsdrift": "ip_address__site|ip_address__prefix__site",
    "integrations.virtchange": "vm__site",
    "monitoring.certificatebinding": "target_ip__site|target_ip__prefix__site",
}


def _walk(obj, path):
    parts = path.split("__")
    for part in parts[:-1]:
        obj = getattr(obj, part, None)
        if obj is None:
            return None
    return getattr(obj, f"{parts[-1]}_id", None)


def _resolve(apps, label, object_id):
    """``(site_id, exists)`` for one object."""
    try:
        model = apps.get_model(label)
        obj = model._default_manager.filter(pk=object_id).first()
    except (LookupError, TypeError, ValueError):
        return None, False
    if obj is None:
        return None, False
    for alt in SITE_PATHS[label].split("|"):
        site_id = _walk(obj, alt)
        if site_id is not None:
            return site_id, True
    return None, True


def forwards(apps, schema_editor):
    labels = list(SITE_PATHS)
    for model_name in ("ChangeLogEntry", "JournalEntry"):
        Model = apps.get_model("audit", model_name)
        cache = {}
        batch = []
        rows = Model.objects.filter(object_site_id__isnull=True, object_type__in=labels)
        for row in rows.iterator(chunk_size=1000):
            key = (row.object_type, row.object_id)
            if key not in cache:
                cache[key] = _resolve(apps, row.object_type, row.object_id)
            site_id, exists = cache[key]
            if site_id is not None:
                row.object_site_id = site_id
            elif not exists:
                row.object_site_id = UNKNOWN_SITE
            else:
                continue  # exists with no site: shared
            batch.append(row)
            if len(batch) >= 1000:
                Model.objects.bulk_update(batch, ["object_site_id"])
                batch = []
        if batch:
            Model.objects.bulk_update(batch, ["object_site_id"])


class Migration(migrations.Migration):
    dependencies = [
        ("audit", "0012_scrub_fhrp_auth_key"),
        ("api", "0205_fhrpgroup_auth_key_secret_store"),
        ("integrations", "0046_integrationsettings_oxidized_enabled"),
        ("monitoring", "0114_sla_templates"),
        ("routing", "0014_upgrade_db_defaults"),
        ("zabbix", "0017_host_status"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
