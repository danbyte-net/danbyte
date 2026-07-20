"""REST API URLs — mounted under /api/.

Separate from api/urls.py (which routes the legacy HTML pages — now in
reference/) so the JSON endpoints have a clean namespace. New endpoints
just register a viewset on the router.
"""
from __future__ import annotations

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from auth_api import column_prefs
from auth_api import views as auth_views
from auth_api.login_api import (
    login_api,
    logout_api,
    mfa_resend_api,
    mfa_verify_api,
    set_password_api,
    totp_confirm_api,
    totp_disable_api,
    totp_setup_api,
)
from auth_api.ldap_api import (
    LDAPGroupMappingViewSet,
    TenantLDAPGroupMappingViewSet,
    ldap_groups,
    ldap_settings,
    ldap_test,
    ldap_test_login,
    tenant_ldap_groups,
    tenant_ldap_settings,
    tenant_ldap_test,
    tenant_ldap_test_login,
)
from auth_api.token_api import ApiTokenViewSet
from auth_api.api import (
    GroupViewSet,
    ObjectPermissionViewSet,
    UserViewSet,
    rbac_object_types,
    create_site_role,
    user_access_summary,
)
from core import (
    deployment,
    site_settings as site_settings_mod,
    tenant_settings as tenant_settings_mod,
    upgrade,
)
from integrations.api import (
    WebhookViewSet, AutomationTargetViewSet, DeployRunViewSet,
    DeviceConfigStateViewSet, DeviceConfigSnapshotViewSet,
)
from integrations.netbox_api import (
    netbox_test, netbox_imports, netbox_import_detail,
)
from core.bookmarks import BookmarkFolderViewSet, BookmarkViewSet
from .search_views import search as search_view
from .csp_views import csp_report
from .dashboard_views import dashboard_view
from .site_map_views import site_map, site_map_cables, site_map_connections
from .presence_views import (
    presence_heartbeat, presence_list, presence_leave,
)
from audit.api import ChangeLogViewSet, JournalEntryViewSet
from customization.api_views import customization_meta, object_labels
from compliance.api import (
    ComplianceRuleViewSet,
    compliance_device_status,
    compliance_evaluate,
    compliance_object_types,
)
from .topology_views import topology_view
from .mac_views import mac_list_view, mac_detail_view
from .dcim_choices import dcim_choices_view
from .io_views import (
    io_types_view, io_fields_view, io_export_view, io_import_view,
)
from .inventory_views import ansible_inventory
from .terraform_views import vm_render_view
from .viewsets import (
    ClusterTypeViewSet,
    ClusterGroupViewSet,
    ClusterViewSet,
    VirtualMachineViewSet,
    VMInterfaceViewSet,
    MACAddressViewSet,
    RackViewSet,
    RackRoleViewSet,
    DeviceRoleViewSet,
    PlatformGroupViewSet,
    PlatformViewSet,
    ServiceViewSet,
    ServiceTemplateViewSet,
    CableViewSet,
    FiberSettingsViewSet,
    CustomFieldViewSet,
    CustomFieldGroupViewSet,
    DeviceTypeViewSet,
    DeviceViewSet,
    FrontPortViewSet,
    ManufacturerViewSet,
    RearPortViewSet,
    InterfaceViewSet,
    IPAddressViewSet,
    IPRangeViewSet,
    AggregateViewSet,
    ASNViewSet,
    VLANGroupViewSet,
    FHRPGroupViewSet,
    FHRPGroupAssignmentViewSet,
    ContactViewSet,
    ContactGroupViewSet,
    ContactRoleViewSet,
    ContactAssignmentViewSet,
    ProviderViewSet,
    ProviderNetworkViewSet,
    CircuitTypeViewSet,
    CircuitViewSet,
    CircuitTerminationViewSet,
    TunnelTerminationViewSet,
    TenantGroupViewSet, L2VPNViewSet, L2VPNTerminationViewSet,
    VirtualChassisViewSet,
    AuxPortViewSet,
    AuxPortTemplateViewSet,
    DeviceBayTemplateViewSet,
    DeviceBayViewSet,
    InventoryItemTemplateViewSet,
    InventoryItemViewSet,
    ModuleBayTemplateViewSet,
    ModuleBayViewSet,
    ModuleInterfaceTemplateViewSet,
    ModuleTypeViewSet,
    TopologyViewViewSet,
    FloorPlanTileViewSet,
    SiteMarkerViewSet,
    CableRouteViewSet,
    FloorPlanTrayViewSet,
    FloorPlanViewSet,
    FloorTileTypeViewSet,
    ModuleViewSet,
    ConsolePortViewSet,
    ConsoleServerPortViewSet,
    PowerPortViewSet,
    PowerOutletViewSet,
    InterfaceTemplateViewSet,
    DeviceTypeServiceViewSet,
    ConsolePortTemplateViewSet,
    ConsoleServerPortTemplateViewSet,
    PowerPortTemplateViewSet,
    PowerOutletTemplateViewSet,
    RearPortTemplateViewSet,
    FrontPortTemplateViewSet,
    PowerPanelViewSet,
    PowerFeedViewSet,
    WirelessLANGroupViewSet,
    WirelessLANViewSet,
    TunnelGroupViewSet,
    IPSecProfileViewSet,
    TunnelViewSet,
    RegionViewSet,
    LocationViewSet,
    ConfigContextViewSet,
    ExportTemplateViewSet,
    RIRViewSet,
    IPRoleViewSet,
    ZoneViewSet,
    StatusViewSet,
    PrefixViewSet,
    RouteTargetViewSet,
    SiteViewSet,
    TagViewSet,
    TenantViewSet,
    VLANViewSet,
    VRFViewSet,
)

