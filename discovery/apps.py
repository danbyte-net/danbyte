from django.apps import AppConfig


class DiscoveryConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "discovery"
    label = "discovery"
    verbose_name = "Discovery"

    def ready(self):
        from vulnerabilities import products

        from . import packages, signals

        # Inventoried packages are tracked products of the vulnerability
        # store (fetch and keep their advisories), with their hosts' releases.
        products.register_provider(packages.tracked_keys)
        products.register_release_provider(packages.tracked_releases)
        signals.connect()
