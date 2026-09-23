"""ASGI config for danbyte - HTTP via Django, WebSockets via Channels."""
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "danbyte.settings")

from django.core.asgi import get_asgi_application

# Initialise Django (apps/models) before importing anything that touches them.
django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import AllowedHostsOriginValidator  # noqa: E402

from api.ws_urls import websocket_urlpatterns

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        # The sockets authenticate by session cookie, and a browser sends that
        # cookie to a WebSocket whatever page opened it. So the Origin has to
        # be one of ours, or another site the user visits could drive their
        # SSH terminal (#228). ALLOWED_HOSTS is already the list of names this
        # deployment answers to; a handshake with no Origin is refused too.
        "websocket": AllowedHostsOriginValidator(
            AuthMiddlewareStack(URLRouter(websocket_urlpatterns))
        ),
    }
)
