from django.apps import AppConfig


class VulnerabilitiesConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "vulnerabilities"
    label = "vulnerabilities"
    verbose_name = "Vulnerabilities"

    def ready(self):
        from . import jobs, products, signals, store

        # The store keeps records for the products tenants map, and every
        # store recomputes the tenants it can reach.
        products.register_provider(jobs.tracked_keys)
        store.register_after_store(jobs.after_store)
        signals.connect()
