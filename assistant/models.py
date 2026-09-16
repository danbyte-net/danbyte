"""Saved conversations with the in-app assistant.

A conversation belongs to one person. Nobody else sees it - not an admin,
not another member of the tenant - because a transcript holds whatever the
assistant read on that person's behalf. Deleting one, or all of them, is
the owner's own call, and a retention setting prunes the rest.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from core.models import TimestampedModel

ROLES = [
    ("user", "Person"),
    ("assistant", "Assistant"),
    ("tool", "Tool call"),
    ("error", "Error"),
]

TITLE_LENGTH = 60


class Conversation(TimestampedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="assistant_conversations"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="assistant_conversations",
    )
    # Taken from the first question, so a list of conversations reads as a
    # list of what was asked.
    title = models.CharField(max_length=120, blank=True, default="")
    model = models.CharField(max_length=120, blank=True, default="")
    last_message_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-last_message_at", "-created_at"]
        indexes = [models.Index(fields=["user", "-last_message_at"])]

    def __str__(self) -> str:
        return self.title or f"conversation {self.id}"

    def touch(self, when=None) -> None:
        from django.utils import timezone

        Conversation.objects.filter(pk=self.pk).update(
            last_message_at=when or timezone.now()
        )

    @staticmethod
    def title_from(text: str) -> str:
        one_line = " ".join(str(text or "").split())
        return one_line[:TITLE_LENGTH] + ("…" if len(one_line) > TITLE_LENGTH else "")


class Message(TimestampedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="messages"
    )
    role = models.CharField(max_length=10, choices=ROLES)
    text = models.TextField(blank=True, default="")
    # For a tool row: {"name", "arguments", "rows", "error"} - what the
    # assistant looked up, so an answer can be checked rather than trusted.
    tool = models.JSONField(default=dict, blank=True)
    tokens_in = models.IntegerField(default=0)
    tokens_out = models.IntegerField(default=0)
    ms = models.IntegerField(default=0)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["conversation", "created_at"])]

    def __str__(self) -> str:
        return f"{self.role}: {self.text[:40]}"
