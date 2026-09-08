"""Agent access API - mounted at ``/api/agent/`` from ``api/api_urls.py``.
The MCP endpoint itself is ``/api/mcp/``, kept short because operators type
it into their client's config."""
from __future__ import annotations

from django.urls import path

from . import api_views

urlpatterns = [
    path("settings/", api_views.agent_settings, name="agent-settings"),
    path("calls/", api_views.agent_calls, name="agent-calls"),
    path("connect/", api_views.agent_connect, name="agent-connect"),
]
