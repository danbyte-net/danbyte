from django.apps import AppConfig


class ZabbixConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "zabbix"
    verbose_name = "Zabbix"

    def ready(self):
        # Registering the engine kind is the whole point of the app being
        # installed; the driver itself is built lazily, per call.
        from django.db.models.signals import post_delete

        from monitoring.engine_drivers import register_monitoring_engine
        from monitoring.signals import alert_acknowledged, maintenance_window_changed

        from . import hooks
        from .driver import ZabbixDriver

        # Two-way: windows and acknowledgements flow back. The handlers only
        # queue jobs, which re-check every switch at run time.
        maintenance_window_changed.connect(
            hooks.on_window_changed, dispatch_uid="zabbix.window_changed"
        )
        post_delete.connect(
            hooks.on_event_deleted,
            sender="monitoring.MaintenanceEvent",
            dispatch_uid="zabbix.event_deleted",
        )
        alert_acknowledged.connect(
            hooks.on_alert_acknowledged, dispatch_uid="zabbix.alert_acknowledged"
        )

        register_monitoring_engine(
            "zabbix",
            "Zabbix",
            ZabbixDriver,
            description=(
                "An existing Zabbix server answers for this scope. Danbyte "
                "does not run the checks - it reads what Zabbix already knows."
            ),
            configure_path="/zabbix",
            fields=(
                {
                    "name": "url",
                    "label": "Frontend URL",
                    "type": "text",
                    "placeholder": "https://zabbix.example.com",
                    "hint": "Where the API lives - Danbyte appends /api_jsonrpc.php.",
                },
                {
                    "name": "token",
                    "label": "API token",
                    "type": "password",
                    "set_flag": "token_set",
                    "hint": "A named token from Users → API tokens. Give it an expiry.",
                },
                {
                    "name": "verify_tls",
                    "label": "Verify TLS certificate",
                    "type": "checkbox",
                    "default": True,
                },
            ),
        )
