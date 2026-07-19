from django.apps import AppConfig

# Models whose single-object create/update/delete are recorded in the change log.
AUDITED_MODELS = [
    "api.RouteTarget",
    "api.VRF",
    "api.Site",
    "api.Manufacturer",
    "api.DeviceType",
    "api.Device",
    "api.ImageAttachment",
    "api.VLAN",
    "api.Zone",
    "api.Prefix",
    "api.IPAddress",
    "api.MACAddress",
    "api.IPRange",
    "api.RIR",
    "api.Aggregate",
    "api.ASN",
    "api.VLANGroup",
    "api.FHRPGroup",
    "api.Contact",
    "api.ContactGroup",
    "api.ContactRole",
    "api.Provider",
    "api.ProviderNetwork",
    "api.CircuitType",
    "api.Circuit",
    "api.CircuitTermination",
    "api.PowerPanel",
    "api.PowerFeed",
    "api.WirelessLANGroup",
    "api.WirelessLAN",
    "api.TunnelGroup",
    "api.IPSecProfile",
    "api.Tunnel",
    "api.L2VPN",
    "api.L2VPNTermination",
    "api.VirtualChassis",
    "api.TunnelTermination",
    "api.Region",
    "api.Location",
    "api.ConfigContext",
    "api.ExportTemplate",
    "integrations.Webhook",
    "integrations.AutomationTarget",
    "api.Interface",
    "api.RearPort",
    "api.FrontPort",
    "api.ConsolePort",
    "api.ConsoleServerPort",
    "api.PowerPort",
    "api.PowerOutlet",
    "api.AuxPort",
    "api.InterfaceTemplate",
    "api.ConsolePortTemplate",
    "api.AuxPortTemplate",
    "api.DeviceBayTemplate",
    "api.InventoryItemTemplate",
    "api.TopologyView",
    "api.InventoryItem",
    "api.DeviceBay",
    "api.ModuleBayTemplate",
    "api.ModuleBay",
    "api.ModuleType",
    "api.ModuleInterfaceTemplate",
    "api.Module",
    "api.ConsoleServerPortTemplate",
    "api.PowerPortTemplate",
    "api.PowerOutletTemplate",
    "api.RearPortTemplate",
    "api.FrontPortTemplate",
    "api.Cable",
    "api.FiberSettings",
    "api.IPStatus",
    "api.IPRole",
    "api.ClusterType",
    "api.ClusterGroup",
    "api.Cluster",
    "api.VirtualMachine",
    "api.VMInterface",
    "api.RackRole",
    "api.Rack",
    "api.DeviceRole",
    "api.Platform",
    "api.Service",
    "api.ServiceTemplate",
    "api.DeviceTypeService",
    "api.FloorTileType",
    "api.FloorPlan",
    "api.FloorPlanTile",
    "api.SiteMarker",
    "api.FloorPlanTray",
    "api.CableRoute",
    # Customisation + monitoring config (not high-volume engine state).
    "customization.CustomField",
    "customization.CustomFieldGroup",
    "monitoring.CheckTemplate",
    "monitoring.CheckAssignment",
    "monitoring.AlertRule",
    "monitoring.NotificationChannel",
    "monitoring.Silence",
    "monitoring.MonitoringEngine",
    "monitoring.MonitoringEngineBinding",
    "monitoring.OutpostRelease",
    # Org-level objects.
    "core.Tenant",
    "core.TenantGroup",
    "core.Tag",
    "core.DeploymentSettings",
    "core.TenantSettings",
    "core.SiteSettings",
    "integrations.NetBoxImportRun",
    # Governance config.
    "compliance.ComplianceRule",
    # Access: object permissions + public share links.
]


class AuditConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "audit"

    def ready(self):
        from django.apps import apps

        from . import signals

        models = []
        for label in AUDITED_MODELS:
            app_label, model_name = label.split(".")
            try:
                models.append(apps.get_model(app_label, model_name))
            except LookupError:
                continue
        signals.connect(models)
