"""seed_homelab — opt-in dev data modelled on a real homelab.

Populates one tenant with a small but complete slice of infrastructure so every
page (IPAM, devices, racks, clusters/VMs, prefixes, VLANs) has something real to
render: a HomeLab site with a rack of physical gear (Proxmox nodes + UniFi
gateway/switch), a Proxmox cluster running the service VMs (AD/DNS, Vault,
step-CA, Terraform, Ansible, the dev box), across three networks:

    10.0.0.0/24     core infrastructure LAN
    10.10.0.0/16    workload / overlay aggregate (+ a /24 child)
    192.168.0.0/24  office / management LAN

Opt-in and re-runnable; never touched by bootstrap. `--wipe` tears the HomeLab
org down first. This is illustrative dev data — keep it out of production.

    manage.py seed_homelab            # into the first (bootstrapped) tenant
    manage.py seed_homelab --wipe
    manage.py seed_homelab --tenant acme
"""
from __future__ import annotations

import ipaddress

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils.text import slugify

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    IPAddress,
    Location,
    Manufacturer,
    Prefix,
    Rack,
    Site,
    VLAN,
    VirtualMachine,
)
from core.models import Organization, Tag, Tenant

ORG_NAME = "DanByte"
TENANT_NAME = "DanByte Lab"
TENANT_SLUG = "danbyte-lab"

# ── networks ────────────────────────────────────────────────────────────────
VLANS = [
    (1, "default", "Default / native"),
    (10, "servers", "Core server LAN"),
    (20, "mgmt", "Out-of-band management"),
    (30, "workloads", "VM / container workloads"),
    (100, "office", "Office wired"),
    (101, "guest", "Guest wifi"),
]

TAGS = [
    ("infra", "#3b82f6"),
    ("prod", "#10b981"),
    ("mgmt", "#f59e0b"),
    ("virtual", "#8b5cf6"),
    ("network", "#0ea5e9"),
    ("hypervisor", "#8b5cf6"),
    ("ad", "#ef4444"),
    ("secrets", "#ef4444"),
    ("dev", ""),
]

# (cidr, status, vlan, site_key, description, tags)
PREFIXES = [
    ("10.0.0.0/24", "active", 10, "homelab", "Core infrastructure LAN — hypervisors, service VMs", ["infra", "prod"]),
    ("10.10.0.0/16", "container", None, "homelab", "Workload / overlay aggregate", ["infra"]),
    ("10.10.10.0/24", "active", 30, "homelab", "Container / Kubernetes workloads", ["prod"]),
    ("192.168.0.0/24", "active", 100, "office", "Office / management LAN — gateway, wifi, dev site", ["mgmt", "office"]),
]

# ── physical gear in the rack ───────────────────────────────────────────────
# (name, type_key, role_key, u_position, u_height, mgmt_ip, extra_ip, tags)
PHYSICAL = [
    ("udm-pro", "udm-pro", "gateway", 42, 1, "192.168.0.1", "10.0.0.1", ["network", "infra"]),
    ("sw-01", "usw-pro-24", "switch", 41, 1, "10.0.0.2", None, ["network"]),
    ("pve-01", "pve-host", "hypervisor", 40, 2, "10.0.0.11", None, ["hypervisor", "prod"]),
    ("pve-02", "pve-host", "hypervisor", 38, 2, "10.0.0.12", None, ["hypervisor", "prod"]),
    ("pve-03", "pve-host", "hypervisor", 36, 2, "10.0.0.13", None, ["hypervisor", "prod"]),
]

# ── service VMs on the Proxmox cluster ──────────────────────────────────────
# (name, role_key, ip, vcpus, memory_mb, disk_gb, tags)
VMS = [
    ("db-dc", "domain-controller", "10.0.0.45", 2, 4096, 60, ["ad", "prod"]),
    ("db-vault", "server", "10.0.0.48", 2, 2048, 40, ["secrets", "prod"]),
    ("db-stepca", "server", "10.0.0.49", 2, 2048, 40, ["secrets", "prod"]),
    ("tf-01", "server", "10.0.0.40", 2, 4096, 60, ["infra"]),
    ("db-ansible", "server", "10.0.0.50", 2, 4096, 60, ["infra"]),
    ("db-dev01", "server", "10.0.0.41", 4, 8192, 120, ["dev"]),
]

DEVICE_TYPES = [
    # (key, manufacturer, model, u_height, is_full_depth)
    ("udm-pro", "Ubiquiti", "UniFi Dream Machine Pro", 1, False),
    ("usw-pro-24", "Ubiquiti", "USW-Pro-24-PoE", 1, False),
    ("pve-host", "Supermicro", "SYS-2029 (Proxmox VE)", 2, True),
]

