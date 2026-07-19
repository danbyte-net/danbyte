from django.contrib import admin

from .models import (
    Alert,
    AlertRule,
    CheckAssignment,
    CheckResult,
    CheckState,
    CheckTemplate,
    MonitoringDenySubnet,
    MonitoringPolicy,
    MonitoringProfile,
    MonitoringSettings,
    NotificationChannel,
    StateTransition,
)


@admin.register(AlertRule)
class AlertRuleAdmin(admin.ModelAdmin):
    list_display = ("name", "severity", "weight", "enabled", "tenant")
    list_filter = ("severity", "enabled", "tenant")


@admin.register(Alert)
class AlertAdmin(admin.ModelAdmin):
    list_display = ("target_ip", "severity", "status", "check_status", "opened_at")
    list_filter = ("severity", "status", "kind", "tenant")
    raw_id_fields = ("target_ip", "template")


@admin.register(MonitoringSettings)
class MonitoringSettingsAdmin(admin.ModelAdmin):
    list_display = ("tenant", "global_enabled", "stale_after_scans", "stale_after_days")
    filter_horizontal = ("skip_ip_statuses",)


@admin.register(CheckTemplate)
class CheckTemplateAdmin(admin.ModelAdmin):
    list_display = ("name", "kind", "tenant", "interval_seconds", "enabled")
    list_filter = ("kind", "enabled", "tenant")
    search_fields = ("name", "slug")
    # secret_params is intentionally not exposed in the admin form.
    exclude = ("secret_params",)


@admin.register(CheckAssignment)
class CheckAssignmentAdmin(admin.ModelAdmin):
    list_display = ("template", "target_kind", "schedule_mode", "enabled")
    list_filter = ("schedule_mode", "enabled", "tenant")
    raw_id_fields = ("ip_address", "prefix", "template")

    @admin.display(description="Target")
    def target_kind(self, obj):
        return "IP" if obj.ip_address_id else "Prefix"


@admin.register(MonitoringProfile)
class MonitoringProfileAdmin(admin.ModelAdmin):
    list_display = ("name", "tenant", "enabled")
    list_filter = ("enabled", "tenant")
    search_fields = ("name", "slug")
    filter_horizontal = ("templates",)


@admin.register(MonitoringPolicy)
class MonitoringPolicyAdmin(admin.ModelAdmin):
    list_display = ("scope", "tenant", "enabled", "inherit")
    list_filter = ("scope", "enabled", "tenant")
    raw_id_fields = ("vrf", "device_type", "device_role", "device", "prefix")
    filter_horizontal = ("profiles", "templates")


@admin.register(MonitoringDenySubnet)
class MonitoringDenySubnetAdmin(admin.ModelAdmin):
    list_display = ("cidr", "vrf", "tenant")
    list_filter = ("tenant", "vrf")


@admin.register(CheckState)
class CheckStateAdmin(admin.ModelAdmin):
    list_display = ("target_ip", "kind", "status", "since", "last_checked")
    list_filter = ("kind", "status", "tenant")
    raw_id_fields = ("target_ip", "template", "assignment")


@admin.register(CheckResult)
class CheckResultAdmin(admin.ModelAdmin):
    list_display = ("target_ip", "kind", "status", "latency_ms", "timestamp")
    list_filter = ("kind", "status")
    raw_id_fields = ("target_ip", "template", "assignment")


@admin.register(StateTransition)
class StateTransitionAdmin(admin.ModelAdmin):
    list_display = ("target_ip", "kind", "from_status", "to_status", "at")
    list_filter = ("kind", "to_status")
    raw_id_fields = ("target_ip", "template")


@admin.register(NotificationChannel)
class NotificationChannelAdmin(admin.ModelAdmin):
    list_display = ("name", "kind", "tenant", "enabled")
    list_filter = ("kind", "enabled", "tenant")
