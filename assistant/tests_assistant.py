"""The in-app assistant: the toggle, the providers, the loop, and the
privacy of a conversation.

No network anywhere - each provider is exercised against a fake streaming
response, so the wire format is still asserted.
"""
from __future__ import annotations

import json
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase
from rest_framework.test import APITestCase

from agents.models import AgentCall
from api.models import Device, DeviceRole, DeviceType, Manufacturer, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant
from integrations.models import IntegrationSettings

from . import loop, providers
from .models import Conversation, Message


class FakeResponse:
    """Just enough of a streaming requests.Response."""

    def __init__(self, lines, status_code=200, text=""):
        self._lines = lines
        self.status_code = status_code
        self.text = text or ""

    def iter_lines(self, decode_unicode=False):
        yield from self._lines

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def sse(payloads) -> list[str]:
    return [f"data: {json.dumps(p)}" for p in payloads]


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.user = get_user_model().objects.create_user("asker", "a@e.com", "x")
        UserProfile.objects.create(user=self.user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="all", object_types=["*"], actions=["view", "add", "change", "delete"],
            enabled=True,
        )
        perm.tenants.add(self.tenant)
        perm.users.add(self.user)
        IntegrationSettings.objects.create(tenant=self.tenant, ai_chat_enabled=True)
        dep = DeploymentSettings.load()
        dep.ai_provider = "local"
        dep.ai_model = "llama3.1"
        dep.ai_base_url = "http://127.0.0.1:11434"
        dep.save()

        self.site = Site.objects.create(tenant=self.tenant, name="Aarhus")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Dell", slug="dell")
        dtype = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr,
                                          name="R640", model="R640")
        role = DeviceRole.objects.create(tenant=self.tenant, name="Core", slug="core")
        self.device = Device.objects.create(tenant=self.tenant, name="aarhus-core-1",
                                            site=self.site, device_type=dtype, role=role)

    def ctx(self, writes=False):
        return loop.context_for(self.user, self.tenant, writes=writes)


class ConnectionTests(_Base):
    def test_unconfigured_says_so(self):
        dep = DeploymentSettings.load()
        dep.ai_provider = ""
        dep.save()
        with self.assertRaises(providers.ProviderError) as caught:
            providers.connection_from(DeploymentSettings.load())
        self.assertIn("No model is configured", str(caught.exception))

    def test_a_public_provider_needs_a_key(self):
        dep = DeploymentSettings.load()
        dep.ai_provider = "anthropic"
        dep.save()
        with self.assertRaises(providers.ProviderError) as caught:
            providers.connection_from(DeploymentSettings.load())
        self.assertIn("No API key", str(caught.exception))

        dep.secrets = {"ai_api_key": "sk-test"}
        dep.ai_model = ""       # blank falls back to the provider's default
        dep.ai_base_url = ""
        dep.save()
        conn = providers.connection_from(DeploymentSettings.load())
        self.assertEqual(conn.provider, "anthropic")
        self.assertEqual(conn.model, "claude-sonnet-4-5")
        self.assertEqual(conn.base_url, "https://api.anthropic.com")

    def test_local_needs_no_key_and_defaults_to_ollama(self):
        conn = providers.connection_from(DeploymentSettings.load())
        self.assertTrue(conn.is_local)
        self.assertEqual(conn.api_key, "")

    def test_a_public_provider_goes_through_the_outbound_guard(self):
        """A private address configured as a public provider is refused - the
        guard is what stops the chat being pointed at an internal service."""
        dep = DeploymentSettings.load()
        dep.ai_provider = "openai"
        dep.ai_base_url = "http://10.0.0.5:8080"
        dep.secrets = {"ai_api_key": "k"}
        dep.save()
        conn = providers.connection_from(DeploymentSettings.load())
        with self.assertRaises(providers.ProviderError) as caught:
            list(providers.stream(conn, "s", [{"role": "user", "content": "hi"}], []))
        self.assertIn("not a public address", str(caught.exception))

    def test_local_reaches_a_private_address_directly(self):
        conn = providers.connection_from(DeploymentSettings.load())
        with mock.patch("assistant.providers.requests.post") as post:
            post.return_value = FakeResponse(sse([
                {"choices": [{"delta": {"content": "hi"}}]},
            ]))
            events = list(providers.stream(conn, "s", [{"role": "user", "content": "x"}], []))
        self.assertEqual(post.call_args.args[0], "http://127.0.0.1:11434/v1/chat/completions")
        self.assertEqual("".join(e.text for e in events if e.kind == "text"), "hi")


