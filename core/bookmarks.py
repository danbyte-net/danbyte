"""Per-user page bookmarks API. Scoped to the requesting user (not tenant)."""
from __future__ import annotations

from rest_framework import serializers, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Bookmark, BookmarkFolder


class BookmarkSerializer(serializers.ModelSerializer):
    folder_name = serializers.CharField(source="folder.name", read_only=True, default=None)

    class Meta:
        model = Bookmark
        fields = ["id", "label", "url", "folder", "folder_name", "weight", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate_folder(self, folder):
        if folder is not None and folder.user_id != self.context["request"].user.id:
            raise serializers.ValidationError("Folder is not yours.")
        return folder


class BookmarkFolderSerializer(serializers.ModelSerializer):
    class Meta:
        model = BookmarkFolder
        fields = ["id", "name", "parent", "weight", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate_parent(self, parent):
        if parent is not None and parent.user_id != self.context["request"].user.id:
            raise serializers.ValidationError("Parent folder is not yours.")
        if self.instance is not None and parent is not None and parent.id == self.instance.id:
            raise serializers.ValidationError("A folder cannot contain itself.")
        return parent


class BookmarkFolderViewSet(viewsets.ModelViewSet):
    serializer_class = BookmarkFolderSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return BookmarkFolder.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)


class BookmarkViewSet(viewsets.ModelViewSet):
    serializer_class = BookmarkSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Bookmark.objects.filter(user=self.request.user).select_related("folder")

    def create(self, request, *args, **kwargs):
        # Idempotent on (user, url): re-bookmarking a page updates its label
        # rather than 500-ing on the unique constraint.
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        obj, created = Bookmark.objects.update_or_create(
            user=request.user,
            url=ser.validated_data["url"],
            defaults={
                "label": ser.validated_data["label"],
                "folder": ser.validated_data.get("folder"),
                "weight": ser.validated_data.get("weight", 0),
            },
        )
        return Response(
            self.get_serializer(obj).data, status=201 if created else 200
        )
