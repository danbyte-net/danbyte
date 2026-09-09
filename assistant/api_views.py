"""Conversations and the model connection.

A conversation is private to the person who had it, so every queryset here
filters on ``user=request.user`` - a tenant admin does not get to read
someone else's transcript.
"""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.permissions import can_manage_deployment
from core.models import DeploymentSettings
from integrations.toggles import integration_enabled

from . import providers
from .models import Conversation, Message


class MessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = Message
        fields = ["id", "role", "text", "tool", "tokens_in", "tokens_out", "created_at"]
        read_only_fields = fields


class ConversationSerializer(serializers.ModelSerializer):
    message_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Conversation
        fields = ["id", "title", "model", "message_count", "last_message_at", "created_at"]
        read_only_fields = fields


def _tenant(request):
    from api.views import _get_active_tenant

    return _get_active_tenant(request)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def assistant_status(request):
    """Whether the chat is usable here, and what it is pointed at. Any
    member: the top-bar button needs it."""
    from django.db.models import Count

    tenant = _tenant(request)
    dep = DeploymentSettings.load()
    configured = bool((dep.ai_provider or "").strip())
    model = ""
    if configured:
        try:
            model = providers.connection_from(dep).describe()
        except providers.ProviderError:
            configured = False
    return Response({
        "enabled": integration_enabled(tenant, "ai_chat"),
        "configured": configured,
        "model": model,
        "writes_enabled": integration_enabled(tenant, "ai_writes"),
        "conversations": Conversation.objects.filter(
            user=request.user, tenant=tenant
        ).aggregate(n=Count("id"))["n"],
    })


@api_view(["GET", "DELETE"])
@permission_classes([IsAuthenticated])
def conversations(request):
    """This person's own conversations. DELETE clears every one of them."""
    from django.db.models import Count

    tenant = _tenant(request)
    qs = Conversation.objects.filter(user=request.user, tenant=tenant)
    if request.method == "DELETE":
        removed = qs.count()
        qs.delete()
        return Response({"deleted": removed})
    rows = qs.annotate(message_count=Count("messages"))[:100]
    return Response({"results": ConversationSerializer(rows, many=True).data})


@api_view(["GET", "DELETE", "PATCH"])
@permission_classes([IsAuthenticated])
def conversation(request, pk):
    tenant = _tenant(request)
    row = Conversation.objects.filter(pk=pk, user=request.user, tenant=tenant).first()
    if row is None:
        return Response({"detail": "No such conversation."}, status=404)
    if request.method == "DELETE":
        row.delete()
        return Response(status=204)
    if request.method == "PATCH":
        title = str(request.data.get("title") or "").strip()[:120]
        if title:
            row.title = title
            row.save(update_fields=["title", "updated_at"])
    data = ConversationSerializer(row).data
    data["messages"] = MessageSerializer(row.messages.all(), many=True).data
    return Response(data)


class ConnectionSerializer(serializers.Serializer):
    ai_provider = serializers.CharField(required=False, allow_blank=True)
    ai_model = serializers.CharField(required=False, allow_blank=True)
    ai_base_url = serializers.CharField(required=False, allow_blank=True)
    ai_verify_tls = serializers.BooleanField(required=False)
    ai_api_key = serializers.CharField(
        required=False, allow_blank=True, write_only=True, trim_whitespace=False
    )

    def validate_ai_provider(self, value):
        value = (value or "").strip()
        if value and value not in providers.PROVIDERS:
            raise serializers.ValidationError(
                f"One of: {', '.join(providers.PROVIDERS)}."
            )
        return value


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def assistant_connection(request):
    """The model connection. Deployment tier: it decides where the
    conversation is sent and where the key lives."""
    if not can_manage_deployment(request.user):
        return Response({"detail": "Deployment admin required."}, status=403)
    dep = DeploymentSettings.load()
    if request.method == "PUT":
        ser = ConnectionSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        data = dict(ser.validated_data)
        key = data.pop("ai_api_key", None)
        if key:  # blank leaves the stored key alone
            dep.secrets = {**(dep.secrets or {}), "ai_api_key": key}
        for field, value in data.items():
            setattr(dep, field, value)
        dep.save()
        dep = DeploymentSettings.load()
    return Response(_connection_payload(dep))


def _connection_payload(dep) -> dict:
    return {
        "ai_provider": dep.ai_provider,
        "ai_model": dep.ai_model,
        "ai_base_url": dep.ai_base_url,
        "ai_verify_tls": dep.ai_verify_tls,
        "ai_api_key_set": bool((dep.secrets or {}).get("ai_api_key")),
        "providers": [
            {"kind": "anthropic", "label": "Anthropic",
             "default_model": providers.DEFAULT_MODELS["anthropic"],
             "default_base_url": providers.DEFAULT_BASE_URLS["anthropic"],
             "needs_key": True,
             "hint": "The Messages API. Your conversation and the data it reads go to Anthropic."},
            {"kind": "openai", "label": "OpenAI-compatible",
             "default_model": providers.DEFAULT_MODELS["openai"],
             "default_base_url": providers.DEFAULT_BASE_URLS["openai"],
             "needs_key": True,
             "hint": "OpenAI, Azure OpenAI, Groq, OpenRouter and most gateways speak this."},
            {"kind": "local", "label": "Local model",
             "default_model": providers.DEFAULT_MODELS["local"],
             "default_base_url": providers.DEFAULT_BASE_URLS["local"],
             "needs_key": False,
             "hint": "Ollama or LM Studio on your own network. Nothing leaves the building."},
        ],
    }


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def assistant_test(request):
    """Ask the configured model to say one word, so a misconfiguration is
    obvious here rather than in the chat."""
    if not can_manage_deployment(request.user):
        return Response({"detail": "Deployment admin required."}, status=403)
    try:
        conn = providers.connection_from(DeploymentSettings.load())
        return Response(providers.probe(conn))
    except providers.ProviderError as exc:
        return Response({"ok": False, "detail": str(exc)}, status=400)
