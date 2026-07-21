from django.apps import AppConfig


class AuthApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "auth_api"

    def ready(self):
        # Register the drf-spectacular auth extension for our token scheme.
        from . import schema  # noqa: F401
