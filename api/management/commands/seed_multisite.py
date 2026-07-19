"""seed_multisite — a 10-site tenant with per-site staff and site-scoped RBAC.

Models the shape most multi-site operators actually run:

* one tenant, ten sites,
* a shared ``10.0.0.0/8`` supernet that every site carves its space from,
* one ``/18`` per site, with **site-01's marked as that site's default prefix**
  so staff there get it pre-selected when adding an address,
* a few devices per site,
* ten users (``site1`` … ``site10``, password = username) who can **read the
  whole tenant** but only **write their own site**.

Re-runnable: everything is get_or_create'd, so running it twice is a no-op
rather than a duplicate.

    manage.py seed_multisite            # create / update
    manage.py seed_multisite --wipe     # remove it all first
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.core.management.base import BaseCommand
from django.db import transaction

from api.models import (
    Device,
    DeviceRole,
    DeviceType,
    Manufacturer,
    Prefix,
    Site,
)
from api.status_registry import resolve_status, seed_builtin_statuses
from auth_api.models import ObjectPermission, UserProfile
from auth_api.site_paths import CATALOG_SITE_PATHS, SITE_PATHS
from core.models import Organization, Tenant

ORG_NAME = "Globex"
TENANT_NAME = "Globex"
TENANT_SLUG = "globex"

SITE_COUNT = 10
#: The shared supernet. Held as a container with NO site — it belongs to the
#: tenant, and each site's /18 nests inside it.
SUPERNET = "10.0.0.0/8"
#: Site N gets 10.N.0.0/18 out of the supernet.
def site_prefix(n: int) -> str:
    return f"10.{n}.0.0/18"


#: Which site's prefix becomes its default. (The setting is per-site, so the
#: others are deliberately left unset — that's what "inherits nothing" looks
#: like next to a site that has one.)
DEFAULT_PREFIX_SITE = 1

#: (name suffix, device role, device type) — repeated at every site.
DEVICES = [
    ("rtr-01", "router", "ISR4331"),
    ("sw-core-01", "core-switch", "C9300-48P"),
    ("sw-acc-01", "access-switch", "C9200-24P"),
    ("srv-01", "server", "PowerEdge R650"),
]

ROLE_COLORS = {
    "router": "#8b5cf6",
    "core-switch": "#0ea5e9",
    "access-switch": "#06b6d4",
    "server": "#10b981",
}


class Command(BaseCommand):
    help = "Seed a 10-site tenant with per-site users and site-scoped RBAC."

    def add_arguments(self, parser):
        parser.add_argument(
            "--wipe",
            action="store_true",
            help="Delete the seeded tenant (and its users) first.",
        )

    @transaction.atomic
    def handle(self, *args, **opts):
        if opts["wipe"]:
            self._wipe()

        org, _ = Organization.objects.get_or_create(
            name=ORG_NAME, defaults={"slug": TENANT_SLUG}
        )
        tenant, _ = Tenant.objects.get_or_create(
            org=org, slug=TENANT_SLUG, defaults={"name": TENANT_NAME}
        )
        # Status FKs need the built-in catalog; an ORM-created tenant doesn't
        # get it automatically (only the API path seeds it).
        seed_builtin_statuses(tenant)

        sites = self._sites(tenant)
        supernet = self._supernet(tenant)
        prefixes = self._site_prefixes(tenant, sites, supernet)
        n_dev = self._devices(tenant, sites)
        self._default_prefix(sites, prefixes)
        n_users = self._users_and_rbac(tenant, sites)

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded '{TENANT_NAME}': {len(sites)} sites, "
                f"{SUPERNET} + {len(prefixes)} site prefixes, {n_dev} devices, "
                f"{n_users} users (site1…site{SITE_COUNT}, password = username). "
                f"site-01's {site_prefix(DEFAULT_PREFIX_SITE)} is its default prefix."
            )
        )

    # ─── data ────────────────────────────────────────────────────────────
    def _sites(self, tenant) -> list[Site]:
        out = []
        for n in range(1, SITE_COUNT + 1):
            site, _ = Site.objects.get_or_create(
                tenant=tenant,
                name=f"site-{n:02d}",
                defaults={"description": f"Branch site {n}"},
            )
            out.append(site)
        return out

    def _supernet(self, tenant) -> Prefix:
        """The shared /8 — a container, held tenant-wide with no site, so every
        site's /18 nests under one supernet rather than ten islands."""
        obj, _ = Prefix.objects.get_or_create(
            tenant=tenant,
            cidr=SUPERNET,
            defaults={
                "status": resolve_status(tenant, "container", "prefix"),
                "description": "Shared RFC1918 supernet — every site carves from this",
                "site": None,
            },
        )
        return obj

    def _site_prefixes(self, tenant, sites, supernet) -> list[Prefix]:
        out = []
        for n, site in enumerate(sites, start=1):
            obj, _ = Prefix.objects.get_or_create(
                tenant=tenant,
                cidr=site_prefix(n),
                defaults={
                    "status": resolve_status(tenant, "active", "prefix"),
                    "site": site,
                    "description": f"{site.name} address space",
                },
            )
            out.append(obj)
        return out

    def _default_prefix(self, sites, prefixes) -> None:
        """Point one site at its own /18. Deliberately one site, not all — the
        contrast is the point: staff at site-01 get it pre-selected, everyone
        else still picks."""
        site = sites[DEFAULT_PREFIX_SITE - 1]
        site.default_prefix = prefixes[DEFAULT_PREFIX_SITE - 1]
        site.save(update_fields=["default_prefix", "updated_at"])

    def _devices(self, tenant, sites) -> int:
        mfr, _ = Manufacturer.objects.get_or_create(
            tenant=tenant, name="Cisco", defaults={"slug": "cisco"}
        )
        roles = {}
        for name, color in ROLE_COLORS.items():
            roles[name], _ = DeviceRole.objects.get_or_create(
                tenant=tenant, name=name, defaults={"slug": name, "color": color}
            )
        types = {}
        for _, _, tname in DEVICES:
            types[tname], _ = DeviceType.objects.get_or_create(
                tenant=tenant, name=tname, defaults={"manufacturer": mfr}
            )
        status = resolve_status(tenant, "active", "device")

        n = 0
        for site in sites:
            for suffix, role, tname in DEVICES:
                _, created = Device.objects.get_or_create(
                    tenant=tenant,
                    name=f"{site.name}-{suffix}",
                    defaults={
                        "site": site,
                        "role": roles[role],
                        "device_type": types[tname],
                        "status": status,
                    },
                )
                n += int(created)
        return n

    # ─── users + RBAC ────────────────────────────────────────────────────
    def _users_and_rbac(self, tenant, sites) -> int:
        # Read the whole tenant: one grant, every type, no site narrowing
        # (empty `sites` = all sites).
        read_all, _ = ObjectPermission.objects.get_or_create(
            name=f"{TENANT_NAME} — read all sites",
            defaults={"object_types": ["*"], "actions": ["view"]},
        )
        read_all.object_types = ["*"]
        read_all.actions = ["view"]
        read_all.save()
        read_all.tenants.set([tenant])

        n = 0
        for i, site in enumerate(sites, start=1):
            username = f"site{i}"
            user, created = User.objects.get_or_create(
                username=username,
                defaults={"first_name": site.name, "email": f"{username}@globex.test"},
            )
            # Password = username, per the brief. Always reset so a re-run gives
            # a known login.
            user.set_password(username)
            user.is_superuser = False
            user.is_staff = False
            user.save()
            profile, _ = UserProfile.objects.get_or_create(
                user=user, defaults={"role": "custom"}
            )
            profile.role = "custom"
            profile.current_tenant = tenant
            profile.save()
            profile.tenants.add(tenant)

            read_all.users.add(user)

            # Write ONLY their own site. Scoped to the site-aware object
            # types on purpose — granting "*" would quietly hand out
            # tenant-wide write on types with no site path. The CATALOG
            # types (tags, device types, zones, …) are included because this
            # tenant demos ENHANCED SITE SEPARATION: with the flag ON their
            # writes are fenced to site-local entries. (With the flag off a
            # site-scoped catalog grant applies tenant-wide — that's the
            # documented trade of the flag.)
            write_types = sorted({*SITE_PATHS, *CATALOG_SITE_PATHS})
            perm, _ = ObjectPermission.objects.get_or_create(
                name=f"{TENANT_NAME} — {site.name} read/write",
                defaults={
                    "object_types": write_types,
                    "actions": ["view", "add", "change", "delete"],
                },
            )
            perm.object_types = write_types
            perm.actions = ["view", "add", "change", "delete"]
            perm.save()
            perm.tenants.set([tenant])
            perm.sites.set([site])
            perm.users.set([user])
            n += int(created)
        return n

    def _wipe(self) -> None:
        User.objects.filter(
            username__in=[f"site{i}" for i in range(1, SITE_COUNT + 1)]
        ).delete()
        ObjectPermission.objects.filter(name__startswith=f"{TENANT_NAME} — ").delete()
        Tenant.objects.filter(slug=TENANT_SLUG).delete()
        Organization.objects.filter(name=ORG_NAME).delete()
