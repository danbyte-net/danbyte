from django.apps import AppConfig


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "core"

    def ready(self):
        from django.contrib.auth.signals import user_logged_in
        from django.db.models.signals import m2m_changed

        from .middleware import start_idle_window
        from .models import TaggedItem
        from .tags import forget_prefetched_tags

        # A new session starts its idle window at sign-in (core.middleware).
        user_logged_in.connect(start_idle_window, dispatch_uid="core-idle-window-at-login")

        # A tag write drops the row's prefetched tag list (core.tags).
        m2m_changed.connect(forget_prefetched_tags, sender=TaggedItem,
                            dispatch_uid="core-tags-forget-prefetched")
