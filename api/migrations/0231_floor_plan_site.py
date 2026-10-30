# Site-wide floor plans: a floor plan (stack) and each of its floors name
# their site, and the location becomes optional - a site-wide plan (a campus
# map spanning many buildings) has none. Every existing row gets its
# location's site. The application requires the site (the API and the
# models' save() set it); the column stays nullable so processes still on the
# previous release can insert during an upgrade (core.tests_migration_safety)
# - their rows name a location, and site scoping falls back to its site.

import django.db.models.deletion
from django.db import migrations, models
from django.db.models import OuterRef, Subquery


def backfill_site(apps, schema_editor):
    Location = apps.get_model("api", "Location")
    site_of = Subquery(
        Location.objects.filter(pk=OuterRef("location_id")).values("site_id")[:1]
    )
    for name in ("FloorPlanStack", "FloorPlan"):
        model = apps.get_model("api", name)
        model.objects.filter(site__isnull=True).update(site_id=site_of)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0230_floor_plan_snapshots"),
    ]

    operations = [
        migrations.AddField(
            model_name="floorplanstack",
            name="site",
            field=models.ForeignKey(
                null=True, on_delete=django.db.models.deletion.CASCADE,
                related_name="floor_plan_stacks", to="api.site",
            ),
        ),
        migrations.AddField(
            model_name="floorplan",
            name="site",
            field=models.ForeignKey(
                null=True, on_delete=django.db.models.deletion.CASCADE,
                related_name="floor_plans", to="api.site",
            ),
        ),
        migrations.AlterField(
            model_name="floorplanstack",
            name="location",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.CASCADE,
                related_name="floor_plan_stacks", to="api.location",
            ),
        ),
        migrations.AlterField(
            model_name="floorplan",
            name="location",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.CASCADE,
                related_name="floor_plans", to="api.location",
            ),
        ),
        migrations.AddConstraint(
            model_name="floorplanstack",
            constraint=models.UniqueConstraint(
                condition=models.Q(location__isnull=True),
                fields=("tenant", "site", "name"),
                name="uniq_floorplanstack_tenant_site_name_sitewide",
            ),
        ),
        migrations.AddConstraint(
            model_name="floorplan",
            constraint=models.UniqueConstraint(
                condition=models.Q(stack__isnull=True, location__isnull=True),
                fields=("tenant", "site", "name"),
                name="uniq_floorplan_unstacked_site_name",
            ),
        ),
        # Last: the update leaves deferred FK checks pending, which would
        # refuse any later ALTER TABLE or CREATE INDEX on these tables.
        migrations.RunPython(backfill_site, migrations.RunPython.noop),
        # Last: the update leaves deferred FK checks pending, which would
        # refuse any later ALTER TABLE or CREATE INDEX on these tables.
        migrations.RunPython(backfill_site, migrations.RunPython.noop),
    ]
