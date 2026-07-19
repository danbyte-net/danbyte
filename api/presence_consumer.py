"""WebSocket presence consumer — real-time "who else is here".

Layered on top of the same Redis presence store the polling endpoints use
(``core.presence``), so WS and any polling clients see one another. On
connect/disconnect/mode-change it broadcasts to a per-object channel group; each
member then re-reads the (self-excluded) present list and pushes it to its
client. Sync consumer — the presence store is plain (sync) Redis.
"""
from __future__ import annotations

import hashlib
from urllib.parse import parse_qs

from asgiref.sync import async_to_sync
from channels.generic.websocket import JsonWebsocketConsumer

from core import presence

VALID_MODES = {"viewing", "editing"}


def _display_name(user) -> str:
    full = (user.get_full_name() or "").strip()
    return full or user.get_username()


class PresenceConsumer(JsonWebsocketConsumer):
    group = None

    def connect(self):
        user = self.scope.get("user")
        if user is None or not getattr(user, "is_authenticated", False):
            self.close(code=4401)
            return
        session = self.scope.get("session")
        self.tenant_id = session.get("current_tenant_id") if session else None
        qs = parse_qs(self.scope.get("query_string", b"").decode())
        self.object_type = (qs.get("object_type", [""])[0]).strip()
        self.object_id = (qs.get("object_id", [""])[0]).strip()
        self.mode = qs.get("mode", ["viewing"])[0]
        if self.mode not in VALID_MODES:
            self.mode = "viewing"
        if not (self.tenant_id and self.object_type and self.object_id):
            self.close(code=4400)
            return
        self.user = user
        # Hash to a fixed-length group name (Channels caps group names ~100).
        self.group = "presence_" + hashlib.md5(
            f"{self.tenant_id}:{self.object_type}:{self.object_id}".encode()
        ).hexdigest()
        async_to_sync(self.channel_layer.group_add)(self.group, self.channel_name)
        self.accept()
        self._beat()
        self._broadcast()

    def receive_json(self, content, **kwargs):
        t = content.get("type")
        if t == "mode":
            m = content.get("mode")
            if m in VALID_MODES:
                self.mode = m
            self._beat()
            self._broadcast()
        elif t == "ping":
            self._beat()

    def disconnect(self, code):
        if not self.group:
            return
        try:
            presence.leave(
                self.tenant_id, self.object_type, self.object_id,
                user_id=self.user.id,
            )
        except Exception:  # noqa: BLE001
            pass
        self._broadcast()
        async_to_sync(self.channel_layer.group_discard)(
            self.group, self.channel_name
        )

    # ─── helpers ────────────────────────────────────────────────────────────
    def _beat(self):
        presence.heartbeat(
            self.tenant_id, self.object_type, self.object_id,
            user_id=self.user.id, name=_display_name(self.user), mode=self.mode,
        )

    def _broadcast(self):
        async_to_sync(self.channel_layer.group_send)(
            self.group, {"type": "presence.refresh"}
        )

    # Group event → push the self-excluded present list to this client.
    def presence_refresh(self, event):
        self.send_json(
            {
                "present": presence.present(
                    self.tenant_id, self.object_type, self.object_id,
                    exclude_user_id=self.user.id,
                )
            }
        )
