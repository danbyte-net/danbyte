from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0046_deploymentsettings_faceplate_mark_connected_lit'),
    ]

    operations = [
        migrations.AddField(
            model_name='deploymentsettings',
            name='faceplate_group_labels',
            field=models.BooleanField(default=False, help_text="Rendered faceplates print each port group's interface prefix (Ethernet1/) in front of its cages."),
        ),
    ]
