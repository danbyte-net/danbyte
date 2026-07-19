from django.apps import AppConfig


class MonitoringConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "monitoring"
    verbose_name = "Monitoring"

    def ready(self) -> None:
        # Lock down the check engine's target policy for the CENTRAL server: a
        # tenant-defined check target that resolves to loopback/RFC1918 is an
        # SSRF vector here (unlike on an outpost, where internal monitoring is
        # the point). Opt-in via DANBYTE_CHECK_BLOCK_INTERNAL so self-hosted
        # deployments that legitimately monitor their LAN from the central box
        # keep working; the metadata endpoint is refused either way.
        from django.conf import settings

        from danbyte_checks import netguard

        netguard.configure(
            block_internal=getattr(settings, "CHECK_BLOCK_INTERNAL", False),
            allowlist=getattr(settings, "SSRF_ALLOWLIST", None),
        )
