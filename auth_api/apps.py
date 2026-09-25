from django.apps import AppConfig


class AuthApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "auth_api"

    def ready(self):
        from django.contrib.auth import get_user_model
        from django.db.models.signals import m2m_changed, post_delete, post_save

        # Register the drf-spectacular auth extension for our token scheme.
        from . import schema  # noqa: F401
        from .models import ObjectPermission
        from .rbac import invalidate_request_cache

        # A grant, its scope or a user's groups changing mid-request must not
        # be answered from the per-request RBAC memo.
        for sig in (post_save, post_delete):
            sig.connect(invalidate_request_cache, sender=ObjectPermission,
                        dispatch_uid=f"rbac-memo-{sig}")
        for through in (ObjectPermission.users.through, ObjectPermission.groups.through,
                        ObjectPermission.tenants.through, ObjectPermission.sites.through,
                        get_user_model().groups.through):
            m2m_changed.connect(invalidate_request_cache, sender=through,
                                dispatch_uid=f"rbac-memo-m2m-{through.__name__}")
