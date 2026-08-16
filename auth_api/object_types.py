"""Registry of object types that RBAC object-permissions can target.

A single source of truth mapping a ``slug`` (Django ``model._meta.model_name``)
to its model + a friendly label + a UI group. The DRF enforcement layer derives
the slug from each viewset's model automatically, so *registering* a type here is
what makes it RBAC-controlled; an unregistered model falls back to the legacy
"any authenticated user in the tenant" behaviour.

Permissions act over these actions: view / add / change / delete plus the
capability verbs connect / reveal. The capability verbs are additive and
independent — they are never implied by change; a type only honours a verb if
its viewset checks it (e.g. a credential's ``reveal`` action). Granting an
unused verb on a type that ignores it is harmless.
"""
from __future__ import annotations

from functools import lru_cache

from django.apps import apps

# view/add/change/delete are the CRUD verbs; connect/reveal are capability verbs
# checked only by the viewsets that opt into them. ACTIONS is the full grantable
# universe (used to validate a grant's actions); it is intentionally permissive
# so a wildcard grant covers every verb.
CRUD_ACTIONS = ["view", "add", "change", "delete"]
ACTIONS = [*CRUD_ACTIONS, "connect", "reveal", "subscribe"]

# Which capability verbs a *specific* type actually honours — only these are
# advertised for that type in the permission form, so the UI never offers e.g.
# "reveal on a Site". A type absent here advertises the CRUD verbs alone. The
# verb still has to be checked by the type's viewset to have any effect; this map
# only governs what the picker surfaces.
CAPABILITY_VERBS: dict[str, list[str]] = {
    "devicecredential": ["reveal"],
    "device": ["connect"],
    # Self-service opt-in/opt-out on the Notifications page.
    "notificationchannel": ["subscribe"],
}

