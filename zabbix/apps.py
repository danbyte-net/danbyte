from django.apps import AppConfig


class ZabbixConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "zabbix"
    verbose_name = "Zabbix"

    def ready(self):
        # Registering the engine kind is the whole point of the app being
        # installed; the driver itself is built lazily, per call.
        from monitoring.engine_drivers import register_monitoring_engine

        from .driver import ZabbixDriver

        register_monitoring_engine(
            "zabbix",
            "Zabbix",
            ZabbixDriver,
            description=(
                "An existing Zabbix server answers for this scope. Danbyte "
                "does not run the checks - it reads what Zabbix already knows."
            ),
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
