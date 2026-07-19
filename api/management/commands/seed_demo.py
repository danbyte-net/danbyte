"""seed_demo — opt-in dev/demo data.

Creates one Organization, one default Tenant inside it, two VRFs (the
implicit Global = NULL + an explicit "production"), four sites, ~25 prefixes
and supporting data. Re-runnable.
"""
from __future__ import annotations

import ipaddress
import random

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils.text import slugify

from api.models import VRF, IPAddress, Prefix, Site, VLAN
from core.models import Organization, Tag, Tenant


ORG_NAME = "Acme Networks"
TENANT_NAME = "Acme Networks"
TENANT_SLUG = "acme"

SITES = [
    ("dc-fra-01", "Frankfurt — Equinix FR4"),
    ("dc-ams-02", "Amsterdam — Equinix AM3"),
    ("office-cph", "Copenhagen HQ"),
    ("edge-stk", "Stockholm POP"),
]

VLANS = [
    (10, "prod", "Production server LAN"),
    (15, "db", "Database tier"),
    (20, "dmz", "DMZ perimeter"),
    (30, "mgmt", "Out-of-band management"),
    (40, "k8s", "Kubernetes pod network"),
    (50, "voice", "Voice / VoIP"),
    (60, "stor", "Storage replication"),
    (70, "bkp", "Backup"),
    (80, "cicd", "CI/CD runners"),
    (90, "vmot", "vMotion"),
    (99, "lab", "Lab / legacy"),
    (100, "office", "Office wired"),
    (101, "guest", "Guest wifi"),
    (110, "lab", "Office test lab"),
    (200, "old", "Decommission queue"),
]

TAGS = [
    ("prod", "#10b981"),
    ("critical", "#ef4444"),
    ("dmz", "#f59e0b"),
    ("mgmt", "#3b82f6"),
    ("k8s", "#8b5cf6"),
    ("voice", "#ec4899"),
    ("storage", "#06b6d4"),
    ("monitored", ""),
    ("branch", ""),
    ("edge", ""),
    ("backup", ""),
    ("ci", ""),
    ("runners", ""),
    ("vmware", ""),
    ("planned", ""),
    ("legacy", ""),
    ("lab", ""),
    ("test", ""),
    ("dhcp", ""),
    ("office", ""),
    ("guest", ""),
    ("wifi", ""),
    ("core", ""),
    ("ipv6", ""),
    ("db", "#10b981"),
]

