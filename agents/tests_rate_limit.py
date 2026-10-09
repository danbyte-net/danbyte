"""The rate limit counts messages, and bodies and batches are capped (#328).

Counting HTTP requests let one JSON-RPC batch run any number of tool
calls, and ``MAX_BODY`` was declared but never applied.
"""
from __future__ import annotations

import json
from unittest import mock

from django.core.cache import cache

from . import views
from .models import AgentCall
from .tests_mcp import _Base, rpc


class _Limited(_Base):
    def setUp(self):
        super().setUp()
        self.counter = f"mcp-rate:{self.token.pk}"
        cache.delete(self.counter)
        self.addCleanup(cache.delete, self.counter)

    def post(self, body=None, *, raw: str | None = None):
        return self.client.post(
            "/api/mcp/", raw if raw is not None else json.dumps(body),
            content_type="application/json", HTTP_AUTHORIZATION=f"Token {self.key}",
        )

    @staticmethod
    def counts(n: int) -> list[dict]:
        return [rpc("tools/call", {"name": "count", "arguments": {"type": "device"}}, id_=i)
                for i in range(n)]


class BatchRateLimitTests(_Limited):
    def test_every_message_in_a_batch_counts(self):
        with mock.patch.object(views, "RATE_LIMIT", 5):
            response = self.post([rpc("ping", id_=i) for i in range(6)])
        self.assertEqual(response.status_code, 429)
        body = response.json()
        self.assertEqual(body["jsonrpc"], "2.0")
        self.assertEqual(body["error"]["code"], -32001)
        self.assertIsNone(body["id"])
        self.assertEqual(response["Retry-After"], str(views.RATE_WINDOW))

    def test_tool_calls_over_the_limit_never_run(self):
        with mock.patch.object(views, "RATE_LIMIT", 3):
            self.assertEqual(self.post(self.counts(4)).status_code, 429)
        self.assertEqual(AgentCall.objects.count(), 0)

    def test_a_batch_within_the_limit_runs_and_is_charged(self):
        with mock.patch.object(views, "RATE_LIMIT", 5):
            response = self.post([rpc("ping", id_=i) for i in range(5)])
            self.assertEqual(response.status_code, 200)
            self.assertEqual([a["id"] for a in response.json()], [0, 1, 2, 3, 4])
            self.assertEqual(self.post(rpc("ping")).status_code, 429)

    def test_notifications_count_and_still_get_no_answer(self):
        with mock.patch.object(views, "RATE_LIMIT", 2):
            response = self.post([rpc("ping", id_=1),
                                  rpc("notifications/initialized", id_=None)])
            self.assertEqual(response.status_code, 200)
            self.assertEqual([a["id"] for a in response.json()], [1])
            self.assertEqual(self.post(rpc("ping")).status_code, 429)

    def test_single_requests_count_one_each(self):
        with mock.patch.object(views, "RATE_LIMIT", 3):
            for _ in range(3):
                self.assertEqual(self.post(rpc("ping")).status_code, 200)
            response = self.post(rpc("ping"))
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["error"]["code"], -32001)

    def test_the_counter_is_per_token(self):
        from auth_api.models import ApiToken, hash_api_key

        other = "dbt_" + "b" * 48
        ApiToken.objects.create(
            user=self.user, tenant=self.tenant, name="second",
            key_hash=hash_api_key(other), prefix=other[:11], scope="full",
        )
        with mock.patch.object(views, "RATE_LIMIT", 1):
            self.assertEqual(self.post(rpc("ping")).status_code, 200)
            self.assertEqual(self.post(rpc("ping")).status_code, 429)
            response = self.client.post(
                "/api/mcp/", json.dumps(rpc("ping")), content_type="application/json",
                HTTP_AUTHORIZATION=f"Token {other}",
            )
        self.assertEqual(response.status_code, 200)


class CapTests(_Limited):
    def test_a_batch_longer_than_the_cap_is_refused_whole(self):
        response = self.post(self.counts(views.MAX_BATCH + 1))
        self.assertEqual(response.status_code, 400)
        body = response.json()
        self.assertEqual(body["error"]["code"], -32600)
        self.assertIsNone(body["id"])
        self.assertIn(str(views.MAX_BATCH), body["error"]["message"])
        self.assertEqual(AgentCall.objects.count(), 0)
        # A refused batch is not charged against the window.
        self.assertEqual(self.post(rpc("ping")).status_code, 200)

    def test_a_batch_at_the_cap_runs(self):
        response = self.post([rpc("ping", id_=i) for i in range(views.MAX_BATCH)])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), views.MAX_BATCH)

    def test_a_body_over_the_cap_is_refused_before_anything_runs(self):
        padding = "x" * (views.MAX_BODY + 1)
        response = self.post(rpc("tools/call", {"name": "search", "arguments": {"q": padding}}))
        self.assertEqual(response.status_code, 413)
        body = response.json()
        self.assertEqual(body["jsonrpc"], "2.0")
        self.assertEqual(body["error"]["code"], -32600)
        self.assertIsNone(body["id"])
        self.assertEqual(AgentCall.objects.count(), 0)

    def test_a_body_under_the_cap_is_fine(self):
        padding = "x" * (views.MAX_BODY // 2)
        response = self.post(rpc("tools/call", {"name": "search", "arguments": {"q": padding}}))
        self.assertEqual(response.status_code, 200)

    def test_malformed_json_is_a_json_rpc_parse_error(self):
        response = self.post(raw="{not json")
        self.assertEqual(response.status_code, 400)
        body = response.json()
        self.assertEqual(body["error"]["code"], -32700)
        self.assertIsNone(body["id"])

    def test_an_empty_batch_is_an_invalid_request(self):
        response = self.post([])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], -32600)

    def test_a_batch_item_that_is_not_an_object_gets_its_own_error(self):
        response = self.post([rpc("ping", id_=1), 7])
        self.assertEqual(response.status_code, 200)
        answers = response.json()
        self.assertEqual(answers[0]["id"], 1)
        self.assertEqual(answers[1]["error"]["code"], -32600)
        self.assertIsNone(answers[1]["id"])
