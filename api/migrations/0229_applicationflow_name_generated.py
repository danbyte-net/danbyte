# A generated application flow's name names the hosts at its ends. The
# name_generated flag keeps that fact after the flow is detached or released
# (generated goes false), so the name stays masked for a reader who may not
# view an end (#453). Renaming the flow clears it.
#
# Backfill: every generated flow. A hand-made flow is marked when an excluded
# pair of its application carries its name (it was detached), or when its
# change log shows `generated` going false or its journal says it was kept
# after a requirement stopped applying, and no change after that renamed it.
# Nothing else is touched, so a second run changes nothing.

from django.db import migrations, models

FLOW = "api.applicationflow"


def mark_generated_names(apps, schema_editor):
    ApplicationFlow = apps.get_model("api", "ApplicationFlow")
    Exclusion = apps.get_model("api", "ApplicationFlowRequirementExclusion")
    ChangeLogEntry = apps.get_model("audit", "ChangeLogEntry")
    JournalEntry = apps.get_model("audit", "JournalEntry")

    ApplicationFlow.objects.filter(generated=True, name_generated=False).update(
        name_generated=True)

    hand = {str(pk): (name, app) for pk, name, app in ApplicationFlow.objects.filter(
        generated=False, name_generated=False, name__contains=" → ",
    ).values_list("pk", "name", "application_id")}
    if not hand:
        return
    released_at: dict = {}
    renamed_at: dict = {}
    entries = (ChangeLogEntry.objects.filter(object_type=FLOW, object_id__in=list(hand))
               .order_by("timestamp").values_list("object_id", "timestamp", "changes"))
    for oid, at, changes in entries.iterator():
        changes = changes if isinstance(changes, dict) else {}
        diff = changes.get("generated")
        if isinstance(diff, dict) and diff.get("old") is True and not diff.get("new"):
            released_at[oid] = at
        if "name" in changes:
            renamed_at[oid] = at
    excluded = set(Exclusion.objects.filter(
        label__in=[name for name, _app in hand.values()],
    ).values_list("requirement__application_id", "label"))
    for oid, at in JournalEntry.objects.filter(
        object_type=FLOW, object_id__in=list(hand),
        comments__startswith="Kept after requirement ",
    ).values_list("object_id", "created_at"):
        released_at[oid] = max(at, released_at.get(oid, at))
    mark = []
    for oid, (name, app) in hand.items():
        if (app, name) in excluded:
            # Detached: the excluded pair keeps the name it had.
            mark.append(oid)
        elif oid in released_at and (renamed_at.get(oid) is None
                                     or renamed_at[oid] <= released_at[oid]):
            mark.append(oid)
    if mark:
        ApplicationFlow.objects.filter(pk__in=mark).update(name_generated=True)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0228_floor_plan_placement"),
        ("audit", "0014_changelogentry_cause"),
    ]

    operations = [
        migrations.AddField(
            model_name="applicationflow",
            name="name_generated",
            field=models.BooleanField(db_default=False, default=False),
        ),
        migrations.RunPython(mark_generated_names, migrations.RunPython.noop),
    ]
