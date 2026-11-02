from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0251_interface_type_vxlan"),
    ]

    operations = [
        migrations.AddField(
            model_name="panellayout",
            name="callout",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
