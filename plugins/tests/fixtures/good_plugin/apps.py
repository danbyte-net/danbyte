from plugins.base import DanbytePluginConfig


class GoodPluginConfig(DanbytePluginConfig):
    name = "plugins.tests.fixtures.good_plugin"
    verbose_name = "Good Plugin"
    version = "1.2.3"
    author = "Test Author"
    description = "A well-formed fixture plugin."
    min_version = "0.1.0"
    max_version = "1.0.0"
    slug = "good"
