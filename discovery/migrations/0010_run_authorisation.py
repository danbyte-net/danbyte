from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('discovery', '0009_inventory_links'),
    ]

    operations = [
        migrations.AddField(
            model_name='inventoryrun',
            name='authorisation',
            field=models.TextField(blank=True, db_default='', default=''),
        ),
        migrations.AddField(
            model_name='inventoryrun',
            name='authorised_by_name',
            field=models.CharField(blank=True, db_default='', default='', max_length=150),
        ),
    ]
