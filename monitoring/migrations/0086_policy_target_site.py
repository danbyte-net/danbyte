"""``site`` is the owning site everywhere else in Danbyte, and the separation
stamper fills one in for a single-site creator - so a policy's *target* site
needs a different name, or every site-scoped admin's policy comes out stamped
and then fails its own visibility check.

Hand-written: the autodetector asks about a rename interactively, and answering
"no" would drop the column and add another.
"""
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0163_status_monitoring_state"),
        ("monitoring", "0085_policy_site_region_platform"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="monitoringpolicy", name="uniq_monitoringpolicy_site",
        ),
        migrations.RenameField(
            model_name="monitoringpolicy",
            old_name="site",
            new_name="target_site",
        ),
        migrations.AlterField(
            model_name="monitoringpolicy",
            name="target_site",
            field=models.ForeignKey(
                blank=True, null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="monitoring_policies", to="api.site",
            ),
        ),
        migrations.AddConstraint(
            model_name="monitoringpolicy",
            constraint=models.UniqueConstraint(
                condition=models.Q(("target_site__isnull", False)),
                fields=("tenant", "scope", "target_site"),
                name="uniq_monitoringpolicy_site",
            ),
        ),
    ]
