"""Import a 3D model pack: device type and module type YAML with ``model3d:``
blocks, and the ``.glb`` files they name (api.model_pack,
docs/dcim/model-packs.md).

    manage.py import_model_pack <folder|zip> --tenant <slug or id> [--apply]
                                [--replace-photos]

Each YAML is matched to an existing type by manufacturer and part number;
a type that isn't there yet is created from the YAML. The matched or created
type gets the pack's model (and far model), replacing the one it had, and a
device type the pack's Blender renders as its face photos. A face uploaded
by hand stays unless ``--replace-photos`` is given.

A dry run by default: everything is read, checked and scanned, the report
printed, and nothing kept. ``--apply`` keeps it; the changes land in the
change log as system writes, with the pack named as their cause.
"""
from __future__ import annotations

import uuid

from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Import a 3D model pack (device/module type YAML plus .glb models)."

    def add_arguments(self, parser):
        parser.add_argument("pack", help="The pack: a folder or a .zip of one.")
        parser.add_argument("--tenant", required=True, help="Tenant slug or id.")
        parser.add_argument("--apply", action="store_true",
                            help="Keep the changes (default: a dry run).")
        parser.add_argument("--replace-photos", action="store_true",
                            help="Let the pack's renders replace face photos and port "
                                 "markers uploaded by hand.")

    def handle(self, *args, pack, tenant, apply=False, replace_photos=False, **opts):
        from api.model_pack import PackFiles, import_pack
        from core.models import Tenant

        try:
            uuid.UUID(str(tenant))
            t = Tenant.objects.filter(id=tenant).first()
        except ValueError:
            t = Tenant.objects.filter(slug=tenant).first()
        if t is None:
            raise CommandError(f"No tenant {tenant!r}.")
        try:
            files = PackFiles(pack)
        except (FileNotFoundError, OSError) as exc:
            raise CommandError(f"Can't open the pack: {exc}") from exc
        try:
            result = import_pack(t, files, dry_run=not apply, replace_photos=replace_photos)
        finally:
            files.close()
        head = result.name or pack
        if result.version:
            head += f" {result.version}"
        self.stdout.write(f"{head} → {t.name}{'' if apply else ' (dry run)'}")
        for tr in result.types:
            noun = "module type" if tr.kind == "module-type" else "device type"
            self.stdout.write(f"\n{noun} {tr.name or tr.path}: {tr.action} ({tr.path})")
            for note in tr.notes:
                self.stdout.write(f"  - {note}")
        if result.unused_models:
            self.stdout.write("\nModels no YAML names (not imported):")
            for name in result.unused_models:
                self.stdout.write(f"  - {name}")
        made = sum(1 for tr in result.types if tr.action == "created")
        matched = sum(1 for tr in result.types if tr.action == "matched")
        tail = (f"\n{matched} matched, {made} created, {result.errors} skipped"
                f"{'' if apply else ' - dry run, nothing kept; --apply to import'}.")
        self.stdout.write(tail)
