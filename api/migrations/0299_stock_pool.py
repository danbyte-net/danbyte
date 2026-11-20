# The stock pool (docs/dcim/stock.md): an inventory item can live at a site
# and location instead of on a device, a module taken out of its bay keeps
# its module type as a stock item, and the Inventory page reads one view
# over items and installed modules (api.inventory_view).
#
# Existing rows keep their device and are valid under the new one-home
# check. The status seed adds In Stock, RMA and Scrapped for inventory
# items, merging by slug (idempotent).

import django.db.models.deletion
from django.db import migrations, models

from api.inventory_view import CREATE_SQL, DROP_SQL


def seed(apps, schema_editor):
    from api.status_registry import seed_builtin_statuses

    Tenant = apps.get_model("core", "Tenant")
    Status = apps.get_model("api", "Status")
    for tenant in Tenant.objects.all():
        seed_builtin_statuses(tenant, Status=Status)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0298_port_stats_lifecycle'),
        ('core', '0068_cable_ways_mode'),
    ]

    operations = [
        migrations.CreateModel(
            name='InventoryEntry',
            fields=[
                ('id', models.UUIDField(primary_key=True, serialize=False)),
                ('source', models.CharField(max_length=16)),
                ('home', models.CharField(max_length=16)),
                ('name', models.CharField(max_length=255)),
                ('kind', models.CharField(max_length=16)),
                ('part_id', models.CharField(max_length=128)),
                ('serial_number', models.CharField(max_length=255)),
                ('asset_tag', models.CharField(max_length=128)),
                ('description', models.CharField(max_length=255)),
                ('created_at', models.DateTimeField()),
                ('updated_at', models.DateTimeField()),
            ],
            options={
                'db_table': 'api_inventory_entry',
                'managed': False,
            },
        ),
        migrations.AddField(
            model_name='inventoryitem',
            name='location',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='stock_items', to='api.location'),
        ),
        migrations.AddField(
            model_name='inventoryitem',
            name='module_type',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='stock_items', to='api.moduletype'),
        ),
        migrations.AddField(
            model_name='inventoryitem',
            name='site',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='stock_items', to='api.site'),
        ),
        migrations.AlterField(
            model_name='inventoryitem',
            name='device',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='inventory_items', to='api.device'),
        ),
        migrations.AlterField(
            model_name='inventoryitem',
            name='kind',
            field=models.CharField(choices=[('other', 'Other'), ('disk', 'Disk'), ('cpu', 'CPU'), ('ram', 'RAM'), ('psu', 'PSU'), ('fan', 'Fan'), ('gpu', 'GPU'), ('controller', 'Controller'), ('transceiver', 'Transceiver'), ('module', 'Module')], default='other', max_length=16),
        ),
        migrations.AlterField(
            model_name='inventoryitemtemplate',
            name='kind',
            field=models.CharField(choices=[('other', 'Other'), ('disk', 'Disk'), ('cpu', 'CPU'), ('ram', 'RAM'), ('psu', 'PSU'), ('fan', 'Fan'), ('gpu', 'GPU'), ('controller', 'Controller'), ('transceiver', 'Transceiver'), ('module', 'Module')], default='other', max_length=16),
        ),
        migrations.AddConstraint(
            model_name='inventoryitem',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('device__isnull', False), ('location__isnull', True), ('site__isnull', True)), models.Q(('device__isnull', True), ('site__isnull', False)), _connector='OR'), name='inventoryitem_one_home'),
        ),
        migrations.RunSQL(CREATE_SQL, DROP_SQL),
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
