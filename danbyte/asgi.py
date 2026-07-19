"""ASGI config for danbyte — HTTP via Django, WebSockets via Channels."""
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "danbyte.settings")

from django.core.asgi import get_asgi_application

# Initialise Django (apps/models) before importing anything that touches them.
django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter

from api.ws_urls import websocket_urlpatterns

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": AuthMiddlewareStack(URLRouter(websocket_urlpatterns)),
    }
)
