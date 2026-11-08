"""The room a device, rack or cabinet stands in.

A room sits in one location, so an object's room and location agree: the
room's location is the object's location, and its site the object's site.
The rules, the same for the API's writes and for a model ``clean()`` (import,
integration syncs):

* setting a room without a location takes the room's location;
* a room in another location, site or tenant is refused on ``room``;
* moving the object to another location (or none) clears a room left behind,
  and the change log records it.

A room is never set from where an object is placed on a floor plan or in a
rack; only a write that names it sets it.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers


def _room_error(room, location, site) -> str | None:
    """Why ``room`` cannot be the room of an object at ``location`` and
    ``site``, or None when it can."""
    if location is not None and room.location_id != location.pk:
        return f"Pick a room in {location.name}."
    if site is not None and room.location.site_id != site.pk:
        return f"Pick a room at {site.name}."
    return None


def _may_view(request, room) -> bool:
    """Whether the writer may view ``room`` - setting it names it, so a room
    the writer cannot see is refused like one that does not exist."""
    user = getattr(request, "user", None)
    if user is None or user.is_superuser:
        return True
    from api.views import _get_active_tenant
    from auth_api import rbac

    return rbac.can_act_on(user, _get_active_tenant(request), "room", "view", room)


def reconcile_room(attrs: dict, instance, request=None) -> None:
    """Serializer side: settle ``attrs["room"]`` against the location and
    site being written. Raises a field error on ``room_id``."""
    room_sent = "room" in attrs
    location_sent = "location" in attrs
    room = attrs["room"] if room_sent else getattr(instance, "room", None)
    if room is None:
        return
    if room_sent and getattr(instance, "room_id", None) != room.pk \
            and not _may_view(request, room):
        raise serializers.ValidationError({"room_id": "Pick a room you can see."})
    location = attrs["location"] if location_sent else getattr(instance, "location", None)
    site = attrs.get("site", getattr(instance, "site", None))
    if not room_sent:
        # The object moved: a room in the old location stays behind.
        if location is None or location.pk != room.location_id:
            attrs["room"] = None
        return
    if location is None or (not location_sent and location.pk != room.location_id):
        location = attrs["location"] = room.location
    message = _room_error(room, location, site)
    if message:
        raise serializers.ValidationError({"room_id": message})


def clean_room(obj) -> None:
    """Model side, for ``full_clean()``: a room the object already had and
    whose location it left is cleared; a room newly set is checked and, on
    an object with no location, gives it the room's location."""
    if obj.room_id is None:
        return
    room = obj.room
    if room.tenant_id != getattr(obj, "tenant_id", None):
        raise DjangoValidationError({"room": "Pick a room of this tenant."})
    stored = None
    if not obj._state.adding and obj.pk is not None:
        stored = (
            type(obj)._base_manager.filter(pk=obj.pk).values_list("room_id", flat=True).first()
        )
    if stored == obj.room_id:
        if obj.location_id != room.location_id:
            obj.room = None
        return
    if obj.location_id is None:
        obj.location = room.location
    message = _room_error(room, obj.location, obj.site if obj.site_id else None)
    if message:
        raise DjangoValidationError({"room": message})
