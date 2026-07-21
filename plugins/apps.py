from django.apps import AppConfig


class PluginsConfig(AppConfig):
    """The plugin framework app.

    Appended to ``INSTALLED_APPS`` **last** (by ``danbyte/settings.py``) so this
    ``ready()`` runs after every plugin app has loaded. It autodiscovers each
    plugin's ``danbyte_plugin`` module — the single conventional place a plugin
    registers its contributions (object types, providers, checkers, nav/pages),
    mirroring ``api/apps.py``'s ``autodiscover_modules("io")``.
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "plugins"

    def ready(self):
        from django.utils.module_loading import autodiscover_modules

        # Record enable/disable changes in the change log.
        from audit import register_audited_model

        register_audited_model("plugins.PluginConfig")

        autodiscover_modules("danbyte_plugin")
