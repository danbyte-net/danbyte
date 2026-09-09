"""Assistant API - mounted at ``/api/assistant/`` from ``api/api_urls.py``.
The chat itself runs over ``/ws/chat/``; these are the surrounding pieces."""
from __future__ import annotations

from django.urls import path

from . import api_views

urlpatterns = [
    path("status/", api_views.assistant_status, name="assistant-status"),
    path("connection/", api_views.assistant_connection, name="assistant-connection"),
    path("connection/test/", api_views.assistant_test, name="assistant-test"),
    path("conversations/", api_views.conversations, name="assistant-conversations"),
    path("conversations/<uuid:pk>/", api_views.conversation, name="assistant-conversation"),
]
