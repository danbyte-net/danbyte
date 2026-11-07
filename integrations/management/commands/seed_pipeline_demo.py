"""seed_pipeline_demo - an opt-in demo deploy pipeline to try end to end.

In one tenant: the sandboxed scripts "Proxmox VNets (demo)" and "Config
check (demo)", a script automation target for each, the pipeline "Router
(demo)" running them in order, and a webhook target "Demo runner (disabled)"
left disabled and out of the pipeline. Re-runnable: a second run updates the
same rows. Never part of bootstrap or a migration:

    .venv/bin/python manage.py seed_pipeline_demo --tenant <slug> [--owner <username>]
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from core.models import Tenant
from integrations.demo_pipeline import seed

#: The tenant the other demo seeders make (seed_demo).
DEFAULT_TENANT = "acme"


class Command(BaseCommand):
    help = "Seed an opt-in demo deploy pipeline (two sandboxed scripts) in one tenant."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", default=DEFAULT_TENANT,
                            help=f"The tenant's slug (default {DEFAULT_TENANT}).")
        parser.add_argument("--owner", default=None,
                            help="Username that owns the demo scripts (default: none).")

    def handle(self, *args, tenant: str, owner: str | None, **options):
        t = Tenant.objects.filter(slug=tenant).first()
        if t is None:
            raise CommandError(f"No tenant with the slug {tenant!r}.")
        user = None
        if owner:
            user = get_user_model().objects.filter(username=owner, is_active=True).first()
            if user is None:
                raise CommandError(f"No active user {owner!r}.")
        made = seed(t, owner=user)
        p = made["pipeline"]
        out = self.stdout
        out.write(self.style.SUCCESS(f"Demo pipeline ready in {t.name}:"))
        out.write(f"  {p.name}: /pipelines/{p.id}")
        for s in made["scripts"]:
            out.write(f"  {s.name}: /scripts/{s.id}")
        out.write(f"  ({made['created']} objects made this run)")
