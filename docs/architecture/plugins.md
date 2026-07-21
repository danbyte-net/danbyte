---
icon: lucide/puzzle
---

# Plugins

Danbyte has a first-class plugin system: a **trusted, in-process** extension
model in the NetBox tradition. A plugin is an ordinary Python package that an
operator installs and lists in the `PLUGINS` setting; on the next restart it is
discovered, version-checked, and wired into RBAC, custom fields, tags,
import/export, audit, monitoring, automation, and the UI — with **no core
changes and no frontend rebuild**.

!!! info "Trust model"
    Plugins run in-process with full Django access, deployment-wide. Only
    install plugins you trust — treat them like any dependency you add to the
    environment. Each tenant can then **enable/disable** an installed plugin
    independently.

## Installing a plugin

```bash
# as the service user, in the app directory
.venv/bin/pip install danbyte-acme-plugin      # or: pip install -e ./my-plugin
echo 'PLUGINS=danbyte_acme_plugin' >> .env     # comma-separate multiple
```

Then apply it. Either from the UI — **Settings → Deployment → Plugins &
services → Apply changes** (runs migrations and restarts Danbyte; superuser
only) — or by hand:

```bash
.venv/bin/python manage.py migrate
systemctl --user restart danbyte-web danbyte-workers danbyte-ws
```

The **Plugins & services** page lists every plugin with its load state
(`loaded` / `incompatible` / `error`), flags unapplied migrations, and offers
per-tenant enable toggles. A broken or version-incompatible plugin is reported
there and skipped — it never blocks boot.

!!! note "Disable ≠ uninstall"
    Disabling a plugin (per tenant or deployment-wide) hides its API/UI but
    keeps its tables. To remove it, drop it from `PLUGINS`, restart, and (if you
    want the data gone) handle its tables yourself.

## Anatomy of a plugin

A plugin package looks like a small Django app plus one registration module:

```
danbyte_acme_plugin/
├── __init__.py
├── apps.py            # DanbytePluginConfig subclass (metadata)
├── danbyte_plugin.py  # THE registration entry point (autodiscovered)
├── models.py          # your domain models (optional)
├── migrations/
├── serializers.py     # DRF serializers (optional)
├── viewsets.py        # DRF viewsets (optional)
├── api_urls.py        # mounted at /api/plugins/<slug>/ (optional)
└── checks.py          # monitoring check kinds (optional)
```

### `apps.py` — metadata

Subclass `plugins.base.DanbytePluginConfig` instead of `AppConfig`. The extra
attributes are read by the loader **at settings-import time**, so `apps.py` and
the package `__init__` must be *import-safe* — no model imports at module top
level (the same rule Django already imposes on `apps.py`).

```python
from plugins.base import DanbytePluginConfig

class AcmePluginConfig(DanbytePluginConfig):
    name = "danbyte_acme_plugin"       # the Django app path
    verbose_name = "Acme Plugin"
    slug = "acme"                       # /api/plugins/acme/ + /p/acme/… + nav
    version = "1.0.0"
    author = "Acme Corp"
    description = "Adds Acme widgets."
    min_version = "0.8.0"              # Danbyte version window (inclusive)
    max_version = None
    default_enabled = True             # active unless a tenant/deployment turns it off
```

### `danbyte_plugin.py` — the registration entry point