router = DefaultRouter()
router.register(r"tenants",       TenantViewSet,      basename="tenant")
router.register(r"tenant-groups", TenantGroupViewSet, basename="tenant-group")
router.register(r"prefixes",      PrefixViewSet,      basename="prefix")
router.register(r"ips",           IPAddressViewSet,   basename="ip")
router.register(r"ip-ranges",     IPRangeViewSet,     basename="ip-range")
router.register(r"rirs",          RIRViewSet,         basename="rir")
router.register(r"aggregates",    AggregateViewSet,   basename="aggregate")
router.register(r"asns",          ASNViewSet,         basename="asn")
router.register(r"vrfs",          VRFViewSet,         basename="vrf")
router.register(r"route-targets", RouteTargetViewSet, basename="route-target")
router.register(r"sites",         SiteViewSet,        basename="site")
router.register(r"regions",       RegionViewSet,      basename="region")
router.register(r"locations",     LocationViewSet,    basename="location")
router.register(r"config-contexts", ConfigContextViewSet, basename="config-context")
router.register(r"export-templates", ExportTemplateViewSet, basename="export-template")
router.register(r"vlans",         VLANViewSet,        basename="vlan")
router.register(r"mac-addresses",  MACAddressViewSet,  basename="mac-address")
router.register(r"vlan-groups",   VLANGroupViewSet,   basename="vlan-group")
router.register(r"fhrp-groups",   FHRPGroupViewSet,   basename="fhrp-group")
router.register(r"fhrp-assignments", FHRPGroupAssignmentViewSet, basename="fhrp-assignment")
router.register(r"contacts",      ContactViewSet,     basename="contact")
router.register(r"contact-groups", ContactGroupViewSet, basename="contact-group")
router.register(r"contact-roles", ContactRoleViewSet,  basename="contact-role")
router.register(r"contact-assignments", ContactAssignmentViewSet, basename="contact-assignment")
router.register(r"providers",     ProviderViewSet,    basename="provider")
router.register(r"provider-networks", ProviderNetworkViewSet, basename="provider-network")
router.register(r"circuit-types", CircuitTypeViewSet, basename="circuit-type")
router.register(r"circuits",      CircuitViewSet,     basename="circuit")
router.register(r"circuit-terminations", CircuitTerminationViewSet, basename="circuit-termination")
router.register(r"tunnel-terminations", TunnelTerminationViewSet, basename="tunnel-termination")
router.register(r"l2vpns",        L2VPNViewSet,       basename="l2vpn")
router.register(r"l2vpn-terminations", L2VPNTerminationViewSet, basename="l2vpn-termination")
router.register(r"virtual-chassis", VirtualChassisViewSet, basename="virtual-chassis")
router.register(r"power-panels",  PowerPanelViewSet,  basename="power-panel")
router.register(r"power-feeds",   PowerFeedViewSet,   basename="power-feed")
router.register(r"wireless-lan-groups", WirelessLANGroupViewSet, basename="wireless-lan-group")
router.register(r"wireless-lans", WirelessLANViewSet, basename="wireless-lan")
router.register(r"tunnel-groups", TunnelGroupViewSet, basename="tunnel-group")
router.register(r"ipsec-profiles", IPSecProfileViewSet, basename="ipsec-profile")
router.register(r"tunnels",       TunnelViewSet,      basename="tunnel")
router.register(r"tags",          TagViewSet,         basename="tag")
router.register(r"site-markers",  SiteMarkerViewSet, basename="site-marker")
router.register(r"statuses",      StatusViewSet,    basename="status")
# Legacy alias — the page/API were renamed "statuses" (they cover every model,
# not just IPs); old integrations keep working.
router.register(r"ip-statuses",   StatusViewSet,    basename="ip-status")
router.register(r"ip-roles",      IPRoleViewSet,      basename="ip-role")
router.register(r"zones",         ZoneViewSet,        basename="zone")
router.register(r"manufacturers", ManufacturerViewSet, basename="manufacturer")
router.register(r"cluster-types", ClusterTypeViewSet, basename="cluster-type")
router.register(r"cluster-groups", ClusterGroupViewSet, basename="cluster-group")
router.register(r"clusters",      ClusterViewSet,     basename="cluster")
router.register(r"virtual-machines", VirtualMachineViewSet, basename="virtual-machine")
router.register(r"vm-interfaces",  VMInterfaceViewSet, basename="vm-interface")
router.register(r"racks",         RackViewSet,        basename="rack")
router.register(r"rack-roles",    RackRoleViewSet,    basename="rack-role")
router.register(r"device-roles",  DeviceRoleViewSet,  basename="device-role")
router.register(r"platform-groups", PlatformGroupViewSet, basename="platform-group")
router.register(r"platforms",     PlatformViewSet,    basename="platform")
router.register(r"services",      ServiceViewSet,     basename="service")
router.register(r"service-templates", ServiceTemplateViewSet, basename="service-template")
router.register(r"device-types",  DeviceTypeViewSet,  basename="device-type")
router.register(r"devices",       DeviceViewSet,      basename="device")
router.register(r"interfaces",    InterfaceViewSet,   basename="interface")
router.register(r"rear-ports",    RearPortViewSet,    basename="rear-port")
router.register(r"front-ports",   FrontPortViewSet,   basename="front-port")
router.register(r"console-ports", ConsolePortViewSet, basename="console-port")
router.register(r"console-server-ports", ConsoleServerPortViewSet, basename="console-server-port")
router.register(r"power-ports",   PowerPortViewSet,   basename="power-port")
router.register(r"power-outlets", PowerOutletViewSet, basename="power-outlet")
router.register(r"aux-ports",     AuxPortViewSet,     basename="aux-port")
router.register(r"interface-templates", InterfaceTemplateViewSet, basename="interface-template")
router.register(r"device-type-services", DeviceTypeServiceViewSet, basename="device-type-service")
router.register(r"console-port-templates", ConsolePortTemplateViewSet, basename="console-port-template")
router.register(r"console-server-port-templates", ConsoleServerPortTemplateViewSet, basename="console-server-port-template")
router.register(r"power-port-templates", PowerPortTemplateViewSet, basename="power-port-template")
router.register(r"power-outlet-templates", PowerOutletTemplateViewSet, basename="power-outlet-template")
router.register(r"rear-port-templates", RearPortTemplateViewSet, basename="rear-port-template")
router.register(r"front-port-templates", FrontPortTemplateViewSet, basename="front-port-template")
router.register(r"aux-port-templates", AuxPortTemplateViewSet, basename="aux-port-template")
router.register(r"device-bay-templates", DeviceBayTemplateViewSet, basename="device-bay-template")
router.register(r"inventory-item-templates", InventoryItemTemplateViewSet, basename="inventory-item-template")
router.register(r"inventory-items", InventoryItemViewSet, basename="inventory-item")
router.register(r"device-bays", DeviceBayViewSet, basename="device-bay")
router.register(r"module-bay-templates", ModuleBayTemplateViewSet, basename="module-bay-template")
router.register(r"module-bays", ModuleBayViewSet, basename="module-bay")
router.register(r"module-types", ModuleTypeViewSet, basename="module-type")
router.register(r"topology-views", TopologyViewViewSet, basename="topology-view")
router.register(r"floor-tile-types", FloorTileTypeViewSet, basename="floor-tile-type")
router.register(r"floor-plans", FloorPlanViewSet, basename="floor-plan")
router.register(r"floor-plan-tiles", FloorPlanTileViewSet, basename="floor-plan-tile")
router.register(r"floor-plan-trays", FloorPlanTrayViewSet, basename="floor-plan-tray")
router.register(r"cable-routes", CableRouteViewSet, basename="cable-route")
router.register(r"module-interface-templates", ModuleInterfaceTemplateViewSet, basename="module-interface-template")
router.register(r"modules", ModuleViewSet, basename="module")
router.register(r"cables",        CableViewSet,       basename="cable")
router.register(r"fiber-settings", FiberSettingsViewSet, basename="fiber-settings")
router.register(r"custom-fields", CustomFieldViewSet, basename="custom-field")
router.register(r"custom-field-groups", CustomFieldGroupViewSet, basename="custom-field-group")
router.register(r"changelog",     ChangeLogViewSet,   basename="changelog")
router.register(r"bookmarks",     BookmarkViewSet,    basename="bookmark")
router.register(r"bookmark-folders", BookmarkFolderViewSet, basename="bookmark-folder")
router.register(r"api-tokens",    ApiTokenViewSet,    basename="api-token")
router.register(r"webhooks",      WebhookViewSet,     basename="webhook")
router.register(r"automation-targets", AutomationTargetViewSet, basename="automation-target")
router.register(r"deploy-runs",   DeployRunViewSet,   basename="deploy-run")
router.register(r"config-states", DeviceConfigStateViewSet, basename="config-state")
router.register(r"config-snapshots", DeviceConfigSnapshotViewSet, basename="config-snapshot")
router.register(r"journal",       JournalEntryViewSet, basename="journal")
router.register(r"compliance-rules", ComplianceRuleViewSet, basename="compliance-rule")
router.register(r"users",         UserViewSet,        basename="user")
router.register(r"groups",        GroupViewSet,       basename="group")
router.register(r"object-permissions", ObjectPermissionViewSet, basename="object-permission")
router.register(r"ldap-group-mappings", LDAPGroupMappingViewSet, basename="ldap-group-mapping")
router.register(r"tenant-ldap-group-mappings", TenantLDAPGroupMappingViewSet, basename="tenant-ldap-group-mapping")

