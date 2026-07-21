from danbyte import __version__ as _danbyte_version
from plugins.base import DanbytePluginConfig


class ExamplePluginConfig(DanbytePluginConfig):
    name = "danbyte_example_plugin"
    verbose_name = "Danbyte Example Plugin"
    slug = "example"
    version = "1.0.0"
    author = "Danbyte"
    description = (
        "Reference plugin: a Widget model + API, a custom check kind, an "
        "automation provider, and server-driven nav/pages."
    )
    # Supported Danbyte version window. Bracketed so the current release loads;
    # bump when a plugin API this depends on changes.
    min_version = "0.8.0"
    max_version = None

    def ready(self):
        # Guard against a future release moving past an (unset) max — kept as a
        # no-op today, but documents where a plugin would assert compatibility
        # beyond the loader's static gate.
        super().ready()
        _ = _danbyte_version
