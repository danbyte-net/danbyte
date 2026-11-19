"""Import a 3D model pack: device type and module type YAML with ``model3d:``
blocks, accessory types (plugs seated in cabled ports, api.port_plugs), and
the ``.glb`` files they name (api.model_pack, docs/dcim/model-packs.md).

    manage.py import_model_pack <folder|zip> --tenant <slug or id> [--apply]
                                [--replace-photos] [--overwrite] [--only id,id]

A bundle (bundle.yaml and packs/, api.model_pack_bundle) imports each pack
it lists in its order, each in its own transaction, with the checker's
verdict and what the pack needs printed per pack; ``--only`` picks packs.

Each YAML is matched to an existing type by manufacturer and part number;
a type that isn't there yet is created from the YAML. The matched or created
type gets the pack's model (and far model), replacing the one it had, and a
device type the pack's Blender renders as its face photos. A face uploaded
by hand stays unless ``--replace-photos`` is given. An accessory type is
matched by its folder (vendor) and name, and created or updated.

A matched device or module type's templates, bay module lists, lifecycle
and links follow the YAML; what was changed in Danbyte since the last
import is kept and reported, unless ``--overwrite`` is given
(api.model_pack_update).

A dry run by default: everything is read, checked and scanned, the report
printed, and nothing kept. ``--apply`` keeps it; the changes land in the
change log as system writes, with *Pack import: <name> <version>* as their
cause.
"""
from __future__ import annotations

import uuid
import zipfile

from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Import a 3D model pack (device/module/accessory type YAML plus .glb models)."

    def add_arguments(self, parser):
        parser.add_argument("pack", help="The pack: a folder or a .zip of one.")
        parser.add_argument("--tenant", required=True, help="Tenant slug or id.")
        parser.add_argument("--apply", action="store_true",
                            help="Keep the changes (default: a dry run).")
        parser.add_argument("--replace-photos", action="store_true",
                            help="Let the pack's renders replace face photos and port "
                                 "markers uploaded by hand.")
        parser.add_argument("--overwrite", action="store_true",
                            help="Update from pack: let the YAML replace templates, bay "
                                 "module lists and lifecycle dates changed here, and "
                                 "remove templates an import added that it dropped.")
        parser.add_argument("--only", default="",
                            help="A bundle: the pack ids to import, comma-separated "
                                 "(default: all).")

    def handle(self, *args, pack, tenant, apply=False, replace_photos=False, overwrite=False,
               only="", **opts):
        from api.model_pack import PackFiles, PackRefused, import_pack
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
        except PackRefused as exc:
            raise CommandError("The archive is refused:\n  " + "\n  ".join(exc.messages)) from exc
        except (FileNotFoundError, OSError, zipfile.BadZipFile) as exc:
            raise CommandError(f"Can't open the pack: {exc}") from exc
        try:
            if files.is_bundle:
                self._bundle(files, t, apply=apply, replace_photos=replace_photos,
                             overwrite=overwrite, only=only)
                return
            if only:
                raise CommandError("--only picks packs of a bundle; this is a pack.")
            result = import_pack(t, files, dry_run=not apply, replace_photos=replace_photos,
                                 overwrite=overwrite)
        finally:
            files.close()
        self._report(pack, result, t, apply)

    def _bundle(self, files, t, *, apply, replace_photos, overwrite, only):
        from api.model_pack import import_pack
        from api.model_pack_bundle import check_sections, read_bundle
        from api.model_pack_install import needs

        bundle = read_bundle(files)
        listed = [e.id for e in bundle.entries]
        picked = [x.strip() for x in only.split(",") if x.strip()] if only else listed
        bad = [x for x in picked if x not in listed]
        if bad:
            raise CommandError(f"Not in the bundle: {', '.join(bad)}.")
        head = bundle.meta.get("name") or str(files.source)
        if bundle.meta.get("version"):
            head += f" {bundle.meta['version']}"
        self.stdout.write(f"{head} (bundle) → {t.name}{'' if apply else ' (dry run)'}")
        for p in bundle.problems:
            self.stdout.write(f"  {p['level']}: {p['message']}")
        secs = check_sections(files, bundle, tenant=t)
        present = {s.id for s in secs if s.files is not None}
        for s in secs:
            self.stdout.write(f"\n== {s.name} {s.version}".rstrip() + f" ({s.id})")
            if s.id not in picked:
                self.stdout.write("  not picked - skipped.")
                continue
            rep = s.report
            self.stdout.write(f"  check: {rep.errors} error{'s' if rep.errors != 1 else ''}, "
                              f"{rep.warnings} warning{'s' if rep.warnings != 1 else ''}")
            for f in rep.findings:
                if f.level == "error":
                    self.stdout.write(f"    {f.path}: {f.message}")
            for n in needs(t, rep.pack.get("requires") or [], in_bundle=present - {s.id},
                           version=s.version):
                where = {"bundle": "in this bundle",
                         "installed": f"installed {n['installed'] or ''}".strip(),
                         }.get(n["state"], f"missing - get {n.get('zip')}")
                self.stdout.write(f"  needs {n['id']}: {where}")
            if s.files is None:
                self.stdout.write("  not in the archive - skipped.")
                continue
            result = import_pack(t, s.files, dry_run=not apply, replace_photos=replace_photos,
                                 overwrite=overwrite)
            self._rows(result, apply)

    def _report(self, pack, result, t, apply):
        head = result.name or pack
        if result.version:
            head += f" {result.version}"
        self.stdout.write(f"{head} → {t.name}{'' if apply else ' (dry run)'}")
        self._rows(result, apply)

    def _rows(self, result, apply):
        for tr in result.types:
            noun = tr.kind.replace("-", " ")
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