urlpatterns = [
    path("dashboard/", dashboard_view, name="dashboard"),
    path("site-map/", site_map, name="site-map"),
    path("site-map/connections/", site_map_connections, name="site-map-connections"),
    path("site-map/cables/", site_map_cables, name="site-map-cables"),
    path("presence/heartbeat/", presence_heartbeat, name="presence-heartbeat"),
    path("presence/leave/", presence_leave, name="presence-leave"),
    path("presence/", presence_list, name="presence-list"),
    path("compliance/evaluate/", compliance_evaluate, name="compliance-evaluate"),
    path("compliance/object-types/", compliance_object_types, name="compliance-object-types"),
    path("compliance/devices/<uuid:device_id>/", compliance_device_status,
         name="compliance-device-status"),
    path("rbac/object-types/", rbac_object_types, name="rbac-object-types"),
    path("rbac/site-role/", create_site_role, name="rbac-site-role"),
    path("users/<int:user_id>/access-summary/", user_access_summary,
         name="user-access-summary"),
    path("inventory/ansible/", ansible_inventory, name="inventory-ansible"),
    path("virtual-machines/<uuid:pk>/render/", vm_render_view, name="vm-render"),
    # Generic round-trip export/import (any IO-capable object type).
    path("io/types/", io_types_view, name="io-types"),
    path("io/<slug:slug>/fields/", io_fields_view, name="io-fields"),
    path("io/<slug:slug>/export/", io_export_view, name="io-export"),
    path("io/<slug:slug>/import/", io_import_view, name="io-import"),
    # NetBox instance migration (tenant-admin; runs on the RQ low queue).
    path("netbox-import/test/", netbox_test, name="netbox-import-test"),
    path("netbox-import/", netbox_imports, name="netbox-imports"),
    path("netbox-import/<uuid:run_id>/", netbox_import_detail,
         name="netbox-import-detail"),
    path("search/", search_view, name="search"),
    # CSP violation report sink (unauthenticated; the browser posts here per the
    # Content-Security-Policy report-uri set at the nginx edge).
    path("csp-report/", csp_report, name="csp-report"),
    path("topology/", topology_view, name="topology"),
    path("customization/meta/", customization_meta, name="customization-meta"),
    path("customization/object-labels/", object_labels, name="customization-object-labels"),
    path("macs/", mac_list_view, name="macs"),
    path("macs/<str:mac>/", mac_detail_view, name="mac-detail"),
    path("dcim/choices/", dcim_choices_view, name="dcim-choices"),
    path("monitoring/", include("monitoring.api_urls")),
    path("outpost/", include("monitoring.outpost_urls")),
    # Background job queue admin (RQ introspection) — gated on jobs.manage.
    path("jobs/", include("jobs.api_urls")),
    # Identity + per-table column preferences for the React frontend. The
    # auth_api HTML urlconf isn't mounted (archived), so these JSON views are
    # surfaced here under /api/ where the SPA can reach them.
    path("me/", auth_views.me_json, name="me"),
    path("me/prefs/", auth_views.me_prefs, name="me-prefs"),
    # Session login + MFA for the React SPA (two-step: password → code).
    path("auth/login/", login_api, name="auth-login"),
    path("auth/logout/", logout_api, name="auth-logout"),
    path("auth/set-password/", set_password_api, name="auth-set-password"),
    path("auth/mfa/verify/", mfa_verify_api, name="auth-mfa-verify"),
    path("auth/mfa/resend/", mfa_resend_api, name="auth-mfa-resend"),
    path("auth/mfa/totp/setup/", totp_setup_api, name="auth-totp-setup"),
    path("auth/mfa/totp/confirm/", totp_confirm_api, name="auth-totp-confirm"),
    path("auth/mfa/totp/disable/", totp_disable_api, name="auth-totp-disable"),
    # Deployment-wide Email & Delivery settings (Admin / users.manage).
    path("deployment/email/", deployment.deployment_settings,
         name="deployment-email"),
    path("deployment/email/test/", deployment.deployment_test_email,
         name="deployment-email-test"),
    # Custom browser-tab favicon (upload / clear) — users.manage only.
    path("deployment/favicon/", deployment.deployment_favicon,
         name="deployment-favicon"),
    # Optional built-in device fields — admin-controlled visibility.
    path("deployment/device-fields/", deployment.device_field_visibility,
         name="deployment-device-fields"),
    # Floor-plan tile popover — deployment default (the tenant override rides
    # tenant-settings/, like device fields).
    path("deployment/floorplan-popover/", deployment.floorplan_popover,
         name="deployment-floorplan-popover"),
    # Per-tenant overrides (tenant admins; see core/tenant_settings.py).
    path("tenant-settings/", tenant_settings_mod.tenant_settings,
         name="tenant-settings"),
    path("tenant-settings/email/test/", tenant_settings_mod.tenant_test_email,
         name="tenant-settings-email-test"),
    # Per-SITE settings (email v1) — site-admin gated, see core.site_settings.
    path("sites/<uuid:site_id>/settings/", site_settings_mod.site_settings,
         name="site-settings"),
    path("sites/<uuid:site_id>/settings/email/test/",
         site_settings_mod.site_test_email, name="site-settings-email-test"),
    # This tenant's floor-plan popover config (tenant admin).
    path("tenant-settings/floorplan-popover/",
         tenant_settings_mod.tenant_floorplan_popover,
         name="tenant-floorplan-popover"),
    # Effective device-field visibility — readable by any member.
    path("device-fields/", tenant_settings_mod.device_fields_view,
         name="device-fields"),
    # Effective floor-plan popover config — readable by any member (the canvas
    # needs it to render a popover at all).
    path("floorplan-popover/", tenant_settings_mod.floorplan_popover_view,
         name="floorplan-popover"),
    # The default prefix for the caller's own site, if they have exactly one.
    path("my-default-prefix/", tenant_settings_mod.my_default_prefix,
         name="my-default-prefix"),
    # In-app updates — current version + available releases (users.manage).
    path("health/", deployment.health, name="health"),
    path("system/info/", deployment.system_info, name="system-info"),
    path("system/updates/", deployment.system_updates, name="system-updates"),
    path("system/upgrade/", upgrade.system_upgrade, name="system-upgrade"),
    path("system/upgrade/upload/", upgrade.system_upgrade_upload,
         name="system-upgrade-upload"),
    path("system/upgrade/status/", upgrade.system_upgrade_status,
         name="system-upgrade-status"),
    path("system/upgrade/cancel/", upgrade.system_upgrade_cancel,
         name="system-upgrade-cancel"),
    # LDAP / Active Directory (admin, users.manage).
    path("deployment/ldap/", ldap_settings, name="deployment-ldap"),
    path("deployment/ldap/test/", ldap_test, name="deployment-ldap-test"),
    path("deployment/ldap/test-login/", ldap_test_login, name="deployment-ldap-test-login"),
    path("deployment/ldap/groups/", ldap_groups, name="deployment-ldap-groups"),
    # Per-tenant directory override (tenant admins).
    path("tenant-settings/ldap/", tenant_ldap_settings, name="tenant-ldap"),
    path("tenant-settings/ldap/test/", tenant_ldap_test, name="tenant-ldap-test"),
    path("tenant-settings/ldap/test-login/", tenant_ldap_test_login,
         name="tenant-ldap-test-login"),
    path("tenant-settings/ldap/groups/", tenant_ldap_groups,
         name="tenant-ldap-groups"),
    path("prefs/columns/", column_prefs.column_prefs_bulk, name="column-prefs-bulk"),
    path("prefs/columns/<slug:table_id>/", column_prefs.column_pref,
         name="column-pref"),
    path("prefs/columns/<slug:table_id>/default/",
         column_prefs.column_pref_default, name="column-pref-default"),
    *router.urls,
]