class ProviderStreamTests(_Base):
    def test_openai_shape_text_and_tool_calls(self):
        conn = providers.Connection("openai", "gpt", "https://api.openai.com", "k")
        stream = sse([
            {"choices": [{"delta": {"content": "Look"}}]},
            {"choices": [{"delta": {"content": "ing"}}]},
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "c1", "function": {"name": "list", "arguments": '{"type":'}}
            ]}}]},
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": '"device"}'}}
            ]}, "finish_reason": "tool_calls"}]},
            {"usage": {"prompt_tokens": 11, "completion_tokens": 5}},
        ])
        with mock.patch("assistant.providers.requests.post", return_value=FakeResponse(stream)):
            events = list(providers.stream(conn, "s", [{"role": "user", "content": "x"}], []))
        self.assertEqual("".join(e.text for e in events if e.kind == "text"), "Looking")
        call = next(e for e in events if e.kind == "tool")
        self.assertEqual((call.tool_name, call.tool_input), ("list", {"type": "device"}))
        usage = next(e for e in events if e.kind == "usage")
        self.assertEqual((usage.tokens_in, usage.tokens_out), (11, 5))

    def test_anthropic_shape_text_and_tool_calls(self):
        conn = providers.Connection("anthropic", "claude", "https://api.anthropic.com", "k")
        stream = sse([
            {"type": "message_start", "message": {"usage": {"input_tokens": 9}}},
            {"type": "content_block_start", "content_block": {"type": "text"}},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Two "}},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "sites."}},
            {"type": "content_block_stop"},
            {"type": "content_block_start",
             "content_block": {"type": "tool_use", "id": "t1", "name": "search"}},
            {"type": "content_block_delta",
             "delta": {"type": "input_json_delta", "partial_json": '{"q": "core"}'}},
            {"type": "content_block_stop"},
            {"type": "message_delta", "usage": {"output_tokens": 4}},
        ])
        with mock.patch("assistant.providers.requests.post", return_value=FakeResponse(stream)):
            events = list(providers.stream(conn, "s", [{"role": "user", "content": "x"}], []))
        self.assertEqual("".join(e.text for e in events if e.kind == "text"), "Two sites.")
        call = next(e for e in events if e.kind == "tool")
        self.assertEqual((call.tool_name, call.tool_input), ("search", {"q": "core"}))

    def test_the_tool_schema_is_translated_per_provider(self):
        spec = {"name": "list", "description": "d",
                "inputSchema": {"type": "object", "properties": {}}}
        self.assertEqual(providers._anthropic_tools([spec])[0]["input_schema"],
                         spec["inputSchema"])
        openai = providers._openai_tools([spec])[0]
        self.assertEqual(openai["type"], "function")
        self.assertEqual(openai["function"]["parameters"], spec["inputSchema"])

    def test_provider_errors_are_readable(self):
        conn = providers.Connection("openai", "gpt", "https://api.openai.com", "bad")
        for status, expected in ((401, "refused the API key"), (429, "rate-limiting"),
                                 (500, "answered 500")):
            with mock.patch("assistant.providers.requests.post",
                            return_value=FakeResponse([], status_code=status, text="nope")):
                with self.assertRaises(providers.ProviderError) as caught:
                    list(providers.stream(conn, "s", [{"role": "user", "content": "x"}], []))
            self.assertIn(expected, str(caught.exception))


