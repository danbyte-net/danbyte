"""Bring every stack's auto-connect cables in line with its members.

Heals what writes skipping model signals left behind (a queryset
``update()`` of member positions, a bulk port retype). Idempotent; runs as
the system within each stack's tenant (api.stack_cables).

    manage.py reconcile_stack_cables
"""
from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db.models import Q

from api.models import VirtualChassis
from api.stack_cables import reconcile


class Command(BaseCommand):
    help = "Reconcile every stack's auto-connect cables."

    def handle(self, *args, **opts):
        created = deleted = 0
        stacks = (VirtualChassis.objects
                  .filter(Q(auto_connect_stack=True) | Q(auto_connect_power=True)
                          | Q(auto_cables__isnull=False))
                  .distinct().select_related("tenant").order_by("tenant_id", "name"))
        n = 0
        for vc in stacks:
            r = reconcile(vc)
            created += r["created"]
            deleted += r["deleted"]
            n += 1
        self.stdout.write(self.style.SUCCESS(
            f"stack cables: {n} stack(s), {created} created, {deleted} deleted"))
