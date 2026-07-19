"""bootstrap — idempotent first-run setup for a clean deployment.

Brings a fresh install to a usable state without hand edits:

  1. ensure an Organization exists (Tenants require one — see api.viewsets);
  2. ensure a default Tenant exists (unless ``--no-default-tenant``) — needed so
     the built-in Status catalog actually gets seeded on a fresh box, and so the
     demo seeders (``seed_demo_172``) have a tenant to write into;
  3. seed the built-in Status catalog for every tenant (the statuses features
     rely on: active, connected, container, reserved, offline, …);
  4. optionally create a superuser from ``DJANGO_SUPERUSER_*`` env vars.

Safe to run on every boot (e.g. from the container entrypoint or ``make``).
This is *production* bootstrap — distinct from ``seed_demo``, which loads
throwaway demo data.
"""
from __future__ import annotations

import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.utils.text import slugify

from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant

DEFAULT_ORG_NAME = "Default Organization"
DEFAULT_TENANT_NAME = "Default"


class Command(BaseCommand):
    help = "Idempotent first-run setup: organization, default tenant, built-in statuses, optional superuser."

    def add_arguments(self, parser):
        parser.add_argument(
            "--org-name",
            default=DEFAULT_ORG_NAME,
            help=f"Name for the auto-created Organization if none exists (default: {DEFAULT_ORG_NAME!r}).",
        )
        parser.add_argument(
            "--tenant-name",
            default=DEFAULT_TENANT_NAME,
            help=f"Name for the auto-created default Tenant if none exists (default: {DEFAULT_TENANT_NAME!r}).",
        )
        parser.add_argument(
            "--no-default-tenant",
            action="store_true",
            help="Don't auto-create a default Tenant (statuses then seed lazily on first tenant).",
        )

    def handle(self, *args, **opts):
        self._ensure_organization(opts["org_name"])
        if not opts["no_default_tenant"]:
            self._ensure_default_tenant(opts["tenant_name"])
        self._seed_statuses()
        self._seed_roles()
        self._maybe_create_superuser()

    def _ensure_default_tenant(self, name):
        existing = Tenant.objects.first()
        if existing is not None:
            self.stdout.write(f"Tenant already exists: {existing.name}.")
            return
        org = Organization.objects.first()
        slug = slugify(name) or "default"
        tenant = Tenant.objects.create(
            org=org, name=name, slug=slug, color="#3b82f6"
        )
        self.stdout.write(self.style.SUCCESS(f"Created default Tenant {tenant.name!r}."))

    def _ensure_organization(self, name):
        org = Organization.objects.first()
        if org is not None:
            self.stdout.write(f"Organization already exists: {org.name}.")
            return
        slug = slugify(name) or "default"
        org = Organization.objects.create(name=name, slug=slug)
        self.stdout.write(self.style.SUCCESS(f"Created Organization {org.name!r}."))

    def _seed_statuses(self):
        tenants = list(Tenant.objects.all())
        if not tenants:
            self.stdout.write(
                "No tenants yet — built-in statuses seed automatically when the "
                "first tenant is created."
            )
            return
        for tenant in tenants:
            created = seed_builtin_statuses(tenant)
            self.stdout.write(
                self.style.SUCCESS(f"Seeded statuses for {tenant.name}: {created} new.")
            )

    def _seed_roles(self):
        from api.role_seeds import seed_builtin_roles

        for tenant in Tenant.objects.all():
            created = seed_builtin_roles(tenant)
            self.stdout.write(
                self.style.SUCCESS(f"Seeded IP roles for {tenant.name}: {created} new.")
            )

    def _maybe_create_superuser(self):
        username = os.environ.get("DJANGO_SUPERUSER_USERNAME")
        password = os.environ.get("DJANGO_SUPERUSER_PASSWORD")
        email = os.environ.get("DJANGO_SUPERUSER_EMAIL", "")
        if not username or not password:
            self.stdout.write(
                "DJANGO_SUPERUSER_USERNAME / DJANGO_SUPERUSER_PASSWORD not set — "
                "skipping superuser creation."
            )
            return
        User = get_user_model()
        if User.objects.filter(username=username).exists():
            self.stdout.write(f"Superuser {username!r} already exists.")
            return
        User.objects.create_superuser(username=username, email=email, password=password)
        self.stdout.write(self.style.SUCCESS(f"Created superuser {username!r}."))
