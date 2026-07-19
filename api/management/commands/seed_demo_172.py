"""Seed a realistic 172.16.0.0/16 demo network — prefixes, IPs, devices, and
**healthy** monitoring state (seeded directly, so it won't go stale like real
pings against fake hosts).

    manage.py seed_demo_172            # seed into the first tenant
    manage.py seed_demo_172 --wipe     # remove the 172.16 demo first

Idempotent: re-running tops up without duplicating.
"""
from __future__ import annotations

import random
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from api.models import (
    Device,
    DeviceType,
    IPAddress,
    IPRole,
    Prefix,
    Site,
)
from api.status_registry import resolve_status, seed_builtin_statuses
from core.models import Tenant
from monitoring.models import CheckState, CheckTemplate, StateTransition

R = random.Random(1716)  # stable output across runs


def _mac() -> str:
    return "52:54:00:" + ":".join(f"{R.randint(0, 255):02x}" for _ in range(3))


# (host, hostname, role-name, status-name)
_PLAN = {
    "172.16.10.0/24": {
        "name": "Prod servers",
        "site": "dc-ams-02",
        "hosts": [
            (1, "gw-prod", "Gateway", "Active"),
            (10, "db-01", "Active", "Active"),
            (11, "db-02", "Standby", "Active"),
            (20, "web-01", "Active", "Active"),
            (21, "web-02", "Active", "Active"),
            (22, "web-03", "Active", "Active"),
            (30, "app-01", "Active", "Active"),
            (31, "app-02", "Active", "Active"),
            (40, "cache-01", "Active", "Active"),
            (50, "lb-01", "Virtual", "Active"),
            (60, "build-01", "Active", "Planned"),
            (200, "spare-01", None, "Reserved"),
        ],
    },
    "172.16.20.0/24": {
        "name": "DMZ",
        "site": "dc-fra-01",
        "hosts": [
            (1, "gw-dmz", "Gateway", "Active"),
            (10, "edge-proxy-01", "Active", "Active"),
            (11, "edge-proxy-02", "Active", "Active"),
            (20, "mail-01", "Active", "Active"),
            (30, "vpn-01", "Active", "Active"),
            (40, "old-fw", None, "Decommissioned"),
        ],
    },
    "172.16.30.0/24": {
        "name": "Management",
        "site": "dc-ams-02",
        "hosts": [
            (1, "gw-mgmt", "Gateway", "Active"),
            (11, "sw-core-01", "Active", "Active"),
            (12, "sw-core-02", "HSRP Active", "Active"),
            (21, "sw-access-01", "Active", "Active"),
            (22, "sw-access-02", "Active", "Active"),
            (50, "ipmi-db-01", "Active", "Active"),
            (51, "ipmi-web-01", "Active", "Active"),
        ],
    },
    "172.16.40.0/24": {
        "name": "DHCP pool",
        "site": "office-cph",
        "hosts": [(n, f"dhcp-{n}", None, "For testing") for n in range(20, 60, 3)],
    },
}

# Devices to drop into the inventory (name, type, site, status).
_DEVICES = [
    ("sw-core-01", "Switch", "dc-ams-02", "active"),
    ("sw-core-02", "Switch", "dc-ams-02", "active"),
    ("sw-access-01", "Switch", "dc-ams-02", "active"),
    ("db-01", "Server", "dc-ams-02", "active"),
    ("web-01", "Server", "dc-ams-02", "active"),
    ("san-01", "Storage", "dc-fra-01", "active"),
    ("edge-proxy-01", "Server", "dc-fra-01", "active"),
    ("build-01", "Server", "dc-ams-02", "staged"),
]

# Healthy monitoring mix for the seeded IPs (weighted).
_MON = ["up"] * 22 + ["degraded"] * 2 + ["down"] * 1


