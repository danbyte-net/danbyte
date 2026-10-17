"""List rack and cable rows stored before the rules of #375-#378 that break
them. Read-only: it changes nothing, so an operator can decide row by row.

    manage.py check_dcim_integrity [--tenant <slug>]

Reports devices over each other in a rack (a full-depth device takes both
faces), devices outside their rack's units, racked devices at a different
site than their rack, devices whose location is in another site, cables
with an empty end, and cables whose ends do not plug into each other.
"""
from __future__ import annotations

from collections import defaultdict

from django.core.management.base import BaseCommand, CommandError
from django.db.models import F


class Command(BaseCommand):
    help = "List racked devices and cables that break the placement and cabling rules."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", help="Only this tenant (slug).")

    def handle(self, *args, **opts):
        from core.models import Tenant

        tenants = Tenant.objects.order_by("slug")
        if opts.get("tenant"):
            tenants = tenants.filter(slug=opts["tenant"])
            if not tenants.exists():
                raise CommandError(f"No tenant {opts['tenant']!r}.")
        total = 0
        for tenant in tenants:
            lines = self._racks(tenant) + self._cables(tenant)
            if not lines:
                continue
            self.stdout.write(f"{tenant.slug}:")
            for line in lines:
                self.stdout.write(f"  {line}")
            total += len(lines)
        self.stdout.write(f"{total} problem{'s' if total != 1 else ''} found.")

    def _racks(self, tenant) -> list[str]:
        from api.models import Device
        from api.rack_units import full_depth, height

        out = []
        racked = (
            Device.objects.filter(tenant=tenant, rack__isnull=False)
            .select_related("rack", "rack__site", "site", "device_type")
            .order_by("rack__name", "position", "name")
        )
        by_rack = defaultdict(list)
        for d in racked:
            rack = d.rack
            if d.site_id != rack.site_id:
                site = d.site.name if d.site else "no site"
                out.append(f"device {d.name}: at {site}, its rack {rack.name} at "
                           f"{rack.site.name}")
            if d.position is None:
                continue
            top = rack.starting_unit + rack.u_height - 1
            if d.position < rack.starting_unit or d.position + height(d.device_type) - 1 > top:
                out.append(f"device {d.name}: at U{d.position}, outside rack {rack.name} "
                           f"(U{rack.starting_unit}–U{top})")
            by_rack[rack.pk].append(d)
        for devices in by_rack.values():
            for i, a in enumerate(devices):
                a_units = set(range(a.position, a.position + height(a.device_type)))
                for b in devices[i + 1:]:
                    across = bool(a.face and b.face and a.face != b.face)
                    if across and not (full_depth(a.device_type) or full_depth(b.device_type)):
                        continue
                    a_half = getattr(a.device_type, "rack_width", "") == "half"
                    b_half = getattr(b.device_type, "rack_width", "") == "half"
                    if (a_half and b_half and a.rack_side and b.rack_side
                            and a.rack_side != b.rack_side):
                        continue
                    if a_units & set(range(b.position, b.position + height(b.device_type))):
                        out.append(f"device {b.name}: overlaps {a.name} in rack "
                                   f"{a.rack.name} at U{b.position}")
        located = (
            Device.objects.filter(tenant=tenant, location__isnull=False, site__isnull=False)
            .exclude(location__site_id=F("site_id"))
            .select_related("location", "site")
            .order_by("name")
        )
        for d in located:
            out.append(f"device {d.name}: location {d.location.name} is not at {d.site.name}")
        return out

    def _cables(self, tenant) -> list[str]:
        from api.cable_points import compatible_ends
        from api.models import Cable, CableTermination

        out = []
        ends = defaultdict(lambda: {"A": set(), "B": set()})
        for t in CableTermination.objects.filter(cable__tenant=tenant):
            kind = next(f for f in CableTermination.POINT_FIELDS
                        if getattr(t, f"{f}_id") is not None)
            ends[t.cable_id][t.end].add(kind)
        for cable in Cable.objects.filter(tenant=tenant).order_by("numid"):
            e = ends.get(cable.pk, {"A": set(), "B": set()})
            empty = [side for side in ("A", "B") if not e[side]]
            if empty:
                out.append(f"cable {cable}: no {' and no '.join(empty)} end")
                continue
            bad = sorted(
                f"{a} to {b}".replace("_", " ")
                for a in e["A"] for b in e["B"] if not compatible_ends(a, b)
            )
            if bad:
                out.append(f"cable {cable}: {', '.join(bad)}")
        return out

