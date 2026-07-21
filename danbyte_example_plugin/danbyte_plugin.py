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
from plugins.ui_registry import (
    ColumnSpec,
    NavItemSpec,
    PageSpec,
    PanelSpec,
    register_dashboard_panel,
    register_nav_item,
    register_page,
)

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


# 5. Server-driven UI — a nav item, a list + detail page, and a dashboard panel.
#    No plugin JavaScript: the generic frontend renders these from the metadata.
_WIDGETS_API = "/api/plugins/example/widgets/"

register_nav_item(
    NavItemSpec(
        plugin="example",
        title="Widgets",
        url="/p/example/widgets",
        icon="box",
        section="Plugins",
        object_type="widget",  # RBAC-gated in the sidebar, like core nav
    )
)

register_page(
    PageSpec(
        plugin="example",
        path="widgets",
        kind="list",
        title="Widgets",
        endpoint=_WIDGETS_API,
        object_type="widget",
        columns=(
            ColumnSpec("name", "Name", "mono"),
            ColumnSpec("description", "Description"),
            ColumnSpec("tags", "Tags", "tags"),
            ColumnSpec("updated_at", "Updated", "time"),
        ),
        detail_route="/p/example/widgets/$id",
    )
)

register_page(
    PageSpec(
        plugin="example",
        path="widgets/$id",
        kind="detail",
        title="Widget",
        endpoint=_WIDGETS_API,
        object_type="widget",
        title_field="name",
        fields=(
            ColumnSpec("name", "Name", "mono"),
            ColumnSpec("description", "Description"),
            ColumnSpec("tags", "Tags", "tags"),
            ColumnSpec("created_at", "Created", "time"),
            ColumnSpec("updated_at", "Updated", "time"),
        ),
        tabs=("overview", "history"),
        audited=True,
    )
)

register_dashboard_panel(
    PanelSpec(
        plugin="example",
        title="Widgets",
        endpoint=_WIDGETS_API + "?page_size=1",
        kind="count",
    )
)
