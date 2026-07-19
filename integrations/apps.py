from django.apps import AppConfig


class IntegrationsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "integrations"

    def ready(self):
        from . import dispatch, drift_history, webhooks

        webhooks.connect()
        dispatch.connect()
        drift_history.connect()