# (cidr, status, vlan_id_or_None, site_idx, description, tag_names, vrf_name_or_None)
# vrf_name=None  → Global VRF (vrf=NULL)
# vrf_name="…"   → looked up in VRFS_DEMO below
PREFIXES = [
    ("10.0.0.0/16", "container", None, 0, "Corp aggregate — Frankfurt primary region", ["prod", "core"], None),
    ("10.0.10.0/24", "active", 10, 0, "Server LAN — production application tier", ["prod", "monitored"], None),
    ("10.0.20.0/24", "active", 20, 0, "DMZ perimeter services — reverse proxies, WAFs, external bastion", ["dmz", "edge"], None),
    ("10.0.30.0/24", "reserved", 30, 0, "Out-of-band management network", ["mgmt"], None),
    ("10.0.40.0/24", "active", 15, 0, "Database tier — Postgres primaries + replicas", ["db", "prod", "critical"], None),
    ("10.0.50.0/24", "active", 50, 0, "Voice / VoIP — handsets, SBCs, voicemail platform", ["voice"], None),
    ("10.0.60.0/24", "active", 60, 0, "Storage replication — NetApp + Pure", ["storage", "prod"], None),
    ("10.0.70.0/24", "active", 70, 0, "Backup network — Veeam + Cohesity replication", ["backup"], None),
    ("10.0.80.0/24", "active", 80, 0, "CI/CD runners — GitHub Actions self-hosted pool", ["ci", "runners"], None),
    ("10.0.90.0/24", "active", 90, 0, "vMotion — vSphere live migration", ["vmware"], None),
    ("10.20.30.0/24", "active", 40, 0, "Kubernetes pod network — primary production cluster", ["k8s", "prod", "critical"], None),
    ("10.10.0.0/16", "container", None, 1, "Branch aggregate — Amsterdam secondary region", ["branch"], None),
    ("10.10.10.0/24", "active", 10, 1, "Branch server LAN — Amsterdam application tier", ["prod", "branch"], None),
    ("10.10.20.0/24", "active", 20, 1, "AMS DMZ — perimeter services", ["dmz", "edge"], None),
    ("10.10.30.0/24", "active", 30, 1, "AMS management plane — out-of-band", ["mgmt"], None),
    ("10.10.40.0/24", "reserved", 40, 1, "Kubernetes expansion (planned Q4)", ["k8s", "planned"], None),
    ("10.50.0.0/16", "container", None, 3, "Edge aggregate — Stockholm POP", ["edge"], None),
    ("10.50.10.0/24", "active", 10, 3, "Edge production traffic", ["prod", "edge"], None),
    ("192.168.1.0/24", "active", 100, 2, "Office wired — Copenhagen HQ employee network", ["office", "dhcp"], None),
    ("192.168.2.0/24", "active", 101, 2, "Guest wifi — visitor traffic", ["guest", "wifi"], None),
    ("192.168.10.0/24", "reserved", 110, 2, "Office test lab — engineering staging", ["lab", "test"], None),
    ("172.16.0.0/24", "deprecated", 99, 3, "Legacy lab — scheduled for decommission after Q3", ["legacy", "lab"], None),
    ("172.20.0.0/24", "deprecated", 200, 3, "Old subnet pending teardown", ["legacy"], None),
    ("2001:db8:1::/64", "active", 10, 0, "IPv6 production segment — dual-stack rollout phase 2", ["ipv6", "prod"], None),
    ("2001:db8:2::/64", "reserved", 20, 0, "IPv6 DMZ (planned)", ["ipv6", "dmz"], None),

    # ─── VRF: production ─ same CIDRs allowed because different routing table ──
    ("10.0.0.0/16", "container", None, 0, "Production VRF aggregate", ["prod"], "production"),
    ("10.0.10.0/24", "active", 10, 0, "Production VRF server LAN (overlaps Global!)", ["prod"], "production"),
    ("10.0.20.0/24", "active", 20, 0, "Production VRF DMZ", ["dmz"], "production"),

    # ─── VRF: lab ─ small lab routing context ────────────────────────────
    ("10.10.0.0/16", "container", None, 1, "Lab VRF aggregate", ["lab"], "lab"),
    ("10.10.10.0/24", "active", 99, 1, "Lab VRF — experiments", ["lab", "test"], "lab"),
]

VRFS_DEMO = [
    ("production", "65001:100", "#10b981", "Production routing context"),
    ("lab", "65001:200", "#f59e0b", "Lab + test routing context"),
]


