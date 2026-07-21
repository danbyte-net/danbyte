"""Registration entry point — autodiscovered by ``plugins.apps.PluginsConfig``.

A plugin performs ALL its contribution registrations here (or in modules it
imports), so there is one conventional place to look. This runs after every app
(including the core apps) is ready, so calling the core registration hooks is
safe.
"""
from __future__ import annotations

from audit import register_audited_model
from auth_api.object_types import register_object_type
from customization.object_registry import ReferenceModel, register_reference_model
from integrations.providers import register_automation_provider

from . import checks  # noqa: F401 — registers the example_ping check kind

# 1. Expose Widget to RBAC (default-closed) + import/export + webhook/automation
#    eventing — all three consumers iterate this registry.
register_object_type("danbyte_example_plugin.Widget", "Widgets", "Plugins")

# 2. Let object-reference custom fields point at a Widget.
register_reference_model(
    ReferenceModel(
        slug="widget",
        label="Widgets",
        app_model="danbyte_example_plugin.Widget",
        endpoint="/api/plugins/example/widgets/",
        route="/p/example/widgets/$id",
    )
)

# 3. Record Widget mutations in the change log.
register_audited_model("danbyte_example_plugin.Widget")


# 4. A no-op automation runner demonstrating the provider registry.
def _noop_runner(target, payload, event):
    return "launched", "noop automation provider ran."


register_automation_provider("noop", _noop_runner)
