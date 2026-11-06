from django.apps import AppConfig


class ApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "api"

    def ready(self):
        # OpClass is the outermost part of an indexed expression, as
        # django.contrib.postgres (not installed) registers it: otherwise the
        # opclass lands inside the expression's parentheses - ``((cidr)::inet
        # inet_ops)`` - and the prefix GiST index (#484) is a syntax error.
        from django.contrib.postgres.indexes import OpClass
        from django.db.models import OrderBy
        from django.db.models.functions import Collate
        from django.db.models.indexes import IndexExpression

        IndexExpression.register_wrappers(OrderBy, OpClass, Collate)

        # Register built-in round-trip import/export handlers, then let any app
        # (in-tree or a 3rd-party package in INSTALLED_APPS) contribute its own
        # by shipping an ``io.py`` that calls ``api.io.register_io``.
        from django.utils.module_loading import autodiscover_modules

        from . import applications, io, signals  # noqa: F401  (signals register on import)

        applications.connect_signals()
        from . import flow_requirements

        flow_requirements.connect_signals()
        from . import floor_plan_snapshots

        # A live view following an area keeps its crop when the area goes.
        floor_plan_snapshots.connect_signals()
        io.register_builtins()
        autodiscover_modules("io")
        # The global search index follows every indexed model's saves/deletes.
        from .search_index import connect_signals

        connect_signals()
        # Stored cable routes go out of date when their tiles or trays move.
        from . import cable_routing

        cable_routing.connect_signals()
        # The `tunnels` block of a device or VM render: each tunnel end with
        # its far end(s) resolved, WireGuard keys and ports included.
        from .export_templates import register_context_provider
        from .wireguard import tunnels_by_interface_context, tunnels_context

        register_context_provider("tunnels", tunnels_context)
        register_context_provider("tunnels_by_interface", tunnels_by_interface_context)
