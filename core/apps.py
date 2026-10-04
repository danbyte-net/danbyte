from django.apps import AppConfig


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "core"

    def ready(self):
        from django.db.models.signals import m2m_changed

        from .models import TaggedItem
        from .tags import forget_prefetched_tags

        # A tag write drops the row's prefetched tag list (core.tags).
        m2m_changed.connect(forget_prefetched_tags, sender=TaggedItem,
                            dispatch_uid="core-tags-forget-prefetched")
