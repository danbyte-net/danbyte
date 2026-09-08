"""The settings page behind agent access: what an assistant may reach, and
what it actually did."""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.permissions import can_manage_admin
from integrations.toggles import integration_enabled

from .dispatch import known_types
from .models import MAX_ROWS_CEILING, AgentCall, AgentSettings


class AgentSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = AgentSettings
        fields = ["allowed_types", "max_rows", "log_retention_days"]

    def validate_allowed_types(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError("Expected a list of object types.")
        known = set(known_types())
        unknown = [t for t in value if t not in known]
        if unknown:
            raise serializers.ValidationError(f"Not object types: {', '.join(unknown)}.")
        return list(dict.fromkeys(value))

    def validate_max_rows(self, value):
        if not 1 <= int(value) <= MAX_ROWS_CEILING:
            raise serializers.ValidationError(f"Between 1 and {MAX_ROWS_CEILING}.")
        return value


class AgentCallSerializer(serializers.ModelSerializer):
    user_name = serializers.CharField(source="user.username", read_only=True, default=None)

    class Meta:
        model = AgentCall
        fields = [
            "id", "tool", "object_type", "arguments", "rows", "wrote", "ms",
            "error", "client", "token_name", "user_name", "created_at",
        ]
        read_only_fields = fields


def _tenant_or_none(request):
    from api.views import _get_active_tenant

    return _get_active_tenant(request)


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def agent_settings(request):
    """Narrowing for agent access. Readable by any member so the page can
    render; writable by a tenant admin, like the integration toggles."""
    tenant = _tenant_or_none(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=400)
    row, _ = AgentSettings.objects.get_or_create(tenant=tenant)
    if request.method == "PUT":
        if not can_manage_admin(request.user, tenant):
            return Response({"detail": "Tenant admin required."}, status=403)
        ser = AgentSettingsSerializer(row, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
    data = AgentSettingsSerializer(row).data
    data["enabled"] = integration_enabled(tenant, "ai")
    data["writes_enabled"] = integration_enabled(tenant, "ai_writes")
    data["known_types"] = known_types()
    return Response(data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def agent_calls(request):
    """What assistants have asked for. Tenant admins only - the arguments
    can name objects a plain member should not browse through here."""
    tenant = _tenant_or_none(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=400)
    if not can_manage_admin(request.user, tenant):
        return Response({"detail": "Tenant admin required."}, status=403)
    qs = AgentCall.objects.filter(tenant=tenant).select_related("user")
    if request.query_params.get("tool"):
        qs = qs.filter(tool=request.query_params["tool"])
    if request.query_params.get("errors") == "1":
        qs = qs.exclude(error="")
    limit = min(int(request.query_params.get("limit") or 100), 500)
    rows = AgentCallSerializer(qs[:limit], many=True).data
    return Response({"results": rows, "count": qs.count()})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def agent_connect(request):
    """The snippets an operator pastes into their client's config. Built
    server-side so the URL is this deployment's, not a guess."""
    from core.models import DeploymentSettings

    tenant = _tenant_or_none(request)
    base = (DeploymentSettings.load().public_base_url or "").rstrip("/")
    if not base:
        base = request.build_absolute_uri("/").rstrip("/")
    url = f"{base}/api/mcp/"
    return Response({
        "url": url,
        "enabled": integration_enabled(tenant, "ai"),
        "writes_enabled": integration_enabled(tenant, "ai_writes"),
        "clients": [
            {
                "id": "claude-code",
                "label": "Claude Code",
                "kind": "shell",
                "snippet": (
                    f'claude mcp add --transport http danbyte {url} '
                    f'--header "Authorization: Token <your-token>"'
                ),
            },
            {
                "id": "claude-desktop",
                "label": "Claude Desktop",
                "kind": "json",
                "path": "claude_desktop_config.json",
                "snippet": _json_snippet(url, remote=True),
            },
            {
                "id": "cursor",
                "label": "Cursor",
                "kind": "json",
                "path": ".cursor/mcp.json",
                "snippet": _json_snippet(url),
            },
            {
                "id": "vscode",
                "label": "VS Code",
                "kind": "json",
                "path": ".vscode/mcp.json",
                "snippet": _vscode_snippet(url),
            },
        ],
    })


def _json_snippet(url: str, *, remote: bool = False) -> str:
    import json

    if remote:
        # Claude Desktop speaks stdio, so it reaches an HTTP server through
        # the mcp-remote shim.
        body = {
            "mcpServers": {
                "danbyte": {
                    "command": "npx",
                    "args": ["-y", "mcp-remote", url, "--header",
                             "Authorization: Token <your-token>"],
                }
            }
        }
    else:
        body = {
            "mcpServers": {
                "danbyte": {
                    "url": url,
                    "headers": {"Authorization": "Token <your-token>"},
                }
            }
        }
    return json.dumps(body, indent=2)


def _vscode_snippet(url: str) -> str:
    import json

    return json.dumps({
        "servers": {
            "danbyte": {
                "type": "http",
                "url": url,
                "headers": {"Authorization": "Token ${input:danbyte_token}"},
            }
        },
        "inputs": [{
            "id": "danbyte_token", "type": "promptString",
            "description": "Danbyte API token", "password": True,
        }],
    }, indent=2)
