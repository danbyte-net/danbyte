"""Tenant members for pickers that are not user administration.

Notification subscriptions, script sharing, a site editor's "Invite viewer"
and user/group custom fields all need to name people. ``/api/users/`` and
``/api/groups/`` are user administration and need a grant on those types.
These endpoints list the active members of the active tenant (and the groups
they are in) for anyone who works with one of those features, with no email
unless the caller may read users.

Plain path routes, deliberately not router registrations: a second User
viewset on the main router would confuse the code that maps a model to its
viewset (editable fields, the export/import endpoint map, the agent routes).
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics, serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated

from api.viewsets import StandardPagination

#: Features whose add/change grant earns the people picker.
PICKER_TYPES = ("task", "notificationsubscription", "script")


def _can_write(user, tenant, slug: str) -> bool:
    from . import rbac

    return rbac.has_action(user, tenant, slug, "add") or rbac.has_action(
        user, tenant, slug, "change"
    )


def _custom_field_allows(user, tenant, field_id, kind: str) -> bool:
    """A user/group object custom field in this tenant, on a type the caller
    may add or change - the field's own picker."""
    from customization.models import CustomField

    try:
        field = CustomField.objects.filter(
            pk=field_id, tenant=tenant, type="object", related_model=kind
        ).first()
    except (DjangoValidationError, ValueError, TypeError):
        return False
    if field is None:
        return False
    return any(_can_write(user, tenant, slug) for slug in field.applies_to or [])


def may_pick_people(user, tenant, *, kind: str = "user", custom_field=None) -> bool:
    """May ``user`` list the people (``kind="user"``) or groups of ``tenant``?

    Yes for user administrators, for anyone who may add or change tasks,
    notification subscriptions or scripts, for a site editor when the tenant
    lets site editors invite viewers (people only - that flow never takes a
    group), and for the picker of a user/group custom field on a type the
    caller may edit. Read-only accounts get no list.
    """
    from . import rbac
    from .permissions import can_manage_admin

    if not getattr(user, "is_authenticated", False) or tenant is None:
        return False
    if user.is_superuser or can_manage_admin(user, tenant):
        return True
    if any(_can_write(user, tenant, slug) for slug in PICKER_TYPES):
        return True
    if kind == "user":
        from core.effective_settings import effective_sharing

        if effective_sharing(tenant).allow_site_editor_delegation and (
            rbac.editable_sites(user, tenant) != set()
        ):
            return True
    if custom_field and _custom_field_allows(user, tenant, custom_field, kind):
        return True
    return False


def tenant_members(tenant):
    """Active accounts that are members of ``tenant``."""
    return (
        get_user_model()
        .objects.filter(is_active=True, profile__tenants=tenant)
        .distinct()
    )


def tenant_groups(tenant, user=None):
    """Groups with at least one active member in ``tenant``, plus ``user``'s
    own groups."""
    q = Q(user__is_active=True, user__profile__tenants=tenant)
    if user is not None and getattr(user, "is_authenticated", False):
        q |= Q(pk__in=user.groups.values("pk"))
    return Group.objects.filter(q).distinct()


class PersonSerializer(serializers.Serializer):
    id = serializers.IntegerField(read_only=True)
    username = serializers.CharField(read_only=True)
    display_name = serializers.SerializerMethodField()
    email = serializers.SerializerMethodField()
    has_email = serializers.SerializerMethodField()

    def get_display_name(self, obj) -> str:
        return f"{obj.first_name} {obj.last_name}".strip() or obj.username

    def get_email(self, obj) -> str | None:
        return obj.email if self.context.get("with_email") else None

    def get_has_email(self, obj) -> bool:
        return bool(obj.email)


class PersonGroupSerializer(serializers.Serializer):
    id = serializers.IntegerField(read_only=True)
    name = serializers.CharField(read_only=True)


class _PeopleBase:
    permission_classes = [IsAuthenticated]
    pagination_class = StandardPagination
    kind = "user"

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        from api.views import _get_active_tenant

        tenant = _get_active_tenant(request)
        if tenant is None:
            raise PermissionDenied("No active tenant selected.")
        if not may_pick_people(
            request.user, tenant, kind=self.kind,
            custom_field=request.query_params.get("custom_field"),
        ):
            raise PermissionDenied("You can't list the people in this tenant.")
        self.tenant = tenant

    def _search(self):
        return (self.request.query_params.get("search") or "").strip()


class _PersonBase(_PeopleBase):
    serializer_class = PersonSerializer

    def _with_email(self) -> bool:
        if not hasattr(self, "_email_ok"):
            from . import rbac

            self._email_ok = rbac.has_action(
                self.request.user, self.tenant, "user", "view"
            )
        return self._email_ok

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "with_email": self._with_email()}

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return get_user_model().objects.none()
        qs = tenant_members(self.tenant)
        s = self._search()
        if s:
            q = (
                Q(username__icontains=s)
                | Q(first_name__icontains=s)
                | Q(last_name__icontains=s)
            )
            # Matching on an address the caller may not read would reveal it.
            if self._with_email():
                q |= Q(email__icontains=s)
            qs = qs.filter(q)
        return qs.order_by("username")


class _GroupBase(_PeopleBase):
    serializer_class = PersonGroupSerializer
    kind = "group"

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Group.objects.none()
        qs = tenant_groups(self.tenant, self.request.user)
        s = self._search()
        if s:
            qs = qs.filter(name__icontains=s)
        return qs.order_by("name")


_SEARCH = OpenApiParameter(
    "search", OpenApiTypes.STR, OpenApiParameter.QUERY,
    description="Case-insensitive match on the name.",
)
_CUSTOM_FIELD = OpenApiParameter(
    "custom_field", OpenApiTypes.UUID, OpenApiParameter.QUERY,
    description="The user/group custom field being filled in; editing a type "
    "it applies to is enough to list.",
)


@extend_schema_view(
    get=extend_schema(
        summary="Active members of the active tenant, for pickers",
        tags=["people"],
        parameters=[_SEARCH, _CUSTOM_FIELD],
    )
)
class PeopleList(_PersonBase, generics.ListAPIView):
    pass


@extend_schema_view(
    get=extend_schema(
        summary="One active member of the active tenant",
        tags=["people"],
        parameters=[_CUSTOM_FIELD],
    )
)
class PersonDetail(_PersonBase, generics.RetrieveAPIView):
    pass


@extend_schema_view(
    get=extend_schema(
        summary="Groups with members in the active tenant, for pickers",
        tags=["people"],
        parameters=[_SEARCH, _CUSTOM_FIELD],
    )
)
class PeopleGroupList(_GroupBase, generics.ListAPIView):
    pass


@extend_schema_view(
    get=extend_schema(
        summary="One group with members in the active tenant",
        tags=["people"],
        parameters=[_CUSTOM_FIELD],
    )
)
class PeopleGroupDetail(_GroupBase, generics.RetrieveAPIView):
    pass
