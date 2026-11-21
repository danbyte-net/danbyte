"""Catch components up with their templates (docs/dcim/model-packs.md →
What a re-import changes).

    manage.py sync_type_components --tenant <slug or id> [--type <part number>]
                                   [--field type,poe_type] [--force] [--apply]

A pack import carries a changed template field to the components the
template made (api.model_pack_components). Templates an earlier import
changed, before it did, left their devices' and installed modules' ports
with the old value. This applies the same rule against the current
templates: a component whose field differs from its template and equals a
value the template held before - read from the template's change log -
takes the template's value; one holding any other value was edited here and
is kept. Where the change log has no earlier value for that template field,
the components are listed and only ``--force`` updates them. Descriptions,
enabled and references are left alone.

A dry run by default; ``--apply`` keeps it, audited with *Sync type
components* as the cause.
"""
from __future__ import annotations

import uuid

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction


class Command(BaseCommand):
    help = "Bring device and module components in line with their types' current templates."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", required=True, help="Tenant slug or id.")
        parser.add_argument("--type", default="", dest="part",
                            help="Only the device or module types with this part number "
                                 "(or model name).")
        parser.add_argument("--field", default="",
                            help="Only these fields, comma-separated (e.g. type,poe_type).")
        parser.add_argument("--force", action="store_true",
                            help="Also update components whose template field has no "
                                 "earlier value in the change log.")
        parser.add_argument("--apply", action="store_true",
                            help="Keep the changes (default: a dry run).")

    def handle(self, *args, tenant, part="", field="", force=False, apply=False, **opts):
        from django.db.models import Q

        from api.model_pack_components import apply as write
        from api.model_pack_components import catch_up_changes, notes, plan
        from api.models import DeviceType, ModuleType
        from audit.context import cause
        from core.models import Tenant

        try:
            uuid.UUID(str(tenant))
            t = Tenant.objects.filter(id=tenant).first()
        except ValueError:
            t = Tenant.objects.filter(slug=tenant).first()
        if t is None:
            raise CommandError(f"No tenant {tenant!r}.")
        only = {f.strip() for f in field.split(",") if f.strip()} or None
        types = []
        for model, module in ((DeviceType, False), (ModuleType, True)):
            qs = model.objects.filter(tenant=t)
            if part:
                qs = qs.filter(Q(part_number__iexact=part) | Q(name__iexact=part))
            types += [(o, module) for o in qs.order_by("part_number")]
        if part and not types:
            raise CommandError(f"No device or module type {part!r} in {t.slug}.")
        total = unknown = 0
        # A dry run only reads: the plan is worked out without writing.
        with cause("Sync type components"), transaction.atomic():
            for obj, module in types:
                p = plan(obj, catch_up_changes(obj, module=module, only=only),
                         module=module, force=force)
                lines = notes(p)
                if not lines:
                    continue
                noun = "module type" if module else "device type"
                self.stdout.write(f"{noun} {obj.part_number or obj}:")
                for line in lines:
                    self.stdout.write(f"  {line}")
                unknown += sum(len(v) for v in p.unknown.values())
                total += write(p) if apply else p.count
        if unknown and not force:
            self.stdout.write("--force also updates the ones with no earlier value known.")
        if apply:
            self.stdout.write(f"Updated {total} component(s).")
        else:
            self.stdout.write(f"Dry run: {total} component(s) would change. --apply keeps it.")
