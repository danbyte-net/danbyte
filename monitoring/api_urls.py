"""Monitoring URLs — included under ``/api/monitoring/`` from api.api_urls.

A DefaultRouter for the CRUD viewsets plus function views for per-IP actions.
"""
from __future__ import annotations

from django.urls import path
from rest_framework.routers import DefaultRouter

from .viewsets import (
    AlertRuleViewSet,
    CheckAssignmentViewSet,
    CheckTemplateViewSet,
    MonitoringDenySubnetViewSet,
    MonitoringEngineViewSet,
    MonitoringPolicyViewSet,
    MonitoringProfileViewSet,
    NotificationChannelViewSet,
    OutpostReleaseViewSet,
    SilenceViewSet,
    SnmpProfileViewSet,
)
from .views import (
    alert_ack_view,
    alerts_view,
    bulk_check_now_view,
    bulk_discover_view,
    flapping_view,
    bulk_status_view,
    check_now_view,
    check_run_view,
    checks_list_view,
    device_checks_view,
    device_snmp_drift_view,
    device_snmp_sync_view,
    snmp_drift_list_view,
    snmp_topology_ghosts_view,
    materialize_cable_view,
    device_snmp_poll_view,
    device_snmp_reconcile_view,
    device_snmp_utilization_view,
    device_snmp_view,
    discover_run_view,
    prefix_nmap_sweep_view,
    snmp_binding_view,
    ip_checks_view,
    ip_history_view,
    ip_uptime_view,
    prefix_checks_view,
    prefix_discover_view,
    engine_binding_view,
    engine_health_view,
    settings_view,
    stats_view,
)

router = DefaultRouter()
router.register(r"templates", CheckTemplateViewSet, basename="check-template")
router.register(r"assignments", CheckAssignmentViewSet, basename="check-assignment")
router.register(r"profiles", MonitoringProfileViewSet, basename="monitoring-profile")
router.register(r"policies", MonitoringPolicyViewSet, basename="monitoring-policy")
router.register(r"deny-subnets", MonitoringDenySubnetViewSet, basename="monitoring-deny-subnet")
router.register(r"channels", NotificationChannelViewSet, basename="notification-channel")
router.register(r"alert-rules", AlertRuleViewSet, basename="alert-rule")
router.register(r"silences", SilenceViewSet, basename="silence")
router.register(r"snmp-profiles", SnmpProfileViewSet, basename="snmp-profile")
router.register(r"engines", MonitoringEngineViewSet, basename="monitoring-engine")
router.register(r"outpost-releases", OutpostReleaseViewSet, basename="outpost-release")

urlpatterns = [
    path("engine-binding/<str:scope>/<uuid:object_id>/", engine_binding_view, name="monitoring-engine-binding"),
    path("engine-health/", engine_health_view, name="monitoring-engine-health"),
    path("ips/<uuid:ip_id>/checks/", ip_checks_view, name="monitoring-ip-checks"),
    path("ips/<uuid:ip_id>/history/", ip_history_view, name="monitoring-ip-history"),
    path("ips/<uuid:ip_id>/uptime/", ip_uptime_view, name="monitoring-ip-uptime"),
    path("ips/<uuid:ip_id>/check-now/", check_now_view, name="monitoring-check-now"),
    path("prefixes/<uuid:prefix_id>/checks/", prefix_checks_view, name="monitoring-prefix-checks"),
    path("devices/<uuid:device_id>/checks/", device_checks_view, name="monitoring-device-checks"),
    path("devices/<uuid:device_id>/snmp/", device_snmp_view, name="monitoring-device-snmp"),
    path("devices/<uuid:device_id>/snmp/utilization/", device_snmp_utilization_view, name="monitoring-device-snmp-util"),
    path("devices/<uuid:device_id>/snmp/drift/", device_snmp_drift_view, name="monitoring-device-snmp-drift"),
    path("devices/<uuid:device_id>/snmp/reconcile/", device_snmp_reconcile_view, name="monitoring-device-snmp-reconcile"),
    path("devices/<uuid:device_id>/snmp/sync/", device_snmp_sync_view, name="monitoring-device-snmp-sync"),
    path("devices/<uuid:device_id>/snmp-poll/", device_snmp_poll_view, name="monitoring-device-snmp-poll"),
    path("snmp-drift/", snmp_drift_list_view, name="monitoring-snmp-drift-list"),
    path("topology/ghosts/", snmp_topology_ghosts_view, name="monitoring-topology-ghosts"),
    path("topology/materialize-cable/", materialize_cable_view, name="monitoring-materialize-cable"),
    path("snmp-binding/<str:scope>/<uuid:object_id>/", snmp_binding_view, name="monitoring-snmp-binding"),
    path("prefixes/<uuid:prefix_id>/discover/", prefix_discover_view, name="monitoring-prefix-discover"),
    path("prefixes/<uuid:prefix_id>/nmap-sweep/", prefix_nmap_sweep_view, name="monitoring-prefix-nmap-sweep"),
    path("discover-runs/<str:run_id>/", discover_run_view, name="monitoring-discover-run"),
    path("check-runs/<str:run_id>/", check_run_view, name="monitoring-check-run"),
    path("status/", bulk_status_view, name="monitoring-bulk-status"),
    path("checks/", checks_list_view, name="monitoring-checks-list"),
    path("flapping/", flapping_view, name="monitoring-flapping"),
    path("alerts/", alerts_view, name="monitoring-alerts"),
    path("alerts/<uuid:alert_id>/ack/", alert_ack_view, name="monitoring-alert-ack"),
    path("bulk-check-now/", bulk_check_now_view, name="monitoring-bulk-check-now"),
    path("bulk-discover/", bulk_discover_view, name="monitoring-bulk-discover"),
    path("settings/", settings_view, name="monitoring-settings"),
    path("stats/", stats_view, name="monitoring-stats"),
    *router.urls,
]