# (app_label.ModelName, label, group). Order drives the form's grouping.
_ENTRIES: list[tuple[str, str, str]] = [
    # ─── Organization ───────────────────────────────────────────────
    ("core.Tenant", "Tenants", "Organization"),
    ("core.TenantGroup", "Tenant groups", "Organization"),
    ("api.Region", "Regions", "Organization"),
    ("api.Site", "Sites", "Organization"),
    # Grantable "site admin" surface: change + sites=[X] (to users OR groups)
    # makes its holders admins of site X's settings pages. Scoped via
    # SITE_PATHS["sitesettings"] = "site".
    ("core.SiteSettings", "Site settings", "Organization"),
    ("api.Location", "Locations", "Organization"),
    ("api.Contact", "Contacts", "Organization"),
    ("api.ContactGroup", "Contact groups", "Organization"),
    ("api.ContactRole", "Contact roles", "Organization"),
    ("api.ContactAssignment", "Contact assignments", "Organization"),
    # ─── Circuits ───────────────────────────────────────────────────
    ("api.Provider", "Providers", "Circuits"),
    ("api.ProviderNetwork", "Provider networks", "Circuits"),
    ("api.CircuitType", "Circuit types", "Circuits"),
    ("api.Circuit", "Circuits", "Circuits"),
    ("api.CircuitTermination", "Circuit terminations", "Circuits"),
    # ─── Power ──────────────────────────────────────────────────────
    ("api.PowerPanel", "Power panels", "Power"),
    ("api.PowerFeed", "Power feeds", "Power"),
    # ─── Wireless ───────────────────────────────────────────────────
    ("api.WirelessLANGroup", "Wireless LAN groups", "Wireless"),
    ("api.WirelessLAN", "Wireless LANs", "Wireless"),
    # ─── VPN ────────────────────────────────────────────────────────
    ("api.TunnelGroup", "Tunnel groups", "VPN"),
    ("api.IPSecProfile", "IPSec profiles", "VPN"),
    ("api.Tunnel", "Tunnels", "VPN"),
    ("api.TunnelTermination", "Tunnel terminations", "VPN"),
    ("api.L2VPN", "L2VPNs", "VPN"),
    ("api.L2VPNTermination", "L2VPN terminations", "VPN"),
    # ─── IPAM ───────────────────────────────────────────────────────
    ("api.Aggregate", "Aggregates", "IPAM"),
    ("api.Prefix", "Prefixes", "IPAM"),
    ("api.IPRange", "IP ranges", "IPAM"),
    ("api.IPAddress", "IP addresses", "IPAM"),
    ("api.RIR", "RIRs", "IPAM"),
    ("api.ASN", "ASNs", "IPAM"),
    ("api.VLAN", "VLANs", "IPAM"),
    ("api.Zone", "Zones", "IPAM"),
    ("api.VLANGroup", "VLAN groups", "IPAM"),
    ("api.VRF", "VRFs", "IPAM"),
    ("api.RouteTarget", "Route targets", "IPAM"),
    ("api.FHRPGroup", "FHRP groups", "IPAM"),
    ("api.FHRPGroupAssignment", "FHRP group assignments", "IPAM"),
    ("api.IPRole", "IP roles", "IPAM"),
    ("api.Service", "Services", "IPAM"),
    ("api.ServiceTemplate", "Service templates", "IPAM"),
    # ─── DCIM ───────────────────────────────────────────────────────
    ("api.Device", "Devices", "DCIM"),
    ("api.DeviceType", "Device types", "DCIM"),
    ("api.ModuleType", "Module types", "DCIM"),
    ("api.DeviceRole", "Device roles", "DCIM"),
    ("api.PlatformGroup", "Platform groups", "DCIM"),
    ("api.Platform", "Platforms", "DCIM"),
    ("api.Manufacturer", "Manufacturers", "DCIM"),
    ("api.Rack", "Racks", "DCIM"),
    ("api.RackRole", "Rack roles", "DCIM"),
    ("api.RackType", "Rack types", "DCIM"),
    ("api.RackTypeAccessory", "Rack type accessories", "DCIM"),
    ("api.Interface", "Interfaces", "DCIM"),
    ("api.MACAddress", "MAC addresses", "DCIM"),
    ("api.FrontPort", "Front ports", "DCIM"),
    ("api.RearPort", "Rear ports", "DCIM"),
    ("api.ConsolePort", "Console ports", "DCIM"),
    ("api.ConsoleServerPort", "Console server ports", "DCIM"),
    ("api.PowerPort", "Power ports", "DCIM"),
    ("api.PowerOutlet", "Power outlets", "DCIM"),
    ("api.InterfaceTemplate", "Interface templates", "DCIM"),
    ("api.ConsolePortTemplate", "Console port templates", "DCIM"),
    ("api.ConsoleServerPortTemplate", "Console server port templates", "DCIM"),
    ("api.PowerPortTemplate", "Power port templates", "DCIM"),
    ("api.PowerOutletTemplate", "Power outlet templates", "DCIM"),
    ("api.RearPortTemplate", "Rear port templates", "DCIM"),
    ("api.FrontPortTemplate", "Front port templates", "DCIM"),
    ("api.Cable", "Cables", "DCIM"),
    ("api.CableRoute", "Cable routes", "DCIM"),
    ("api.VirtualChassis", "Virtual chassis", "DCIM"),
    ("api.FloorPlan", "Floor plans", "DCIM"),
    ("api.FloorPlanTile", "Floor-plan tiles", "DCIM"),
    ("api.FloorPlanTray", "Floor-plan cable trays", "DCIM"),
    ("api.FloorPlanRaisedFloorArea", "Floor-plan raised floors", "DCIM"),
    ("api.FloorPlanWall", "Floor-plan walls", "DCIM"),
    ("api.SiteMarker", "Site-map markers", "DCIM"),
    ("api.TopologyView", "Topology views", "DCIM"),
    ("api.AuxPort", "Aux ports", "DCIM"),
    ("api.AuxPortTemplate", "Aux port templates", "DCIM"),
    ("api.DeviceBay", "Device bays", "DCIM"),
    ("api.DeviceBayTemplate", "Device bay templates", "DCIM"),
    ("api.DeviceTypeService", "Device-type services", "DCIM"),
    ("api.Module", "Modules", "DCIM"),
    ("api.ModuleBay", "Module bays", "DCIM"),
    ("api.ModuleBayTemplate", "Module bay templates", "DCIM"),
    ("api.ModuleInterfaceTemplate", "Module interface templates", "DCIM"),
    ("api.InventoryItem", "Inventory items", "DCIM"),
    ("api.InventoryItemTemplate", "Inventory item templates", "DCIM"),
    # ─── Virtualization ─────────────────────────────────────────────
    ("api.Cluster", "Clusters", "Virtualization"),
    ("api.ClusterType", "Cluster types", "Virtualization"),
    ("api.ClusterGroup", "Cluster groups", "Virtualization"),
    ("api.VirtualMachine", "Virtual machines", "Virtualization"),
    ("api.VMInterface", "VM interfaces", "Virtualization"),
    # ─── Governance / monitoring ────────────────────────────────────
    ("monitoring.CheckTemplate", "Check templates", "Monitoring"),
    ("monitoring.CheckAssignment", "Check assignments", "Monitoring"),
    # SNMP profiles are credentials — unregistered they'd fall back to "any
    # tenant member may write", which is exactly wrong for secrets.
    ("monitoring.SnmpProfile", "SNMP profiles", "Monitoring"),
    # Device credentials link a device to an externally-stored secret. Danbyte
    # holds only the reference; revealing the secret is its own `reveal` verb.
    ("monitoring.DeviceCredential", "Device credentials", "Monitoring"),
    ("monitoring.ConnectProtocol", "Connect protocols", "Monitoring"),
    ("monitoring.SnmpSensor", "SNMP sensors", "Monitoring"),
    ("monitoring.WatchedEndpoint", "Watched endpoints", "Monitoring"),
    ("monitoring.RedfishEndpoint", "BMC (Redfish) endpoints", "Monitoring"),
    # Observed certificates are public data, but which endpoints a tenant
    # runs is not — so viewing the inventory is a grantable permission.
    ("monitoring.Certificate", "Certificates", "Monitoring"),
    # Bindings say *which of your endpoints* serve a certificate — the blast
    # radius of an expiry, and a map of your estate. Grantable separately.
    ("monitoring.CertificateBinding", "Certificate bindings", "Monitoring"),
    # Assignments are intent — which object *should* present a certificate.
    # Writable source of truth, so its own add/change/delete grant.
    ("monitoring.CertificateAssignment", "Certificate assignments", "Monitoring"),
    ("monitoring.CertificateRequest", "Certificate requests", "Monitoring"),
    ("monitoring.Issuer", "Certificate issuers", "Monitoring"),
    ("monitoring.AcmeOrder", "ACME orders", "Monitoring"),
    ("monitoring.SSHHostKey", "SSH host keys", "Monitoring"),
    ("monitoring.NotificationChannel", "Notification channels", "Monitoring"),
    ("monitoring.NotificationSubscription", "Notification subscriptions", "Monitoring"),
    ("monitoring.AlertRule", "Alert rules", "Monitoring"),
    ("monitoring.Silence", "Silences", "Monitoring"),
    ("monitoring.MaintenanceEvent", "Maintenance events", "Monitoring"),
    ("monitoring.EventImpact", "Event impacts", "Monitoring"),
    ("monitoring.MonitoringPolicy", "Monitoring policies", "Monitoring"),
    ("monitoring.MonitoringProfile", "Monitoring profiles", "Monitoring"),
    ("monitoring.MonitoringDenySubnet", "Monitoring deny subnets", "Monitoring"),
    ("compliance.ComplianceRule", "Compliance rules", "Governance"),
    # ─── Customize ──────────────────────────────────────────────────
    ("api.Status", "Statuses", "Customize"),
    # CustomField + CustomFieldGroup live in the `customization` app, not `api` —
    # the old "api.CustomField" path silently failed to resolve (LookupError →
    # skipped), leaving custom-field management RBAC-uncontrolled.
    ("customization.CustomField", "Custom fields", "Customize"),
    ("customization.CustomFieldGroup", "Custom field groups", "Customize"),
    ("api.ConfigContext", "Config contexts", "Customize"),
    ("api.ExportTemplate", "Export templates", "Customize"),
    ("api.LabelTemplate", "Label templates", "Customize"),
    ("api.DocumentCategory", "Document categories", "Customize"),
    # Documents (files/links) attach to any object; their own view/add/change/
    # delete grant. Row/site access follows the target object via object_site_id.
    ("api.Document", "Documents", "Records"),
    ("api.FloorTileType", "Floor tile types", "Customize"),
    ("core.Tag", "Tags", "Customize"),
    # ─── Integrations ───────────────────────────────────────────────
    ("integrations.Webhook", "Webhooks", "Integrations"),
    ("integrations.AutomationTarget", "Automation targets", "Integrations"),
    ("integrations.DeployRun", "Config deploy runs", "Integrations"),
    ("integrations.DeviceConfigSnapshot", "Device config snapshots", "Integrations"),
    ("integrations.DeviceConfigState", "Device config state", "Integrations"),
    ("integrations.WindowsServerConnection", "Windows server connections", "Integrations"),
    ("integrations.VirtualizationSource", "Virtualization sources", "Integrations"),
    ("integrations.DhcpScope", "DHCP scopes", "Integrations"),
    ("integrations.DhcpReservation", "DHCP reservations", "Integrations"),
    ("integrations.DhcpLease", "DHCP leases", "Integrations"),
    ("integrations.DnsZone", "DNS zones", "Integrations"),
    ("integrations.DnsDrift", "DNS drift", "Integrations"),
    ("integrations.VirtChange", "Virtualization changes", "Integrations"),
    # ─── Planning ───────────────────────────────────────────────────
    ("planning.Board", "Boards", "Planning"),
    ("planning.TaskStatus", "Task statuses", "Planning"),
    ("planning.TaskLabel", "Task labels", "Planning"),
    ("planning.Task", "Tasks", "Planning"),
    ("planning.TaskLink", "Task links", "Planning"),
    ("planning.Milestone", "Milestones", "Planning"),
    ("planning.PlannedChange", "Planned changes", "Planning"),
    # ─── Access (RBAC itself) ───────────────────────────────────────
    ("auth.User", "Users", "Access"),
    ("auth.Group", "Groups", "Access"),
    ("auth_api.ObjectPermission", "Permissions", "Access"),
]


