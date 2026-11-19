"""Propose (or record) the ways of existing cables through their racks
(api.cable_ways, docs/dcim/racks.md → Cable ways).

A dry run by default: prints, per cable and rack, the way the engine
proposes, its length and its reasons, and writes nothing. ``--apply``
writes them as the tenant's mode says - recorded (Record automatically)
or stored as proposals to accept (Propose). Manual and dismissed ways are
never touched. Idempotent.

    manage.py propose_cable_ways --tenant acme [--rack R1] [--cable <id>] [--apply]
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q

from api import cable_ways as cw
from api.models import Cable, CableWay, Rack
from core.models import Tenant


class Command(BaseCommand):
    help = "Propose cable ways through racks for existing cables (dry run by default)."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", required=True, help="Tenant slug.")
        parser.add_argument("--rack", help="Only cables with an end in this rack (name or id).")
        parser.add_argument("--cable", help="Only this cable (id).")
        parser.add_argument("--apply", action="store_true", help="Write the ways.")

    def handle(self, *args, **opts):
        from core.effective_settings import cable_ways_mode

        tenant = Tenant.objects.filter(slug=opts["tenant"]).first()
        if tenant is None:
            raise CommandError(f"No tenant {opts['tenant']!r}.")
        racks = Rack.objects.filter(tenant=tenant)
        if opts.get("rack"):
            q = Q(name=opts["rack"])
            try:
                import uuid

                q |= Q(pk=uuid.UUID(opts["rack"]))
            except ValueError:
                pass
            racks = racks.filter(q)
            if not racks.exists():
                raise CommandError(f"No rack {opts['rack']!r}.")
        cables = Cable.objects.filter(tenant=tenant)
        if opts.get("cable"):
            cables = cables.filter(pk=opts["cable"])
        rack_ids = set(racks.values_list("pk", flat=True))
        q = Q()
        for f in ("interface", "front_port", "rear_port", "console_port",
                  "console_server_port", "power_port", "power_outlet", "aux_port"):
            q |= Q(**{f"terminations__{f}__device__rack_id__in": rack_ids})
        cables = cables.filter(q).distinct().order_by("numid", "created_at")
        apply = opts["apply"]
        state = "recorded" if cable_ways_mode(tenant) == "record" else "proposed"
        tally = {"cables": 0, "proposed": 0, "none": 0, "kept": 0}
        for cable in cables.iterator():
            ctxs = {k: v for k, v in cw.rack_ends(cable).items() if k in rack_ids}
            if not ctxs:
                continue
            tally["cables"] += 1
            stored = {w.rack_id: w for w in CableWay.objects.filter(cable=cable)}
            prefs = cw.exit_prefs(cable, ctxs)
            for rack_id, ctx in sorted(ctxs.items(), key=lambda kv: kv[1].rack.name):
                w = stored.get(rack_id)
                head = f"{cable}  {ctx.rack.name}  {ctx.end}"
                if w is not None and (w.source == "manual" or w.state == "dismissed"):
                    tally["kept"] += 1
                    self.stdout.write(f"{head}  kept ({w.source} {w.state})")
                    continue
                pref = prefs.get(rack_id, ("",))[0]
                prop = cw.propose_for(ctx, pref)
                if prop is None:
                    tally["none"] += 1
                    self.stdout.write(f"{head}  no pathways")
                    continue
                tally["proposed"] += 1
                ports = " / ".join(e.port for e in ctx.engine_ends())
                alts = f"  +{len(prop['alternatives'])} alt" if prop["alternatives"] else ""
                self.stdout.write(
                    f"{head}  {cw.chain_text(prop, ports)}  {prop['length_mm']} mm  "
                    f"[{', '.join(prop['reasons'])}]{alts}")
            if apply:
                with transaction.atomic():
                    cw.refresh(cable, state=state)
        verb = f"written as {state}" if apply else "dry run, nothing written"
        self.stdout.write(self.style.SUCCESS(
            f"cable ways: {tally['cables']} cable(s), {tally['proposed']} proposed, "
            f"{tally['none']} without pathways, {tally['kept']} kept ({verb})"))
