"""Assign every legacy (global) tag to the tenant(s) actually using it.

Tags predate tenant scoping — one taggit table served every tenant, leaking
tag names across them. This stamps each tag with the tenant of its tagged
objects; a tag used by SEVERAL tenants is cloned per extra tenant and that
tenant's TaggedItems re-pointed, so nobody loses a tag and nobody keeps
seeing another tenant's. Tags with no usage stay ``tenant=NULL``
(legacy-global: readable everywhere, writable by superusers only).

Idempotent — only touches ``tenant IS NULL`` rows. Irreversible by design
(the clone/re-point cannot be safely undone).
"""
from django.db import migrations

# Models tenant-scoped through a parent relation (no own tenant column).
_PARENT_TENANT = {
    "interface": "device__tenant_id",
    "frontport": "device__tenant_id",
    "rearport": "device__tenant_id",
    "consoleport": "device__tenant_id",
    "consoleserverport": "device__tenant_id",
    "powerport": "device__tenant_id",
    "poweroutlet": "device__tenant_id",
    "vminterface": "vm__tenant_id",
}


def _tenant_of(apps, ct, object_id):
    try:
        model = apps.get_model(ct.app_label, ct.model)
    except LookupError:
        return None
    if any(f.name == "tenant" for f in model._meta.fields):
        path = "tenant_id"
    else:
        path = _PARENT_TENANT.get(ct.model)
        if path is None:
            return None
    return (
        model.objects.filter(pk=object_id).values_list(path, flat=True).first()
    )


def assign_tenants(apps, schema_editor):
    Tag = apps.get_model("core", "Tag")
    TaggedItem = apps.get_model("core", "TaggedItem")

    for tag in Tag.objects.filter(tenant__isnull=True).iterator():
        items_by_tenant: dict = {}
        for item in TaggedItem.objects.filter(tag=tag).select_related("content_type"):
            t_id = _tenant_of(apps, item.content_type, item.object_id)
            if t_id is not None:
                items_by_tenant.setdefault(t_id, []).append(item.pk)
        if not items_by_tenant:
            continue  # unused → stays legacy-global
        first, *rest = sorted(items_by_tenant, key=str)
        tag.tenant_id = first
        tag.save(update_fields=["tenant"])
        for t_id in rest:
            clone = Tag.objects.create(
                name=tag.name, slug=tag.slug, color=tag.color, tenant_id=t_id
            )
            TaggedItem.objects.filter(pk__in=items_by_tenant[t_id]).update(
                tag=clone
            )


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0019_tag_owning_site_tag_tenant_alter_tag_name_and_more"),
        ("contenttypes", "0002_remove_content_type_name"),
    ]

    operations = [migrations.RunPython(assign_tenants, migrations.RunPython.noop)]
