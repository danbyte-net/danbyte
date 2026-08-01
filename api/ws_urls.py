"""WebSocket URL routes (mounted by danbyte/asgi.py under the websocket proto)."""
from django.urls import re_path

from monitoring.ssh_terminal_consumer import SshTerminalConsumer

from .presence_consumer import PresenceConsumer

websocket_urlpatterns = [
    re_path(r"^ws/presence/$", PresenceConsumer.as_asgi()),
    re_path(
        r"^ws/ssh/(?P<device_id>[0-9a-fA-F-]{36})/$",
        SshTerminalConsumer.as_asgi(),
    ),
]
