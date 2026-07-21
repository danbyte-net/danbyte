from rest_framework import serializers

from api.serializers import (
    TaggableSerializerMixin,
    TagSerializer,
    TenantScopedPrimaryKeyRelatedField,
)
from core.models import Tag

from .models import Widget


class WidgetSerializer(TaggableSerializerMixin, serializers.ModelSerializer):
    """Reference serializer: custom fields (plain JSON) + tags, the Danbyte way.

    ``tag_ids`` is tenant-scoped so a caller can't attach another tenant's tags.
    """

    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags",
        queryset=Tag.objects.all(),
        write_only=True,
        required=False,
        many=True,
    )

    class Meta:
        model = Widget
        fields = [
            "id",
            "name",
            "description",
            "custom_fields",
            "tags",
            "tag_ids",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]