class LoopTests(_Base):
    def _answer(self, streams, writes=False, question="which devices are at Aarhus?"):
        """Drive the loop with one canned model reply per turn."""
        conn = providers.connection_from(DeploymentSettings.load())
        with mock.patch("assistant.providers.requests.post",
                        side_effect=[FakeResponse(s) for s in streams]):
            return list(loop.answer(conn, self.ctx(writes=writes), [], question))

    def test_a_tool_call_round_trips_and_the_answer_streams(self):
        frames = self._answer([
            sse([{"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "c1",
                 "function": {"name": "list", "arguments": '{"type": "device"}'}}]},
                "finish_reason": "tool_calls"}]}]),
            sse([{"choices": [{"delta": {"content": "One device: aarhus-core-1."}}]}]),
        ])
        tool = next(f for f in frames if f["t"] == "tool")
        self.assertEqual(tool["name"], "list")
        self.assertEqual(tool["rows"], 1)
        self.assertEqual(tool["error"], "")
        final = frames[-1]
        self.assertEqual(final["t"], "final")
        self.assertIn("aarhus-core-1", final["text"])
        # the tool result actually carried the device to the model
        self.assertTrue(any(f["t"] == "delta" for f in frames))

    def test_the_chat_only_sees_what_the_person_sees(self):
        elsewhere = Site.objects.create(tenant=self.tenant, name="HQ")
        Device.objects.create(tenant=self.tenant, name="hq-core-1", site=elsewhere,
                              device_type=self.device.device_type, role=self.device.role)
        ObjectPermission.objects.all().delete()
        perm = ObjectPermission.objects.create(
            name="one-site", object_types=["*"], actions=["view"], enabled=True)
        perm.tenants.add(self.tenant)
        perm.users.add(self.user)
        perm.sites.add(self.site)

        result, rows, error, _card = loop.run_tool(self.ctx(), "list", {"type": "device"})
        self.assertEqual(error, "")
        self.assertIn("aarhus-core-1", result)
        self.assertNotIn("hq-core-1", result)
        self.assertEqual(rows, 1)

    def test_writes_are_refused_when_the_switch_is_off(self):
        result, rows, error, _card = loop.run_tool(
            self.ctx(writes=False), "create", {"type": "site", "payload": {"name": "X"}}
        )
        self.assertIn("switched off", error)
        self.assertFalse(Site.objects.filter(name="X").exists())
        # and the attempt is on the record
        call = AgentCall.objects.get(tool="create")
        self.assertIn("switched off", call.error)
        self.assertFalse(call.wrote)

    def test_writes_work_and_are_audited_when_on(self):
        from audit.models import ChangeLogEntry

        result, rows, error, _card = loop.run_tool(
            self.ctx(writes=True), "create", {"type": "site", "payload": {"name": "Odense"}}
        )
        self.assertEqual(error, "")
        self.assertTrue(Site.objects.filter(name="Odense").exists())
        entry = ChangeLogEntry.objects.filter(object_repr__icontains="Odense").first()
        self.assertIsNotNone(entry)
        self.assertEqual(entry.user_name, "asker")

    def test_every_tool_call_lands_in_the_shared_log_as_chat(self):
        loop.run_tool(self.ctx(), "list", {"type": "device"})
        call = AgentCall.objects.get()
        self.assertEqual(call.client, "chat")
        self.assertEqual(call.tool, "list")
        self.assertEqual(call.rows, 1)
        self.assertIsNone(call.token)
        self.assertEqual(call.user, self.user)

    def test_a_broken_tool_call_is_reported_not_raised(self):
        result, rows, error, _card = loop.run_tool(self.ctx(), "get",
                                            {"type": "device", "id": "nope"})
        self.assertIn("nope", error)
        self.assertEqual(rows, 0)

    def test_the_turn_cap_stops_a_loop(self):
        forever = sse([{"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "c", "function": {"name": "types", "arguments": "{}"}}]},
            "finish_reason": "tool_calls"}]}])
        frames = self._answer([forever] * (loop.MAX_TURNS + 1))
        self.assertIn("stopped after several rounds", frames[-1]["text"])
        self.assertEqual(len([f for f in frames if f["t"] == "tool"]), loop.MAX_TURNS)

    def test_a_big_result_is_trimmed_before_the_model_sees_it(self):
        big = {"rows": [{"name": "x" * 200} for _ in range(500)]}
        self.assertLessEqual(len(loop._shorten(big)), loop.MAX_TOOL_CHARS + 40)
        self.assertIn("truncated", loop._shorten(big))

    def test_history_replays_text_not_tool_rounds(self):
        conversation = Conversation.objects.create(tenant=self.tenant, user=self.user,
                                                   title="t")
        Message.objects.create(conversation=conversation, role="user", text="first?")
        Message.objects.create(conversation=conversation, role="tool",
                               tool={"name": "list", "rows": 9})
        Message.objects.create(conversation=conversation, role="assistant", text="nine.")
        Message.objects.create(conversation=conversation, role="user", text="and now?")
        from .consumers import _history

        history = _history(conversation, "openai")
        self.assertEqual([m["role"] for m in history], ["user", "assistant"])
        self.assertEqual(history[-1]["content"], "nine.")


