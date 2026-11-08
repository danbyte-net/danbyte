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

        # A neighbour's `address_families` list and its family rows stay one
        # fact: writing the list reconciles the rows, writing a row rewrites
        # the list (the v0.16 view).
        from django.db.models.signals import post_delete, post_save

        def _list_written(sender, instance, raw=False, **kwargs):
            if not raw:
                m.sync_af_rows(instance)

        def _row_written(sender, instance, raw=False, **kwargs):
            if raw:
                return
            try:
                parent = instance.parent
            except (m.BGPSession.DoesNotExist, m.BGPPeerGroup.DoesNotExist):
                return
            m.sync_af_mirror(parent)

        for model in (m.BGPSession, m.BGPPeerGroup):
            post_save.connect(_list_written, sender=model, weak=False,
                              dispatch_uid=f"routing-af-rows-{model.__name__}")
        post_save.connect(_row_written, sender=m.BGPNeighborAF, weak=False,
                          dispatch_uid="routing-af-mirror-save")
        post_delete.connect(_row_written, sender=m.BGPNeighborAF, weak=False,
                            dispatch_uid="routing-af-mirror-delete")

        # CSV import/export: the upsert key of a device-bound row is what
        # makes it unique on its device, and an ASN is written as its
        # number, not its id. Catalogs key on their name by default.
        def io(model, natural_key, **fk_keys):
            register_io(type(
                f"IO_{model.__name__}", (ModelIOHandler,),
                {"model": model, "natural_key": natural_key, "fk_keys": fk_keys},
            )())

        io(m.StaticRoute, ["device", "prefix", "next_hop"])
        io(m.PolicyRule, ["device", "family", "priority"])
        io(m.BGPInstance, ["device", "vrf"], asn="asn")
        io(m.BGPSession, ["instance", "remote_address"])
        io(m.OSPFInstance, ["device", "process_id"])
        io(m.ISISInstance, ["device", "process"])
        io(m.EIGRPInstance, ["device", "vrf", "asn"])
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
