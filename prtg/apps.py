from django.apps import AppConfig


class PrtgConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "prtg"
    verbose_name = "PRTG monitoring"

    def ready(self):
        # The check kind registers on import; the engine kind and the beat
        # entry are what make PRTG answer for it.
        from monitoring.engine_drivers import register_monitoring_engine
        from monitoring.external.beat import register_beat

        from .checker import KIND
        from .driver import PrtgDriver

        def _enqueue_due(now):
            from .sync_tasks import enqueue_due_reads

            return enqueue_due_reads(now)

        register_beat("prtg", "PRTG status", _enqueue_due)

        # Two-way: acknowledgements and windows flow back to PRTG. Monitoring
        # owns the signal handlers; these only queue jobs, which re-check
        # every switch at run time.
        from monitoring.external.hooks import register_ack_writer, register_window_listener
        from monitoring.observations import register_observation_source

        from . import acks, facts, maintenance

        register_ack_writer(KIND, acks.write_back, system=acks.SYSTEM)
        register_window_listener("prtg", maintenance.window_changed)
        # What PRTG's system information says reaches the drift inbox the
        # SNMP poller fills, below the poller itself.
        register_observation_source("prtg", "PRTG", facts.observed_state)
        register_monitoring_engine(
            KIND,
            "PRTG",
            PrtgDriver,
            description=(
                "An existing PRTG core server answers for this scope. Danbyte "
                "does not run the sensors - it reads what PRTG already knows."
            ),
            configure_path="/prtg",
        )