ROLES = [
    ("gateway", "Gateway / firewall", "#ef4444"),
    ("switch", "Switch", "#0ea5e9"),
    ("hypervisor", "Hypervisor", "#8b5cf6"),
    ("server", "Server", "#10b981"),
    ("domain-controller", "Domain controller", "#f59e0b"),
]


class Command(BaseCommand):
    help = "Seed a realistic homelab: site, rack, Proxmox nodes, service VMs, IPAM."

    def add_arguments(self, parser):
        parser.add_argument("--wipe", action="store_true",
                            help="Delete the DanByte org before seeding.")
        parser.add_argument("--tenant", default=None,
                            help="Slug of an existing tenant to seed into "
                                 "(default: first tenant, else create DanByte Lab).")

    @transaction.atomic
    def handle(self, *args, wipe=False, tenant=None, **options):
        if wipe:
            Organization.objects.filter(name=ORG_NAME).delete()
            self.stdout.write(self.style.WARNING(f"Wiped '{ORG_NAME}'."))

        self.t = self._tenant(tenant)
        from api.status_registry import seed_builtin_statuses
        seed_builtin_statuses(self.t)
        self.stdout.write(f"Tenant: {self.t.name} ({self.t.slug})")

        self._tags()
        sites = self._sites()
        self._vlans()
        self.prefix_map = self._prefixes(sites)
        rack, loc = self._rack(sites["homelab"])
        self._physical(sites["homelab"], loc, rack)
        self._cluster_and_vms(sites["homelab"])

        self.stdout.write(self.style.SUCCESS(
            f"HomeLab ready — {Device.objects.filter(tenant=self.t).count()} devices, "
            f"{VirtualMachine.objects.filter(tenant=self.t).count()} VMs, "
            f"{IPAddress.objects.filter(tenant=self.t).count()} IPs. Visit /devices/"
        ))

    # ── helpers ──────────────────────────────────────────────────────────────
    def _tenant(self, slug):
        if slug:
            t = Tenant.objects.filter(slug=slug).first()
            if not t:
                raise SystemExit(f"No tenant with slug {slug!r}.")
            return t
        t = Tenant.objects.order_by("created_at").first()
        if t:
            return t
        org, _ = Organization.objects.get_or_create(
            name=ORG_NAME, defaults={"slug": slugify(ORG_NAME)})
        t, _ = Tenant.objects.get_or_create(
            org=org, slug=TENANT_SLUG,
            defaults={"name": TENANT_NAME, "color": "#3b82f6"})
        return t

    def _status(self, kind, name="active"):
        """A Status FK for ``kind`` (device/ipaddress/prefix/...), best-effort."""
        from api.status_registry import resolve_status
        try:
            return resolve_status(self.t, name, kind)
        except Exception:
            from api.models import Status
            return (Status.objects.filter(tenant=self.t,
                                          default_for__contains=[kind]).first()
                    or Status.objects.filter(tenant=self.t,
                                             available_to__contains=[kind]).first())

    def _tags(self):
        self.tag_map = {}
        for name, color in TAGS:
            tag, _ = Tag.objects.get_or_create(
                name=name, defaults={"slug": slugify(name), "color": color})
            self.tag_map[name] = tag

    def _sites(self):
        homelab, _ = Site.objects.get_or_create(
            tenant=self.t, name="HomeLab",
            defaults={"location": "Home rack room"})
        office, _ = Site.objects.get_or_create(
            tenant=self.t, name="Office",
            defaults={"location": "Office / edge"})
        self.stdout.write("Sites: HomeLab, Office")
        return {"homelab": homelab, "office": office}

    def _vlans(self):
        for vid, name, desc in VLANS:
            VLAN.objects.get_or_create(
                tenant=self.t, vlan_id=vid,
                defaults={"name": name, "description": desc})
        self.stdout.write(f"VLANs: {len(VLANS)}")

    def _prefixes(self, sites):
        vlan_by_id = {v.vlan_id: v for v in VLAN.objects.filter(tenant=self.t)}
        out = {}
        for cidr, status, vid, site_key, desc, tags in PREFIXES:
            net = ipaddress.ip_network(cidr, strict=False)
            gw = str(net.network_address + 1) if net.num_addresses > 2 else None
            p, created = Prefix.objects.get_or_create(
                tenant=self.t, vrf=None, cidr=cidr,
                defaults={
                    "status": self._status("prefix", status),
                    "site": sites[site_key],
                    "vlan": vlan_by_id.get(vid),
                    "gateway": gw,
                    "description": desc,
                })
            if not created:
                p.status = self._status("prefix", status)
                p.site = sites[site_key]
                p.vlan = vlan_by_id.get(vid)
                p.description = desc
                p.save()
            p.tags.set([self.tag_map[t] for t in tags if t in self.tag_map])
            out[cidr] = p
        self.stdout.write(f"Prefixes: {len(out)}")
        return out

    def _prefix_for(self, ip):
        """Smallest seeded prefix that contains ``ip`` (skip containers)."""
        addr = ipaddress.ip_address(ip)
        best = None
        for cidr, p in self.prefix_map.items():
            net = ipaddress.ip_network(cidr, strict=False)
            if addr in net and (best is None or net.prefixlen > best[0]):
                best = (net.prefixlen, p)
        return best[1] if best else None

    def _add_ip(self, ip, *, device=None, interface=None):
        prefix = self._prefix_for(ip)
        if prefix is None:
            return None
        obj, _ = IPAddress.objects.get_or_create(
            tenant=self.t, vrf=None, ip_address=ip,
            defaults={
                "prefix": prefix,
                "status": self._status("ipaddress"),
                "site": prefix.site,
                "assigned_device": device,
                "assigned_interface": interface,
            })
        # Re-point assignment on re-run (device/interface may be freshly made).
        changed = False
        if device and obj.assigned_device_id != device.id:
            obj.assigned_device = device
            changed = True
        if interface and obj.assigned_interface_id != interface.id:
            obj.assigned_interface = interface
            changed = True
        if changed:
            obj.save()
        return obj

    def _roles(self):
        self.role_map = {}
        for key, name, color in ROLES:
            role, _ = DeviceRole.objects.get_or_create(
                tenant=self.t, slug=key, defaults={"name": name, "color": color})
            self.role_map[key] = role

    def _device_types(self):
        self.type_map = {}
        for key, mfr_name, model, u, full in DEVICE_TYPES:
            mfr, _ = Manufacturer.objects.get_or_create(
                tenant=self.t, name=mfr_name, defaults={"slug": slugify(mfr_name)})
            dt, _ = DeviceType.objects.get_or_create(
                tenant=self.t, name=model,
                defaults={"manufacturer": mfr, "model": model,
                          "u_height": u, "is_full_depth": full})
            self.type_map[key] = dt

    def _rack(self, site):
        loc, _ = Location.objects.get_or_create(
            tenant=self.t, site=site, slug="rack-room",
            defaults={"name": "Rack room"})
        rack, _ = Rack.objects.update_or_create(
            tenant=self.t, name="HL-R1",
            defaults={"site": site, "location": loc, "u_height": 42,
                      "width": 19, "starting_unit": 1,
                      "facility_id": "R1"})
        return rack, loc

    def _physical(self, site, loc, rack):
        self._roles()
        self._device_types()
        dev_status = self._status("device")
        for name, type_key, role_key, pos, _u, mgmt_ip, extra_ip, tags in PHYSICAL:
            dev, _ = Device.objects.update_or_create(
                tenant=self.t, name=name,
                defaults={"site": site, "location": loc, "rack": rack,
                          "device_type": self.type_map[type_key],
                          "role": self.role_map[role_key],
                          "position": pos, "face": "front",
                          "status": dev_status})
            dev.tags.set([self.tag_map[t] for t in tags if t in self.tag_map])
            iface, _ = Interface.objects.get_or_create(
                device=dev, name="mgmt0",
                defaults={"type": "1000base-t", "mgmt_only": True})
            primary = self._add_ip(mgmt_ip, device=dev, interface=iface)
            if extra_ip:
                self._add_ip(extra_ip, device=dev, interface=iface)
            if primary and dev.primary_ip_id != primary.id:
                dev.primary_ip = primary
                dev.save(update_fields=["primary_ip"])
        self.stdout.write(f"Physical devices: {len(PHYSICAL)} in rack HL-R1")

    def _cluster_and_vms(self, site):
        ctype, _ = ClusterType.objects.get_or_create(
            tenant=self.t, slug="proxmox-ve",
            defaults={"name": "Proxmox VE"})
        cluster, _ = Cluster.objects.get_or_create(
            tenant=self.t, name="HomeLab PVE",
            defaults={"type": ctype, "site": site,
                      "status": self._status("cluster")})
        vm_status = self._status("virtualmachine")
        for name, role_key, ip, vcpus, mem, disk, tags in VMS:
            vm, _ = VirtualMachine.objects.update_or_create(
                tenant=self.t, name=name,
                defaults={"cluster": cluster, "site": site,
                          "role": self.role_map.get(role_key),
                          "status": vm_status, "vcpus": vcpus,
                          "memory_mb": mem, "disk_gb": disk})
            vm.tags.set([self.tag_map[t] for t in tags if t in self.tag_map])
            primary = self._add_ip(ip)
            if primary and vm.primary_ip_id != primary.id:
                vm.primary_ip = primary
                vm.save(update_fields=["primary_ip"])
        self.stdout.write(f"Cluster 'HomeLab PVE' + {len(VMS)} VMs")
