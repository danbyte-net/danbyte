from django.apps import AppConfig


class PrtgConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "prtg"
    verbose_name = "PRTG monitoring"

    def import_models(self):
        # The Overview pins live in their own module (prtg.pins); load them
        # with the models so the registry and migrations see them.
        super().import_models()
        from importlib import import_module

        import_module(f"{self.name}.pins")

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
