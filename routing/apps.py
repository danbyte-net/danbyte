from django.apps import AppConfig


class RoutingConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "routing"
    verbose_name = "Routing"

    def ready(self):
        # The routing block of a device's rendered config and Ansible
        # inventory - registered rather than imported, so `api` never
        # depends on this app.
        from api.export_templates import register_context_provider
        from customization.object_registry import (
            ReferenceModel,
            register_reference_model,
        )

        from .render import routing_context

        register_context_provider("routing", routing_context)
        register_reference_model(
            ReferenceModel(
                "routingpolicy", "Routing policies", "routing.RoutingPolicy",
                "/api/routing/policies/", route="/routing-policies/$id",
            )
        )
        register_reference_model(
            ReferenceModel(
                "prefixlist", "Prefix lists", "routing.PrefixList",
                "/api/routing/prefix-lists/", route="/prefix-lists/$id",
            )
        )