`plugins.apps.PluginsConfig.ready()` autodiscovers this module in every
installed plugin (the same idiom as `api/apps.py`'s `autodiscover_modules`). It
runs after all core apps are ready, so calling the core registration hooks is
safe. Do **all** your registrations here (or in modules it imports).

## What a plugin can register

| Capability | Hook | Result |
|---|---|---|
| Domain model | `auth_api.object_types.register_object_type("app.Model", "Label", "Group")` | RBAC (default-closed) + import/export + webhook/automation eventing |
| Custom fields | mix `core.models.CustomFieldsMixin` into the model | auto-appears in `/api/customization/meta/` |
| Tags | mix `core.models.TaggableMixin` into the model | tag support, no extra call |
| Object-reference target | `customization.object_registry.register_reference_model(ReferenceModel(...))` | custom fields can point at your model |
| Audit / change log | `audit.register_audited_model("app.Model")` | create/update/delete recorded |
| REST API | ship `api_urls.py` | mounted at `/api/plugins/<slug>/` |
| Automation runner | `integrations.providers.register_automation_provider(kind, runner)` | new deploy target kind |
| Import source | `integrations.providers.register_import_source(kind, handler)` | new importer |
| Notification channel | `integrations.providers.register_notification_channel(kind, sender)` | new alert transport |
| Monitoring check kind | `@danbyte_checks.base.register` on a `Checker` | validates + runs via core & Outposts |
| Nav item | `plugins.ui_registry.register_nav_item(NavItemSpec(...))` | sidebar entry (RBAC-gated) |
| Page (list/detail) | `plugins.ui_registry.register_page(PageSpec(...))` | server-driven page at `/p/<slug>/…` |
| Dashboard panel | `plugins.ui_registry.register_dashboard_panel(PanelSpec(...))` | dashboard tile |

### Models, API, RBAC

Registering the object type is what makes your model **default-closed** — every
action then demands a `<model_name>.*` grant. Reuse
`api.viewsets.TenantScopedViewSet` for a tenant-scoped, RBAC-enforced CRUD
viewset, and `plugins.viewsets.PluginEnabledMixin` (set `plugin_slug`) so the
viewset 404s when the plugin is disabled for the active tenant.

```python
# viewsets.py
from api.viewsets import TenantScopedViewSet
from plugins.viewsets import PluginEnabledMixin
from .models import Widget
from .serializers import WidgetSerializer

class WidgetViewSet(PluginEnabledMixin, TenantScopedViewSet):
    plugin_slug = "acme"
    queryset = Widget.objects.all()
    serializer_class = WidgetSerializer
```

!!! warning "Tenant isolation is a hard boundary"
    Scope every queryset to the active tenant (the base does this) and never
    trust a client-supplied id to belong to the current tenant. New endpoints
    are default-closed; only use `AllowAny` for an explicitly public flow.

### Server-driven UI (no plugin JavaScript)

The frontend renders plugin UI from metadata — you ship **no** React. Register
a `NavItemSpec`, `PageSpec` (list or detail, with `columns`/`fields`/`tabs`),
and optional `PanelSpec`; the generic renderer builds the standard
`DataTable` / `DetailShell` from them, served under the reserved `/p/<slug>/…`
route. Nav items carry an `object_type`/`perm` so they're hidden from users who
can't view the target, exactly like core nav.

See the bundled reference plugin `danbyte_example_plugin/` — it exercises every
capability above and is the recommended starting point.

## How it fits together

- **Discovery** — `danbyte/plugin_loader.py` runs at settings-import time,
  reads each plugin's metadata, version-gates against `danbyte.__version__`
  (`packaging`), and appends the compatible ones to `INSTALLED_APPS`. The
  framework app (`plugins`) is appended last so its `ready()` autodiscovers
  every plugin's `danbyte_plugin` module after all apps have loaded.
- **Inventory** — `GET /api/plugins/` lists installed plugins, their state, and
  unapplied migrations. `GET /api/plugins/ui/` returns the nav/pages/panels for
  the plugins enabled in the caller's tenant.
- **Enablement** — `plugins.PluginConfig` stores per-tenant/deployment
  enable state; `plugins.resolve.plugin_enabled()` resolves the cascade
  (tenant → deployment default → `default_enabled`). See
  [Tenant settings](tenant-settings.md).
- **Service control** — applying a plugin (migrate + restart) and restarting
  services reuse the upgrade flow's detached `systemd-run --user` mechanism;
  these actions are **superuser only**.
