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
        from api.io import ModelIOHandler, register_io
        from customization.object_registry import (
            ReferenceModel,
            register_reference_model,
        )

        from . import models as m
        from .render import routing_context

        register_context_provider("routing", routing_context)

        # CSV import/export: the upsert key of a device-bound row is what
        # makes it unique on its device, and an ASN is written as its
        # number, not its id. Catalogs key on their name by default.
        def io(model, natural_key, **fk_keys):
            register_io(type(
                f"IO_{model.__name__}", (ModelIOHandler,),
                {"model": model, "natural_key": natural_key, "fk_keys": fk_keys},
            )())

        io(m.StaticRoute, ["device", "prefix", "next_hop"])
        io(m.BGPInstance, ["device", "vrf"], asn="asn")
        io(m.BGPSession, ["instance", "remote_address"])
        io(m.OSPFInstance, ["device", "process_id"])
        io(m.ISISInstance, ["device", "process"])
        io(m.VTEP, ["device"])
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
