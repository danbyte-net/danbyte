from django.apps import AppConfig


class ApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "api"

    def ready(self):
        # Register built-in round-trip import/export handlers, then let any app
        # (in-tree or a 3rd-party package in INSTALLED_APPS) contribute its own
        # by shipping an ``io.py`` that calls ``api.io.register_io``.
        from django.utils.module_loading import autodiscover_modules

        from . import io

        io.register_builtins()
        autodiscover_modules("io")
