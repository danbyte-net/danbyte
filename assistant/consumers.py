"""The chat socket.

Streaming has to go over the WebSocket process, not HTTP: gunicorn runs
sync workers with a 60-second timeout, so a long answer would hold a
worker hostage and still be cut off mid-sentence. daphne already serves
``/ws/`` for presence and the SSH terminal, and nginx gives it an hour.

Frames, matching the terminal's short-tag style
(``monitoring/ssh_terminal_consumer.py``):

    client → {"t": "ask", "text": …, "conversation": id?}
             {"t": "ping"}
    server → {"t": "ready", "model": …, "writes": bool}
             {"t": "start", "conversation": id, "title": …}
             {"t": "delta", "d": "…"}            text as it arrives
             {"t": "tool", "name", "args", "rows", "error"}
             {"t": "done", "message": id}
             {"t": "error", "m": "…"}
"""
from __future__ import annotations

import logging

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.utils import timezone

from .models import Conversation, Message

logger = logging.getLogger(__name__)

CLOSE_UNAUTH = 4401
CLOSE_DISABLED = 4403
MAX_QUESTION = 4000
IDLE_SECONDS = 30 * 60


class ChatConsumer(AsyncJsonWebsocketConsumer):
    # Point-to-point, no groups - the same reason the terminal does it:
    # Channels' Redis receive loop would otherwise time out an idle socket.
    channel_layer_alias = "assistant-none"

    _busy = False

    async def connect(self):
        user = self.scope.get("user")
        if user is None or not getattr(user, "is_authenticated", False):
            await self.close(code=CLOSE_UNAUTH)
            return
        self.user = user
        ready = await self._prepare()
        await self.accept()
        if ready.get("error"):
            await self.send_json({"t": "error", "m": ready["error"]})
            await self.close(code=CLOSE_DISABLED)
            return
        self.tenant_id = ready["tenant_id"]
        self.writes = ready["writes"]
        await self.send_json({"t": "ready", "model": ready["model"], "writes": ready["writes"]})

    @database_sync_to_async
    def _prepare(self) -> dict:
        """Tenant, toggle and model connection, resolved once per socket."""
        from core.models import DeploymentSettings, Tenant
        from integrations.toggles import integration_enabled

        from . import providers

        session = self.scope.get("session") or {}
        tenant_id = session.get("current_tenant_id")
        tenant = None
        if tenant_id:
            tenant = Tenant.objects.filter(pk=tenant_id).first()
        if tenant is None:
            profile = getattr(self.user, "profile", None)
            tenant = getattr(profile, "current_tenant", None) or (
                profile.tenants.first() if profile else None
            )
        if tenant is None:
            return {"error": "No active tenant."}
        if not integration_enabled(tenant, "ai_chat"):
            return {"error": "The assistant is switched off for this tenant."}
        try:
            conn = providers.connection_from(DeploymentSettings.load())
        except providers.ProviderError as exc:
            return {"error": str(exc)}
        return {
            "tenant_id": str(tenant.id),
            "model": conn.describe(),
            "writes": integration_enabled(tenant, "ai_writes"),
        }

    async def receive_json(self, content, **kwargs):
        tag = content.get("t")
        if tag == "ping":
            await self.send_json({"t": "pong"})
            return
        if tag != "ask":
            return
        if self._busy:
            await self.send_json({"t": "error", "m": "Still answering the last question."})
            return
        question = str(content.get("text") or "").strip()[:MAX_QUESTION]
        if not question:
            return
        self._busy = True
        try:
            await self._answer(question, content.get("conversation"))
        except Exception as exc:  # noqa: BLE001 - never drop the socket on one bad turn
            logger.exception("assistant turn failed")
            await self.send_json({"t": "error", "m": _readable(exc)})
        finally:
            self._busy = False

    async def _answer(self, question: str, conversation_id) -> None:
        setup = await self._begin(question, conversation_id)
        if setup.get("error"):
            await self.send_json({"t": "error", "m": setup["error"]})
            return
        await self.send_json({"t": "start", "conversation": setup["conversation"],
                              "title": setup["title"]})

        frames = await self._run(setup["conversation"], question)
        final = None
        for frame in frames:
            if frame["t"] == "final":
                final = frame
                continue
            await self.send_json(frame)
        if final is not None:
            saved = await self._finish(setup["conversation"], final)
            await self.send_json({"t": "done", "message": saved})

    @database_sync_to_async
    def _begin(self, question: str, conversation_id) -> dict:
        from core.models import Tenant

        tenant = Tenant.objects.filter(pk=self.tenant_id).first()
        if tenant is None:
            return {"error": "No active tenant."}
        conversation = None
        if conversation_id:
            conversation = Conversation.objects.filter(
                pk=conversation_id, user=self.user
            ).first()
        if conversation is None:
            conversation = Conversation.objects.create(
                tenant=tenant, user=self.user, title=Conversation.title_from(question)
            )
        Message.objects.create(conversation=conversation, role="user", text=question)
        conversation.touch()
        return {"conversation": str(conversation.id), "title": conversation.title}

    @database_sync_to_async
    def _run(self, conversation_id: str, question: str) -> list[dict]:
        """The whole turn, in one worker thread.

        The model call and the tool calls are both blocking, and every tool
        touches the ORM, so this stays sync and the frames are collected
        rather than streamed straight out. Text still arrives in pieces from
        the client's point of view because a turn sends many frames.
        """
        from core.models import DeploymentSettings, Tenant

        from . import loop, providers

        tenant = Tenant.objects.get(pk=self.tenant_id)
        conversation = Conversation.objects.get(pk=conversation_id, user=self.user)
        conn = providers.connection_from(DeploymentSettings.load())
        ctx = loop.context_for(self.user, tenant, writes=self.writes)
        history = _history(conversation, conn.provider)
        out: list[dict] = []
        try:
            for frame in loop.answer(conn, ctx, history, question):
                out.append(frame)
                if frame["t"] == "tool":
                    Message.objects.create(
                        conversation=conversation, role="tool",
                        tool={"name": frame["name"], "arguments": frame["args"],
                              "rows": frame["rows"], "error": frame["error"]},
                    )
        except providers.ProviderError as exc:
            out.append({"t": "error", "m": str(exc)})
        return out

    @database_sync_to_async
    def _finish(self, conversation_id: str, final: dict) -> str:
        conversation = Conversation.objects.get(pk=conversation_id, user=self.user)
        message = Message.objects.create(
            conversation=conversation, role="assistant", text=final.get("text", ""),
            tokens_in=final.get("tokens_in", 0), tokens_out=final.get("tokens_out", 0),
        )
        conversation.touch(timezone.now())
        return str(message.id)


def _history(conversation: Conversation, provider: str) -> list[dict]:
    """Earlier turns, as plain text. Tool rounds are not replayed: the model
    gets the conclusions it already wrote, which is enough context and far
    cheaper than every row it once read."""
    out: list[dict] = []
    rows = conversation.messages.exclude(role="tool").order_by("created_at")
    for row in list(rows)[-20:]:
        if row.role == "user":
            out.append({"role": "user", "content": row.text})
        elif row.role == "assistant" and row.text.strip():
            out.append({"role": "assistant", "content": row.text})
    # The current question is appended by the loop, so drop it if it is the
    # last thing stored.
    if out and out[-1]["role"] == "user":
        out.pop()
    return out


def _readable(exc: Exception) -> str:
    from .providers import ProviderError

    if isinstance(exc, ProviderError):
        return str(exc)
    return "Something went wrong answering that. The deployment log has the detail."
