"""One switch per hypervisor instead of one for "virtualization" (#51).

An install running both Proxmox VE and vCenter could only stop syncing them
together. Splitting the toggle is only safe if an upgrade is a no-op for
everyone who already had it on, so that is exactly what ``_carry_over``
does: both new switches inherit the old value, then the old column goes.
"""

from django.db import migrations, models


def carry_over(apps, schema_editor):
    """Whatever the combined switch said, both hypervisors now say."""
    Settings = apps.get_model("integrations", "IntegrationSettings")
    Settings.objects.filter(virtualization_enabled=True).update(
        virt_proxmox_enabled=True, virt_vcenter_enabled=True
    )


def back_out(apps, schema_editor):
    """Reverse: the combined switch is on if either hypervisor was."""
    Settings = apps.get_model("integrations", "IntegrationSettings")
    Settings.objects.filter(
        models.Q(virt_proxmox_enabled=True) | models.Q(virt_vcenter_enabled=True)
    ).update(virtualization_enabled=True)


class Migration(migrations.Migration):
    dependencies = [
        ("integrations", "0039_integrationsettings_ai_chat_enabled"),
    ]

    operations = [
        migrations.AddField(
            model_name="integrationsettings",
            name="virt_proxmox_enabled",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="integrationsettings",
            name="virt_vcenter_enabled",
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(carry_over, back_out),
        migrations.RemoveField(
            model_name="integrationsettings",
            name="virtualization_enabled",
        ),
    ]
