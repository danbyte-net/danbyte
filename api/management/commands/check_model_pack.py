"""Check a 3D model pack the way Danbyte's review does (api.model_pack_check,
docs/dcim/model-packs.md#checking-a-pack).

    manage.py check_model_pack <folder|zip> [--json] [--tenant <slug or id>]

A bundle (bundle.yaml and packs/, api.model_pack_bundle) is checked pack by
pack in its order, with the bundle's own problems first; it fails when any
pack, or the bundle, has an error.

Prints a table per type (triangles, size, bays, ports, LEDs, problems) and
every finding; exits 1 when there is an error, 0 otherwise (warnings don't
fail). ``--json`` prints the report as JSON for CI. Nothing is written, and
the database is read only with ``--tenant``: a render's module part number
may then be a module type the tenant already has.
"""
from __future__ import annotations

import json
import sys
import uuid

from django.core.management.base import BaseCommand, CommandError


def _mb(n):
    return "" if n is None else f"{n / (1024 * 1024):.2f}"


def _num(n):
    return "" if n is None else f"{n:,}"


class Command(BaseCommand):
    help = "Check a 3D model pack (folder or .zip) against the export spec."

    def add_arguments(self, parser):
        parser.add_argument("pack", help="The pack: a folder or a .zip of one.")
        parser.add_argument("--json", action="store_true", help="Print the report as JSON.")
        parser.add_argument("--tenant", help="Also find render modules among this tenant's "
                                             "module types (slug or id).")

    def handle(self, *args, pack, json=False, tenant=None, **opts):
        from pathlib import Path

        from api.model_pack_check import check_source

        if not Path(pack).exists():
            raise CommandError(f"No such folder or file: {pack}")
        t = self._tenant(tenant) if tenant else None
        if self._bundle(pack, t, json):
            return
        report = check_source(pack, tenant=t)
        if json:
            self.stdout.write(_dumps(report.to_dict()))
        else:
            self._table(pack, report)
        if not report.ok:
            sys.exit(1)

    def _bundle(self, pack, tenant, as_json) -> bool:
        """Check a bundle; False when ``pack`` isn't one."""
        import zipfile

        from api.model_pack import PackFiles, PackRefused
        from api.model_pack_bundle import check_sections, read_bundle

        try:
            files = PackFiles(pack)
        except (PackRefused, zipfile.BadZipFile, OSError):
            return False  # check_source reports it
        try:
            if not files.is_bundle:
                return False
            bundle = read_bundle(files)
            for p in files.refusals():
                bundle.problem("error", p)
            secs = check_sections(files, bundle, tenant=tenant)
        finally:
            files.close()
        failed = any(p["level"] == "error" for p in bundle.problems) or any(
            not s.report.ok for s in secs)
        if as_json:
            self.stdout.write(_dumps({
                "ok": not failed, "bundle": bundle.meta, "problems": bundle.problems,
                "packs": [{"id": s.id, "name": s.name, "version": s.version,
                           "report": s.report.to_dict()} for s in secs]}))
        else:
            head = bundle.meta.get("name") or pack
            if bundle.meta.get("version"):
                head += f" {bundle.meta['version']}"
            self.stdout.write(f"{head} (bundle of {len(secs)} pack"
                              f"{'s' if len(secs) != 1 else ''})")
            for p in bundle.problems:
                self.stdout.write(f"  {p['level']}: {p['message']}")
            for s in secs:
                self.stdout.write(f"\n== {s.id}")
                self._table(s.id, s.report)
            self.stdout.write(f"\nBundle: {'FAILED' if failed else 'OK'}.")
        if failed:
            sys.exit(1)
        return True

    def _tenant(self, ref):
        from core.models import Tenant

        try:
            uuid.UUID(str(ref))
            t = Tenant.objects.filter(id=ref).first()
        except ValueError:
            t = Tenant.objects.filter(slug=ref).first()
        if t is None:
            raise CommandError(f"No tenant {ref!r}.")
        return t

    def _table(self, pack, report):
        meta = report.pack
        head = meta.get("name") or pack
        if meta.get("version"):
            head += f" {meta['version']}"
        self.stdout.write(head)
        cols = ("part", "kind", "triangles", "far", "MB", "far MB", "bays", "ports", "LEDs",
                "errors", "warnings")
        rows = [(p.part or p.path, "module" if p.kind == "module-type" else "device",
                 _num(p.triangles), _num(p.far_triangles), _mb(p.bytes), _mb(p.far_bytes),
                 str(p.bays), str(p.ports), str(p.leds), str(p.errors), str(p.warnings))
                for p in report.parts]
        widths = [max(len(c), *(len(r[i]) for r in rows)) if rows else len(c)
                  for i, c in enumerate(cols)]
        right = {2, 3, 4, 5, 6, 7, 8, 9, 10}

        def line(vals):
            return "  ".join(v.rjust(w) if i in right else v.ljust(w)
                             for i, (v, w) in enumerate(zip(vals, widths, strict=True)))

        self.stdout.write("")
        self.stdout.write(line(cols))
        self.stdout.write(line(["-" * w for w in widths]))
        for r in rows:
            self.stdout.write(line(r))
        for level in ("error", "warning"):
            found = [f for f in report.findings if f.level == level]
            if found:
                self.stdout.write(f"\n{level.capitalize()}s:")
                for f in found:
                    self.stdout.write(f"  {f.path}: {f.message}")
        verdict = "OK" if report.ok else "FAILED"
        self.stdout.write(f"\n{verdict}: {report.errors} error{'s' if report.errors != 1 else ''}"
                          f", {report.warnings} warning{'s' if report.warnings != 1 else ''}.")


def _dumps(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)
