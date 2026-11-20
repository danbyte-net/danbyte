"""Move the Markdown links in device and module type descriptions to the
type's Documents (api.description_links, docs/dcim/device-catalog.md).

    manage.py description_links [--tenant <slug or id>] [--apply]

Types imported from the community device type library before the importers
took the links out carry them in the description as Markdown
(``[Data Sheet](https://…)``). For each such type the links become link
Documents (one per URL; a URL already attached is left alone), and the
description becomes the plain text - empty when it held nothing but links,
in which case a model pack's ``meta.summary`` fills it. On a type a model
pack imported, the documents made join its pack record, so the next
re-import treats them as the pack's.

A dry run by default: the report is printed and nothing is kept. ``--apply``
keeps it; the changes land in the change log as system writes with
*Description links* as their cause. Running it again finds nothing to do.
"""
from __future__ import annotations

import uuid

from django.core.management.base import BaseCommand, CommandError

CAUSE = "Description links"
#: A description that may hold a link; split() decides.
LINKISH = r"\]\(|<https?://"


def convert(obj) -> dict | None:
    """Convert one type. None when its description holds no link."""
    from api.description_links import link_rows, split
    from api.model_pack_update import Report, apply_links, apply_summary

    plain, links = split(obj.description or "")
    if not links:
        return None
    report, notes = Report(), []
    made = apply_links(obj, {}, {}, overwrite=False, report=report, notes=notes,
                       extra=link_rows(links))
    obj.description = plain
    fields = ["description", "updated_at"]
    state = obj.pack_state if isinstance(obj.pack_state, dict) else None
    summary = None
    if state is not None:
        prev = state.get("links") if isinstance(state.get("links"), dict) else {}
        state = {**state, "links": {**prev, **made}} if made else dict(state)
        meta = state.get("meta") if isinstance(state.get("meta"), dict) else {}
        summary, _ = apply_summary(obj, meta, state.get("description"), Report())
        if summary is not None:
            state["description"] = summary
        obj.pack_state = state
        fields.append("pack_state")
    obj.save(update_fields=fields)
    return {"links": len(links), "added": report.added, "description": obj.description,
            "summary": summary is not None and obj.description == summary,
            "notes": notes}


class Command(BaseCommand):
    help = ("Move Markdown links in device and module type descriptions to link "
            "documents (a dry run unless --apply).")

    def add_arguments(self, parser):
        parser.add_argument("--tenant", default="", help="Tenant slug or id (default: all).")
        parser.add_argument("--apply", action="store_true",
                            help="Keep the changes (default: a dry run).")

    def handle(self, *args, tenant="", apply=False, **opts):
        from django.db import transaction

        from api.models import DeviceType, ModuleType
        from audit.context import cause
        from core.models import Tenant

        tenants = Tenant.objects.all()
        if tenant:
            try:
                uuid.UUID(str(tenant))
                tenants = tenants.filter(id=tenant)
            except ValueError:
                tenants = tenants.filter(slug=tenant)
            if not tenants.exists():
                raise CommandError(f"No tenant {tenant!r}.")
        totals = {"types": 0, "links": 0, "added": 0, "emptied": 0}
        with cause(CAUSE), transaction.atomic():
            for model, noun in ((DeviceType, "device type"), (ModuleType, "module type")):
                rows = (model.objects.filter(tenant__in=tenants, description__regex=LINKISH)
                        .select_related("tenant").order_by("tenant__slug", "name"))
                for obj in rows:
                    done = convert(obj)
                    if done is None:
                        continue
                    totals["types"] += 1
                    totals["links"] += done["links"]
                    totals["added"] += done["added"]
                    totals["emptied"] += not obj.description
                    text = (f"from the summary: {done['description']!r}" if done["summary"]
                            else repr(done["description"]) if done["description"]
                            else "empty")
                    self.stdout.write(
                        f"{obj.tenant.slug}: {noun} {obj.name}: {done['links']} link(s), "
                        f"{done['added']} document(s) added; description {text}")
                    for note in done["notes"]:
                        self.stdout.write(f"  {note}")
            if not apply:
                transaction.set_rollback(True)
        verb = "Converted" if apply else "Would convert"
        self.stdout.write(
            f"{verb} {totals['types']} type(s): {totals['links']} link(s), "
            f"{totals['added']} document(s) added, {totals['emptied']} description(s) "
            f"left empty." + ("" if apply else " Dry run - nothing kept; --apply keeps it."))
