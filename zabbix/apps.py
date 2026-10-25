from django.apps import AppConfig


class ZabbixConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "zabbix"
    verbose_name = "Zabbix"

    def ready(self):
        # Registering the engine kind is the whole point of the app being
        # installed; the driver itself is built lazily, per call.
        from monitoring.engine_drivers import register_monitoring_engine
        from monitoring.external.hooks import register_ack_writer, register_window_listener
        from monitoring.observations import register_observation_source

        from . import hooks
        from .checker import KIND
        from .driver import ZabbixDriver

        # Two-way: windows and acknowledgements flow back. Monitoring owns
        # the signal handlers; the registered functions only queue jobs,
        # which re-check every switch at run time.
        register_window_listener("zabbix", hooks.window_changed)
        register_ack_writer(KIND, hooks.write_back, system=hooks.SYSTEM)

        # On the shared beat, but still driven by danbyte-zabbix-sync.timer -
        # extmon_sync skips it unless named, so nothing runs twice.
        from monitoring.external.beat import register_beat

        def _enqueue_due(now):
            from .sync_tasks import enqueue_due_syncs

            return enqueue_due_syncs(now)

        register_beat("zabbix", "Zabbix sync", _enqueue_due, own_timer=True)

        # What Zabbix knows about a device reaches the drift inbox the SNMP
        # poller fills, rather than a second one beside it.
        from .facts import observed_state

        register_observation_source("zabbix", "Zabbix", observed_state)

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
