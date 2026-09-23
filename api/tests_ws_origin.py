"""A WebSocket handshake from another site is refused before any consumer
runs (#228). The sockets authenticate by session cookie, which a browser
sends whatever page opens the socket, so the Origin is the check."""
from __future__ import annotations

from asgiref.sync import async_to_sync
from channels.security.websocket import OriginValidator
from channels.testing import WebsocketCommunicator
from django.test import SimpleTestCase, override_settings


@override_settings(ALLOWED_HOSTS=["danbyte.test"])
class WebSocketOriginTests(SimpleTestCase):
    def _connect(self, path, origin=None):
        from danbyte.asgi import application

        headers = [(b"origin", origin.encode())] if origin else []

        async def go():
            c = WebsocketCommunicator(application, path, headers=headers)
            connected, _ = await c.connect()
            await c.disconnect()
            return connected

        return async_to_sync(go)()

    def test_the_socket_router_sits_behind_the_origin_check(self):
        from danbyte.asgi import application

        self.assertIsInstance(
            application.application_mapping["websocket"], OriginValidator
        )

    def test_a_foreign_origin_is_refused_on_every_socket(self):
        for path in ("/ws/ssh/00000000-0000-0000-0000-000000000000/",
                     "/ws/chat/", "/ws/presence/"):
            with self.subTest(path=path):
                self.assertFalse(self._connect(path, "https://evil.example"))

    def test_no_origin_is_refused(self):
        self.assertFalse(self._connect("/ws/chat/"))

    def test_our_own_origin_passes_the_check(self):
        validator = OriginValidator(None, ["danbyte.test"])
        from urllib.parse import urlparse

        self.assertTrue(validator.valid_origin(urlparse("https://danbyte.test:8443")))
        self.assertFalse(validator.valid_origin(urlparse("https://evil.example")))
