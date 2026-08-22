"""REST API URLs - mounted under /api/.

Separate from api/urls.py (which routes the legacy HTML pages - now in
reference/) so the JSON endpoints have a clean namespace. New endpoints
just register a viewset on the router.
"""
from __future__ import annotations

from django.urls import include, path
from django.views.generic import RedirectView
from drf_spectacular.views import (
    SpectacularAPIView,
    SpectacularRedocView,
    SpectacularSwaggerView,
)
from rest_framework.routers import DefaultRouter

from audit.api import ChangeLogViewSet, JournalEntryViewSet
from auth_api import column_prefs, dashboard_prefs
from auth_api import views as auth_views
from auth_api.api import (
    GroupViewSet,
    ObjectPermissionViewSet,
    UserViewSet,
    create_site_role,
    rbac_object_types,
    user_access_summary,
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
from auth_api.sso_admin import IdentityProviderViewSet, SsoGroupMappingViewSet
from auth_api.sso_api import (
    sso_acs,
    sso_callback,
    sso_login,
    sso_metadata,
    sso_providers,
)
from auth_api.token_api import ApiTokenViewSet
from compliance.api import (
    ComplianceRuleViewSet,
    compliance_device_status,
    compliance_evaluate,
    compliance_object_types,
)
from core import (
    deployment,
    service_api,
    upgrade,
)
from core import notifications_api as core_notifications
from core import (
    site_settings as site_settings_mod,
)
from core import (
    tenant_settings as tenant_settings_mod,
)
from core.bookmarks import BookmarkFolderViewSet, BookmarkViewSet
from core.saved_filters import SavedFilterViewSet
from customization.api_views import customization_meta, object_labels
from integrations.api import (
    AutomationTargetViewSet,
    DeployRunViewSet,
    DeviceConfigSnapshotViewSet,
    DeviceConfigStateViewSet,
    WebhookViewSet,
)
from integrations.dns_api import (
    DnsDriftViewSet,
    DnsRecordViewSet,
    DnsZoneViewSet,
)
from integrations.virt_api import (
    VirtChangeViewSet,
    VirtNetworkViewSet,
    VirtPlacementRuleViewSet,
)
from integrations.dhcp_api import (
    DhcpLeaseViewSet,
    DhcpReservationViewSet,
    DhcpScopeViewSet,
)
from integrations.connections_api import (
    VirtualizationSourceViewSet,
    WindowsServerConnectionViewSet,
    integration_settings,
    integrations_enabled,
)
from integrations.netbox_api import (
    netbox_import_detail,
    netbox_imports,
    netbox_test,
)

from .csp_views import csp_report
from .dashboard_views import dashboard_view
from .dcim_choices import dcim_choices_view
from .editable_fields import editable_fields_view
from .inventory_views import ansible_inventory
from .io_views import (
    io_export_view,
    io_fields_view,
    io_import_view,
    io_types_view,
)
from .mac_views import mac_detail_view, mac_list_view
from .presence_views import (
    presence_heartbeat,
    presence_leave,
    presence_list,
)
from .search_views import search as search_view
from .site_map_views import site_map, site_map_cables, site_map_connections
from .terraform_views import vm_render_view
from .topology_views import (
    topology_logical_view,
    topology_summary_view,
    topology_view,
)
from .viewsets import (
    AggregateViewSet,
    ASNViewSet,
    AuxPortTemplateViewSet,
    AuxPortViewSet,
    CableRouteViewSet,
    CableViewSet,
    CircuitTerminationViewSet,
    CircuitTypeViewSet,
    CircuitViewSet,
    ClusterGroupViewSet,
    ClusterTypeViewSet,
    ClusterViewSet,
    ConfigContextViewSet,
    ConsolePortTemplateViewSet,
    ConsolePortViewSet,
    ConsoleServerPortTemplateViewSet,
    ConsoleServerPortViewSet,
    ContactAssignmentViewSet,
    ContactGroupViewSet,
    ContactRoleViewSet,
    ContactViewSet,
    CustomFieldGroupViewSet,
    CustomFieldViewSet,
    DeviceBayTemplateViewSet,
    DeviceBayViewSet,
    DeviceRoleViewSet,
    DeviceTypeServiceViewSet,
    DeviceTypeViewSet,
    DeviceViewSet,
    DocumentCategoryViewSet,
    DocumentViewSet,
    ExportTemplateViewSet,
    FHRPGroupAssignmentViewSet,
    FHRPGroupViewSet,
    FiberSettingsViewSet,
    FloorPlanRaisedFloorAreaViewSet,
    FloorPlanTileViewSet,
    FloorPlanTrayViewSet,
    FloorPlanViewSet,
    FloorPlanWallViewSet,
    FloorTileTypeViewSet,
    FrontPortTemplateViewSet,
    FrontPortViewSet,
    InterfaceTemplateViewSet,
    InterfaceViewSet,
    InventoryItemTemplateViewSet,
    InventoryItemViewSet,
    IPAddressViewSet,
    IPRangeViewSet,
    IPRoleViewSet,
    IPSecProfileViewSet,
    L2VPNTerminationViewSet,
    L2VPNViewSet,
    LabelTemplateViewSet,
    LocationViewSet,
    MACAddressViewSet,
    ManufacturerViewSet,
    ModuleBayTemplateViewSet,
    ModuleBayViewSet,
    ModuleInterfaceTemplateViewSet,
    ModuleTypeViewSet,
    ModuleViewSet,
    PlatformGroupViewSet,
    PlatformViewSet,
    PortReservationViewSet,
    PowerFeedViewSet,
    PowerOutletTemplateViewSet,
    PowerOutletViewSet,
    PowerPanelViewSet,
    PowerPortTemplateViewSet,
    PowerPortViewSet,
    PrefixViewSet,
    ProviderNetworkViewSet,
    ProviderViewSet,
    RackRoleViewSet,
    RackTypeAccessoryViewSet,
    RackTypeViewSet,
    RackViewSet,
    RearPortTemplateViewSet,
    RearPortViewSet,
    RegionViewSet,
    RIRViewSet,
    RouteTargetViewSet,
    ServiceTemplateViewSet,
    ServiceViewSet,
    SiteMarkerViewSet,
    SiteViewSet,
    StatusViewSet,
    TagViewSet,
    TenantGroupViewSet,
    TenantViewSet,
    TopologyViewViewSet,
    TunnelGroupViewSet,
    TunnelTerminationViewSet,
    TunnelViewSet,
    VirtualChassisViewSet,
    VirtualMachineViewSet,
    VirtualSwitchViewSet,
    VLANGroupViewSet,
    VLANViewSet,
    VMInterfaceViewSet,
    VRFViewSet,
    WirelessLANGroupViewSet,
    WirelessLANViewSet,
    ZoneViewSet,
    resolve_shortlink,
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
router.register(r"label-templates", LabelTemplateViewSet, basename="label-template")
router.register(r"documents",     DocumentViewSet,    basename="document")
router.register(r"document-categories", DocumentCategoryViewSet, basename="document-category")
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
# Legacy alias - the page/API were renamed "statuses" (they cover every model,
# not just IPs); old integrations keep working.
router.register(r"ip-statuses",   StatusViewSet,    basename="ip-status")
router.register(r"ip-roles",      IPRoleViewSet,      basename="ip-role")
router.register(r"zones",         ZoneViewSet,        basename="zone")
router.register(r"manufacturers", ManufacturerViewSet, basename="manufacturer")
router.register(r"cluster-types", ClusterTypeViewSet, basename="cluster-type")
router.register(r"cluster-groups", ClusterGroupViewSet, basename="cluster-group")
router.register(r"clusters",      ClusterViewSet,     basename="cluster")
router.register(r"virtual-machines", VirtualMachineViewSet, basename="virtual-machine")
router.register(r"virtual-switches", VirtualSwitchViewSet, basename="virtual-switch")
router.register(r"vm-interfaces",  VMInterfaceViewSet, basename="vm-interface")
router.register(r"racks",         RackViewSet,        basename="rack")
router.register(r"rack-roles",    RackRoleViewSet,    basename="rack-role")
router.register(r"rack-types",    RackTypeViewSet,    basename="rack-type")
router.register(r"rack-type-accessories", RackTypeAccessoryViewSet,
                basename="rack-type-accessory")
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
router.register(
    r"floor-plan-raised-floors",
    FloorPlanRaisedFloorAreaViewSet,
    basename="floor-plan-raised-floor",
)
router.register(
    r"floor-plan-walls", FloorPlanWallViewSet, basename="floor-plan-wall"
)
router.register(r"cable-routes", CableRouteViewSet, basename="cable-route")
router.register(r"module-interface-templates", ModuleInterfaceTemplateViewSet, basename="module-interface-template")
router.register(r"modules", ModuleViewSet, basename="module")
router.register(r"cables",        CableViewSet,       basename="cable")
router.register(r"port-reservations", PortReservationViewSet, basename="port-reservation")
router.register(r"fiber-settings", FiberSettingsViewSet, basename="fiber-settings")
router.register(r"custom-fields", CustomFieldViewSet, basename="custom-field")
router.register(r"custom-field-groups", CustomFieldGroupViewSet, basename="custom-field-group")
router.register(r"changelog",     ChangeLogViewSet,   basename="changelog")
router.register(r"bookmarks",     BookmarkViewSet,    basename="bookmark")
router.register(r"bookmark-folders", BookmarkFolderViewSet, basename="bookmark-folder")
router.register(r"saved-filters", SavedFilterViewSet, basename="saved-filter")
router.register(r"api-tokens",    ApiTokenViewSet,    basename="api-token")
router.register(r"webhooks",      WebhookViewSet,     basename="webhook")
router.register(r"automation-targets", AutomationTargetViewSet, basename="automation-target")
router.register(r"windows-connections", WindowsServerConnectionViewSet,
                basename="windows-connection")
router.register(r"virtualization-sources", VirtualizationSourceViewSet,
                basename="virtualization-source")
router.register(r"dhcp-scopes", DhcpScopeViewSet, basename="dhcp-scope")
router.register(r"dhcp-reservations", DhcpReservationViewSet,
                basename="dhcp-reservation")
router.register(r"dhcp-leases", DhcpLeaseViewSet, basename="dhcp-lease")
router.register(r"dns-zones", DnsZoneViewSet, basename="dns-zone")
router.register(r"dns-drifts", DnsDriftViewSet, basename="dns-drift")
router.register(r"dns-records", DnsRecordViewSet, basename="dns-record")
router.register(r"virt-changes", VirtChangeViewSet, basename="virt-change")
router.register(r"virt-networks", VirtNetworkViewSet, basename="virt-network")
router.register(r"virt-placement-rules", VirtPlacementRuleViewSet,
                basename="virt-placement-rule")
router.register(r"deploy-runs",   DeployRunViewSet,   basename="deploy-run")
router.register(r"config-states", DeviceConfigStateViewSet, basename="config-state")
router.register(r"config-snapshots", DeviceConfigSnapshotViewSet, basename="config-snapshot")
router.register(r"journal",       JournalEntryViewSet, basename="journal")
router.register(r"compliance-rules", ComplianceRuleViewSet, basename="compliance-rule")
router.register(r"users",         UserViewSet,        basename="user")
router.register(r"groups",        GroupViewSet,       basename="group")
router.register(r"object-permissions", ObjectPermissionViewSet, basename="object-permission")
router.register(r"ldap-group-mappings", LDAPGroupMappingViewSet, basename="ldap-group-mapping")
router.register(r"identity-providers", IdentityProviderViewSet, basename="identity-provider")
router.register(r"sso-group-mappings", SsoGroupMappingViewSet, basename="sso-group-mapping")
router.register(r"tenant-ldap-group-mappings", TenantLDAPGroupMappingViewSet, basename="tenant-ldap-group-mapping")

urlpatterns = [
    # OpenAPI schema + interactive reference. /api/ lands on the docs so hitting
    # the API root gives the object-grouped reference, not the raw router index.
    path("schema/", SpectacularAPIView.as_view(), name="schema"),
    path("docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="docs"),
    path("docs/redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
    path("", RedirectView.as_view(pattern_name="docs", permanent=False), name="api-root"),

    path("dashboard/", dashboard_view, name="dashboard"),
    path("site-map/", site_map, name="site-map"),
    path("site-map/connections/", site_map_connections, name="site-map-connections"),
    path("site-map/cables/", site_map_cables, name="site-map-cables"),
    path("resolve/", resolve_shortlink, name="resolve-shortlink"),
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
    path("integrations/settings/", integration_settings,
         name="integration-settings"),
    path("integrations/enabled/", integrations_enabled,
         name="integrations-enabled"),
    path("netbox-import/test/", netbox_test, name="netbox-import-test"),
    path("netbox-import/", netbox_imports, name="netbox-imports"),
    path("netbox-import/<uuid:run_id>/", netbox_import_detail,
         name="netbox-import-detail"),
    path("search/", search_view, name="search"),
    # CSP violation report sink (unauthenticated; the browser posts here per the
    # Content-Security-Policy report-uri set at the nginx edge).
    path("csp-report/", csp_report, name="csp-report"),
    path("topology/", topology_view, name="topology"),
    path("topology/logical/", topology_logical_view, name="topology-logical"),
    path("topology/summary/", topology_summary_view, name="topology-summary"),
    path("customization/meta/", customization_meta, name="customization-meta"),
    path("customization/object-labels/", object_labels, name="customization-object-labels"),
    path("macs/", mac_list_view, name="macs"),
    path("macs/<str:mac>/", mac_detail_view, name="mac-detail"),
    path("dcim/choices/", dcim_choices_view, name="dcim-choices"),
    path("editable-fields/", editable_fields_view, name="editable-fields"),
    path("monitoring/", include("monitoring.api_urls")),
    path("planning/", include("planning.api_urls")),
    path("outpost/", include("monitoring.outpost_urls")),
    # Background job queue admin (RQ introspection) - gated on jobs.manage.
    path("jobs/", include("jobs.api_urls")),
    # Plugin framework: installed-plugin inventory + each plugin's own API.
    path("plugins/", include("plugins.api_urls")),
    # Host service control (restart units, apply plugins) - superuser only.
    # Lives under system/ because /api/services/ is the SERVICE resource (a
    # network service on a device or VM). These paths are declared before the
    # router, so while they sat on "services/" they shadowed its list route and
    # POST /api/services/ answered 405 - services could not be created at all.
    path("system/services/", service_api.services_list, name="services-list"),
    path("system/services/workers/", service_api.set_workers,
         name="services-workers"),
    path("system/services/restart-all/", service_api.restart_danbyte,
         name="services-restart-all"),
    path("system/services/<str:key>/restart/", service_api.service_restart,
         name="service-restart"),
    # Identity + per-table column preferences for the React frontend. The
    # auth_api HTML urlconf isn't mounted (archived), so these JSON views are
    # surfaced here under /api/ where the SPA can reach them.
    path("me/", auth_views.me_json, name="me"),
    path("timezones/", auth_views.timezones_json, name="timezones"),
    path("me/prefs/", auth_views.me_prefs, name="me-prefs"),
    path("notifications/", core_notifications.notifications, name="notifications"),
    path("notifications/read/", core_notifications.notifications_read,
         name="notifications-read"),
    # Session login + MFA for the React SPA (two-step: password → code).
    path("auth/login/", login_api, name="auth-login"),
    path("auth/logout/", logout_api, name="auth-logout"),
    # Single sign-on (OIDC): public provider list + login/callback per provider.
    path("auth/sso/providers/", sso_providers, name="sso-providers"),
    path("auth/sso/<slug:slug>/login/", sso_login, name="sso-login"),
    path("auth/sso/<slug:slug>/callback/", sso_callback, name="sso-callback"),
    path("auth/sso/<slug:slug>/acs/", sso_acs, name="sso-acs"),
    path("auth/sso/<slug:slug>/metadata/", sso_metadata, name="sso-metadata"),
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
    # Preview the redesigned email templates: list + send a sample (or all) to
    # an entered address using Danbyte's SMTP config.
    path("deployment/email/templates/", deployment.email_templates,
         name="deployment-email-templates"),
    path("deployment/email/preview/", deployment.email_send_preview,
         name="deployment-email-preview"),
    # Emergency "sign everyone out" - deletes all sessions (users.manage).
    path("deployment/end-all-sessions/", deployment.deployment_end_all_sessions,
         name="deployment-end-all-sessions"),
    # Custom browser-tab favicon (upload / clear) - users.manage only.
    path("deployment/favicon/", deployment.deployment_favicon,
         name="deployment-favicon"),
    path("deployment/logo/", deployment.deployment_logo,
         name="deployment-logo"),
    # Optional built-in device fields - admin-controlled visibility.
    path("deployment/device-fields/", deployment.device_field_visibility,
         name="deployment-device-fields"),
    # Floor-plan tile popover - deployment default (the tenant override rides
    # tenant-settings/, like device fields).
    path("deployment/floorplan-popover/", deployment.floorplan_popover,
         name="deployment-floorplan-popover"),
    path("deployment/component-popover/", deployment.component_popover,
         name="deployment-component-popover"),
    path("component-popover/", deployment.component_popover_effective,
         name="component-popover"),
    # Per-tenant overrides (tenant admins; see core/tenant_settings.py).
    path("tenant-settings/", tenant_settings_mod.tenant_settings,
         name="tenant-settings"),
    path("tenant-settings/email/test/", tenant_settings_mod.tenant_test_email,
         name="tenant-settings-email-test"),
    path("tenant-settings/digest/test/", tenant_settings_mod.tenant_test_digest,
         name="tenant-settings-digest-test"),
    # First-run onboarding wizard state (any tenant member; core/tenant_settings).
    path("onboarding/", tenant_settings_mod.onboarding_state, name="onboarding"),
    # Per-SITE settings (email v1) - site-admin gated, see core.site_settings.
    path("sites/<uuid:site_id>/settings/", site_settings_mod.site_settings,
         name="site-settings"),
    path("sites/<uuid:site_id>/settings/email/test/",
         site_settings_mod.site_test_email, name="site-settings-email-test"),
    # This tenant's floor-plan popover config (tenant admin).
    path("tenant-settings/floorplan-popover/",
         tenant_settings_mod.tenant_floorplan_popover,
         name="tenant-floorplan-popover"),
    # Effective device-field visibility - readable by any member.
    path("device-fields/", tenant_settings_mod.device_fields_view,
         name="device-fields"),
    # Effective floor-plan popover config - readable by any member (the canvas
    # needs it to render a popover at all).
    path("floorplan-popover/", tenant_settings_mod.floorplan_popover_view,
         name="floorplan-popover"),
    # The default prefix for the caller's own site, if they have exactly one.
    path("my-default-prefix/", tenant_settings_mod.my_default_prefix,
         name="my-default-prefix"),
    # In-app updates - current version + available releases (users.manage).
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
    path("prefs/dashboard/", dashboard_prefs.dashboard_pref,
         name="dashboard-pref"),
    path("prefs/columns/", column_prefs.column_prefs_bulk, name="column-prefs-bulk"),
    path("prefs/columns/<slug:table_id>/", column_prefs.column_pref,
         name="column-pref"),
    path("prefs/columns/<slug:table_id>/default/",
         column_prefs.column_pref_default, name="column-pref-default"),
    *router.urls,
]
