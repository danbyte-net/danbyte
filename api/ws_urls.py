"""WebSocket URL routes (mounted by danbyte/asgi.py under the websocket proto)."""
from django.urls import re_path

from .presence_consumer import PresenceConsumer

websocket_urlpatterns = [
    re_path(r"^ws/presence/$", PresenceConsumer.as_asgi()),
]