class Command(BaseCommand):
    help = "Seed a realistic 172.16.0.0/16 demo network with healthy monitoring."

    def add_arguments(self, parser):
        parser.add_argument("--wipe", action="store_true", help="Remove the demo first.")

    def handle(self, *args, **opts):
        tenant = Tenant.objects.first()
        if tenant is None:
            # Bootstrap a minimal org+tenant so the seeder is self-sufficient
            # (matches `manage.py bootstrap`). Mirrors seed_demo.
            from core.models import Organization

            org = Organization.objects.first() or Organization.objects.create(
                name="Default Organization", slug="default"
            )
            tenant = Tenant.objects.create(
                org=org, name="Default", slug="default", color="#3b82f6"
            )
            self.stdout.write("No tenant existed — created a default one.")

        # Ensure the built-in Status catalog exists before assigning status FKs.
        seed_builtin_statuses(tenant)

        if opts["wipe"]:
            self._wipe(tenant)
            self.stdout.write(self.style.WARNING("Wiped 172.16 demo."))

        cat = _Catalog(tenant)
        now = timezone.now()

        root, _ = Prefix.objects.get_or_create(
            tenant=tenant,
            cidr="172.16.0.0/16",
            defaults={
                "status": cat.status("container", "prefix"),
                "site": cat.site("dc-ams-02"),
                "description": "Demo — corporate supernet",
            },
        )

        tmpl = self._template(tenant)
        n_ip = n_state = 0
        for cidr, spec in _PLAN.items():
            prefix, _ = Prefix.objects.get_or_create(
                tenant=tenant,
                cidr=cidr,
                defaults={
                    "status": cat.status("active", "prefix"),
                    "site": cat.site(spec["site"]),
                    "description": f"Demo — {spec['name']}",
                },
            )
            base = cidr.split("/")[0].rsplit(".", 1)[0]
            for host, hostname, role, status in spec["hosts"]:
                addr = f"{base}.{host}"
                ip, created = IPAddress.objects.get_or_create(
                    tenant=tenant,
                    vrf=None,
                    ip_address=addr,
                    defaults={
                        "prefix": prefix,
                        "status": cat.ipstatus(status),
                        "role": cat.iprole(role) if role else None,
                        "dns_name": f"{hostname}.acme.internal",
                        "mac_address": _mac(),
                        "description": "",
                    },
                )
                if created:
                    n_ip += 1
                # Seed a frozen, healthy check state (next_run=None → never run).
                if status in ("Active", "Planned") and not CheckState.objects.filter(
                    target_ip=ip, template=tmpl
                ).exists():
                    st = R.choice(_MON)
                    CheckState.objects.create(
                        tenant=tenant, target_ip=ip, template=tmpl, assignment=None,
                        kind="icmp", status=st, since=now - timedelta(hours=R.randint(1, 72)),
                        last_checked=now - timedelta(minutes=R.randint(0, 4)),
                        last_latency_ms=round(R.uniform(0.3, 8.0), 1) if st != "down" else None,
                        consecutive_success=R.randint(5, 400) if st == "up" else 0,
                        consecutive_fail=0 if st == "up" else R.randint(2, 6),
                        next_run=None, in_flight=False,
                    )
                    n_state += 1

        # A few recent transitions so the activity feed looks alive.
        self._transitions(tenant, tmpl, now)
        n_dev = self._devices(tenant, cat)
        self._compliance(tenant)

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded 172.16 demo: +{n_ip} IPs, +{n_state} check states, "
                f"+{n_dev} devices across {len(_PLAN)} subnets."
            )
        )

    # ─── helpers ─────────────────────────────────────────────────────────
    def _template(self, tenant) -> CheckTemplate:
        t, _ = CheckTemplate.objects.get_or_create(
            tenant=tenant,
            slug="demo-ping",
            defaults={"name": "demo-ping", "kind": "icmp", "params": {}, "secret_params": {}},
        )
        return t

    def _transitions(self, tenant, tmpl, now):
        sample = list(
            IPAddress.objects.filter(tenant=tenant, ip_address__startswith="172.16.")
        )[:12]
        flips = [("up", "degraded"), ("degraded", "up"), ("up", "down"), ("down", "up")]
        for i, ip in enumerate(sample):
            frm, to = flips[i % len(flips)]
            StateTransition.objects.create(
                tenant=tenant, target_ip=ip, template=tmpl, kind="icmp",
                from_status=frm, to_status=to, at=now - timedelta(minutes=i * 7 + 1),
                detail={"demo": True},
            )

    def _compliance(self, tenant):
        from compliance.models import ComplianceRule

        for spec in [
            dict(name="Prefixes must have a description", object_type="prefix",
                 check_type="required", field="description", severity="warning"),
            dict(name="Active IPs need a DNS name", object_type="ipaddress",
                 check_type="required", field="dns_name", severity="info"),
            dict(name="Devices need a serial number", object_type="device",
                 check_type="required", field="serial_number", severity="warning"),
        ]:
            ComplianceRule.objects.get_or_create(
                tenant=tenant, name=spec.pop("name"), defaults=spec
            )

    def _devices(self, tenant, cat) -> int:
        n = 0
        for name, dtype, site, status in _DEVICES:
            _, created = Device.objects.get_or_create(
                tenant=tenant,
                name=name,
                defaults={
                    "device_type": cat.devtype(dtype),
                    "site": cat.site(site),
                    "status": cat.status(status, "device"),
                },
            )
            n += int(created)
        return n

    def _wipe(self, tenant):
        ips = IPAddress.objects.filter(tenant=tenant, ip_address__startswith="172.16.")
        CheckState.objects.filter(target_ip__in=ips).delete()
        StateTransition.objects.filter(target_ip__in=ips).delete()
        ips.delete()
        Prefix.objects.filter(tenant=tenant, cidr__startswith="172.16.").delete()
        Device.objects.filter(tenant=tenant, name__in=[d[0] for d in _DEVICES]).delete()


class _Catalog:
    """Resolve existing catalog rows by name; create on miss (demo data)."""

    def __init__(self, tenant):
        self.t = tenant

    def site(self, name):
        obj, _ = Site.objects.get_or_create(tenant=self.t, name=name)
        return obj

    def status(self, name, model_slug=None):
        return resolve_status(self.t, name, model_slug)

    # IPs land on a status too — resolve to the built-in catalog.
    def ipstatus(self, name):
        return resolve_status(self.t, name, "ipaddress")

    def iprole(self, name):
        obj, _ = IPRole.objects.get_or_create(
            tenant=self.t, name=name, defaults={"slug": name.lower().replace(" ", "-")}
        )
        return obj

    def devtype(self, name):
        obj = DeviceType.objects.filter(tenant=self.t, name=name).first()
        if obj:
            return obj
        from api.models import Manufacturer

        mfr, _ = Manufacturer.objects.get_or_create(
            tenant=self.t, name="cisco", defaults={"slug": "cisco"}
        )
        obj, _ = DeviceType.objects.get_or_create(
            tenant=self.t, name=name, defaults={"manufacturer": mfr}
        )
        return obj