class SocketTenantTests(TransactionTestCase):
    """The socket must land on the same tenant as the pages.

    It first rolled its own lookup and fell through to the profile's tenant
    list, which a superuser's profile is empty of - so the chat opened with
    "No active tenant" for exactly the people most likely to try it.
    """

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.user = get_user_model().objects.create_user("asker", "a@e.com", "x")
        UserProfile.objects.create(user=self.user, role="custom").tenants.add(self.tenant)
        IntegrationSettings.objects.create(tenant=self.tenant, ai_chat_enabled=True)
        dep = DeploymentSettings.load()
        dep.ai_provider = "local"
        dep.ai_model = "stub"
        dep.save()

    def _connect(self, session):
        from asgiref.sync import async_to_sync
        from channels.testing import WebsocketCommunicator

        from .consumers import ChatConsumer

        async def run():
            comm = WebsocketCommunicator(ChatConsumer.as_asgi(), "/ws/chat/")
            comm.scope["user"] = self.user
            comm.scope["session"] = session
            connected, _ = await comm.connect(timeout=5)
            frame = await comm.receive_json_from(timeout=5) if connected else None
            await comm.disconnect()
            return frame

        return async_to_sync(run)()

    def test_a_superuser_with_no_profile_tenants_still_gets_one(self):
        admin = get_user_model().objects.create_superuser("root", "r@e.com", "x")
        UserProfile.objects.create(user=admin, role="admin")  # no tenants at all
        self.user = admin
        frame = self._connect({})
        self.assertEqual(frame["t"], "ready", frame)

    def test_the_session_choice_wins(self):
        other = Tenant.objects.create(org=self.tenant.org, name="Second", slug="second")
        IntegrationSettings.objects.create(tenant=other, ai_chat_enabled=False)
        self.user.profile.tenants.add(other)
        # the chat is off for that tenant, so picking it must be refused
        frame = self._connect({"current_tenant_id": str(other.id)})
        self.assertEqual(frame["t"], "error")
        self.assertIn("switched off", frame["m"])
        frame = self._connect({"current_tenant_id": str(self.tenant.id)})
        self.assertEqual(frame["t"], "ready")

    def test_an_anonymous_socket_is_closed(self):
        from asgiref.sync import async_to_sync
        from channels.testing import WebsocketCommunicator
        from django.contrib.auth.models import AnonymousUser

        from .consumers import ChatConsumer

        async def run():
            comm = WebsocketCommunicator(ChatConsumer.as_asgi(), "/ws/chat/")
            comm.scope["user"] = AnonymousUser()
            comm.scope["session"] = {}
            connected, code = await comm.connect(timeout=5)
            return connected, code

        connected, code = async_to_sync(run)()
        self.assertFalse(connected)
        self.assertEqual(code, 4401)


class ApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.user)

    def test_status_reports_the_toggle_and_model(self):
        body = self.client.get("/api/assistant/status/").json()
        self.assertTrue(body["enabled"])
        self.assertTrue(body["configured"])
        self.assertEqual(body["model"], "local:llama3.1")
        self.assertFalse(body["writes_enabled"])

        IntegrationSettings.objects.filter(tenant=self.tenant).update(ai_chat_enabled=False)
        self.assertFalse(self.client.get("/api/assistant/status/").json()["enabled"])

    def test_conversations_are_private_to_their_owner(self):
        mine = Conversation.objects.create(tenant=self.tenant, user=self.user, title="mine")
        other = get_user_model().objects.create_user("other", "o@e.com", "x")
        UserProfile.objects.create(user=other, role="custom").tenants.add(self.tenant)
        theirs = Conversation.objects.create(tenant=self.tenant, user=other, title="theirs")

        titles = [c["title"] for c in self.client.get("/api/assistant/conversations/").json()["results"]]
        self.assertEqual(titles, ["mine"])
        self.assertEqual(self.client.get(f"/api/assistant/conversations/{theirs.id}/").status_code, 404)
        self.assertEqual(self.client.get(f"/api/assistant/conversations/{mine.id}/").status_code, 200)

        # even a superuser does not get to read someone else's transcript
        admin = get_user_model().objects.create_superuser("root", "r@e.com", "x")
        UserProfile.objects.create(user=admin, role="admin").tenants.add(self.tenant)
        self.client.force_login(admin)
        self.assertEqual(self.client.get(f"/api/assistant/conversations/{mine.id}/").status_code, 404)

    def test_delete_one_and_delete_all(self):
        a = Conversation.objects.create(tenant=self.tenant, user=self.user, title="a")
        Conversation.objects.create(tenant=self.tenant, user=self.user, title="b")
        self.assertEqual(self.client.delete(f"/api/assistant/conversations/{a.id}/").status_code, 204)
        self.assertEqual(Conversation.objects.filter(user=self.user).count(), 1)
        body = self.client.delete("/api/assistant/conversations/").json()
        self.assertEqual(body["deleted"], 1)
        self.assertEqual(Conversation.objects.filter(user=self.user).count(), 0)

    def test_the_connection_is_deployment_admin_only(self):
        self.assertEqual(self.client.get("/api/assistant/connection/").status_code, 403)
        admin = get_user_model().objects.create_superuser("root", "r@e.com", "x")
        self.client.force_login(admin)
        body = self.client.get("/api/assistant/connection/").json()
        self.assertEqual(body["ai_provider"], "local")
        self.assertFalse(body["ai_api_key_set"])
        self.assertEqual({p["kind"] for p in body["providers"]},
                         {"anthropic", "openai", "local"})

        r = self.client.put("/api/assistant/connection/",
                            {"ai_provider": "anthropic", "ai_api_key": "sk-secret"},
                            content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["ai_api_key_set"])
        self.assertNotIn("sk-secret", json.dumps(r.json()))

        # a blank key leaves the stored one alone
        r = self.client.put("/api/assistant/connection/", {"ai_api_key": ""},
                            content_type="application/json")
        self.assertTrue(r.json()["ai_api_key_set"])

        r = self.client.put("/api/assistant/connection/", {"ai_provider": "wat"},
                            content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_the_test_button_reports_a_failure_readably(self):
        admin = get_user_model().objects.create_superuser("root", "r@e.com", "x")
        self.client.force_login(admin)
        with mock.patch("assistant.providers.requests.post",
                        return_value=FakeResponse([], status_code=401)):
            r = self.client.post("/api/assistant/connection/test/")
        self.assertEqual(r.status_code, 400)
        self.assertIn("refused the API key", r.json()["detail"])