# Dynamically-registered types — a plugin app appends here from its AppConfig
# (or its ``io.py``) so its models are RBAC-controlled + import/export-capable
# without editing this core list.
_DYNAMIC: list[tuple[str, str, str]] = []


def register_object_type(model_path: str, label: str, group: str) -> None:
    """Register a model (``"app_label.ModelName"``) as an RBAC object type.

    Lets a 3rd-party app expose its models to permissions + import/export. Call
    from the app's ``AppConfig.ready`` / ``io.py``. Idempotent.
    """
    if model_path not in {p for p, _, _ in _DYNAMIC + _ENTRIES}:
        _DYNAMIC.append((model_path, label, group))
        _registry.cache_clear()


@lru_cache(maxsize=1)
def _registry() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for path, label, group in _ENTRIES + _DYNAMIC:
        app_label, model_name = path.split(".")
        try:
            model = apps.get_model(app_label, model_name)
        except LookupError:
            continue
        out[model._meta.model_name] = {
            "model": model,
            "label": label,
            "group": group,
        }
    return out


def is_registered(slug: str) -> bool:
    return slug in _registry()


def model_for(slug: str):
    entry = _registry().get(slug)
    return entry["model"] if entry else None


def slug_for_model(model) -> str:
    return model._meta.model_name


def label_for(value: str) -> str | None:
    """Normalise an object-type reference — either an ``app.model`` label or a
    bare RBAC slug (``model_name``) — to the canonical ``app.model`` lower label,
    or ``None`` when it isn't a registered type.

    Generic-attachment callers (documents, journal notes) accept either form but
    must store the ``app.model`` label the view-permission gate
    (``django.apps.get_model``) resolves.
    """
    from django.apps import apps as _apps

    v = (value or "").strip()
    if not v:
        return None
    model = None
    if "." in v:
        try:
            model = _apps.get_model(v)
        except (LookupError, ValueError):
            model = None
    else:
        model = model_for(v)
    if model is None or not is_registered(model._meta.model_name):
        return None
    return model._meta.label_lower


def registry_payload() -> list[dict]:
    """[{slug, label, group, actions}] for the permission-form pickers. Each
    type advertises the CRUD verbs plus only the capability verbs it honours."""
    return [
        {
            "slug": slug,
            "label": e["label"],
            "group": e["group"],
            "actions": CRUD_ACTIONS + CAPABILITY_VERBS.get(slug, []),
        }
        for slug, e in _registry().items()
    ]