class Command(BaseCommand):
    help = "Seed realistic demo data so the prefix page has something to render."

    def add_arguments(self, parser):
        parser.add_argument(
            "--wipe",
            action="store_true",
            help="Delete the demo organization (by name) before seeding.",
        )

    @transaction.atomic
    def handle(self, *args, wipe=False, **options):
        if wipe:
            Organization.objects.filter(name=ORG_NAME).delete()
            Tag.objects.all().delete()
            self.stdout.write(self.style.WARNING(f"Wiped existing '{ORG_NAME}' data."))

        org, _ = Organization.objects.get_or_create(
            name=ORG_NAME, defaults={"slug": slugify(ORG_NAME)}
        )
        tenant, _ = Tenant.objects.get_or_create(
            org=org,
            slug=TENANT_SLUG,
            defaults={"name": TENANT_NAME, "color": "#3b82f6"},
        )
        # The built-in Status catalog isn't auto-seeded for an ORM-created
        # tenant (only via the API), so ensure it before assigning status FKs.
        from api.status_registry import resolve_status, seed_builtin_statuses

        seed_builtin_statuses(tenant)
        self.stdout.write(f"Org: {org.name}  ·  Tenant: {tenant.name}")

        # VRFs
        vrf_map = {}  # name -> VRF instance; "Global" is represented by None
        for name, rd, color, desc in VRFS_DEMO:
            v, _ = VRF.objects.get_or_create(
                tenant=tenant,
                name=name,
                defaults={"rd": rd, "color": color, "description": desc},
            )
            vrf_map[name] = v
        self.stdout.write(f"VRFs: {len(vrf_map)} explicit + Global (NULL)")

        # Tags (still global — Phase 5 makes them tenant-scoped)
        tag_map = {}
        for name, color in TAGS:
            tag, _ = Tag.objects.get_or_create(
                name=name, defaults={"slug": slugify(name), "color": color}
            )
            if tag.color != color:
                tag.color = color
                tag.save()
            tag_map[name] = tag
        self.stdout.write(f"Tags: {len(tag_map)} ({sum(1 for _,c in TAGS if c)} colored)")

        # Sites
        sites = []
        for name, location in SITES:
            site, _ = Site.objects.get_or_create(
                tenant=tenant, name=name, defaults={"location": location}
            )
            sites.append(site)
        self.stdout.write(f"Sites: {len(sites)}")

        # VLANs
        vlans = {}
        for vlan_id, name, desc in VLANS:
            v, _ = VLAN.objects.get_or_create(
                tenant=tenant,
                vlan_id=vlan_id,
                defaults={"name": name, "description": desc},
            )
            vlans[vlan_id] = v
        self.stdout.write(f"VLANs: {len(vlans)}")

        # Prefixes
        created_count = 0
        for cidr, status, vlan_id, site_idx, desc, tag_names, vrf_name in PREFIXES:
            site = sites[site_idx]
            vlan = vlans.get(vlan_id) if vlan_id else None
            vrf = vrf_map.get(vrf_name) if vrf_name else None
            gateway = None
            try:
                net = ipaddress.ip_network(cidr, strict=False)
                if net.version == 4 and net.num_addresses > 2:
                    gateway = str(net.network_address + 1)
            except ValueError:
                pass

            pstatus = resolve_status(tenant, status, "prefix")
            p, was_created = Prefix.objects.get_or_create(
                tenant=tenant,
                vrf=vrf,
                cidr=cidr,
                defaults={
                    "status": pstatus,
                    "site": site,
                    "vlan": vlan,
                    "gateway": gateway,
                    "description": desc,
                },
            )
            if not was_created:
                p.status = pstatus
                p.site = site
                p.vlan = vlan
                p.gateway = gateway
                p.description = desc
                p.save()
            p.tags.set([tag_map[t] for t in tag_names])
            created_count += 1

            # IPs (only for Global VRF, only for /24-ish IPv4)
            net = p.network
            if (
                vrf is None
                and net
                and net.version == 4
                and status not in ("container", "deprecated")
                and net.num_addresses <= 256
            ):
                target_pct = {
                    "active": random.choice([34, 42, 48, 54, 57, 61, 72, 87, 89, 96]),
                    "reserved": random.choice([0, 5, 8]),
                }.get(status, 0)
                capacity = max(net.num_addresses - 2, 1)
                target = int(capacity * target_pct / 100)
                hosts = list(net.hosts())
                random.shuffle(hosts)
                # Tenant default status (created earlier by the role/status
                # migration) — every new IP needs an Status FK.
                from api.models import Status
                default_status = (
                    Status.objects.filter(
                        tenant=tenant, default_for__contains=["ipaddress"]
                    ).first()
                    or Status.objects.filter(
                        tenant=tenant, available_to__contains=["ipaddress"]
                    ).first()
                )
                for ip in hosts[:target]:
                    IPAddress.objects.get_or_create(
                        tenant=tenant,
                        vrf=vrf,
                        ip_address=str(ip),
                        defaults={"prefix": p, "status": default_status},
                    )

        self.stdout.write(self.style.SUCCESS(
            f"Prefixes: {created_count}  (incl. {len([p for p in PREFIXES if p[6]])} non-Global)"
        ))

        # Document which VRFs run at each site
        for s in sites:
            for v in vrf_map.values():
                s.vrfs.add(v)

        self.stdout.write(self.style.SUCCESS("Seed complete. Visit /prefixes/"))
