"""Talking to a model.

Three connection kinds behind one interface, each a couple of streaming
POSTs rather than an SDK - an airgapped installer should not have to carry
two vendor packages to answer questions about your own data.

* ``anthropic`` - the Messages API.
* ``openai`` - Chat Completions, which OpenAI, Azure OpenAI, Groq,
  OpenRouter and most gateways all speak.
* ``local`` - the same Chat Completions shape pointed at Ollama or LM
  Studio on your own network, so nothing leaves the building.

Outbound safety: a public provider goes through the SSRF guard unchanged.
A local endpoint is loopback or RFC1918, which that guard blocks by
design, so the local kind connects directly - it is deployment-admin
configuration, exactly like the Vault backend (``core/models.py:427``),
and a tenant admin can never point it anywhere.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import requests

from core.ssrf import SSRFError, assert_public_url

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT = 15
READ_TIMEOUT = 300
MAX_TOKENS = 2048

PROVIDERS = ("anthropic", "openai", "local")

DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-4-5",
    "openai": "gpt-4o-mini",
    "local": "llama3.1",
}

DEFAULT_BASE_URLS = {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com",
    "local": "http://127.0.0.1:11434",
}


class ProviderError(RuntimeError):
    """Something the operator can act on: a bad key, an unreachable host."""


@dataclass
class Event:
    """One thing that happened while the model was answering."""

    kind: str          # "text" | "tool" | "usage" | "stop"
    text: str = ""
    tool_id: str = ""
    tool_name: str = ""
    tool_input: dict | None = None
    tokens_in: int = 0
    tokens_out: int = 0


@dataclass
class Connection:
    provider: str
    model: str
    base_url: str
    api_key: str = ""
    verify_tls: bool = True

    @property
    def is_local(self) -> bool:
        return self.provider == "local"

    def describe(self) -> str:
        return f"{self.provider}:{self.model}"


def connection_from(dep) -> Connection:
    """Build a connection from the deployment settings row."""
    provider = (dep.ai_provider or "").strip()
    if provider not in PROVIDERS:
        raise ProviderError(
            "No model is configured. A deployment admin sets one under "
            "Settings → Security → Assistant."
        )
    base = (dep.ai_base_url or "").strip() or DEFAULT_BASE_URLS[provider]
    key = (dep.secrets or {}).get("ai_api_key", "")
    if provider != "local" and not key:
        raise ProviderError(f"No API key is configured for {provider}.")
    return Connection(
        provider=provider,
        model=(dep.ai_model or "").strip() or DEFAULT_MODELS[provider],
        base_url=base.rstrip("/"),
        api_key=key,
        verify_tls=bool(getattr(dep, "ai_verify_tls", True)),
    )


# ─── the wire ───────────────────────────────────────────────────────────────

def _post(conn: Connection, path: str, body: dict, headers: dict) -> Any:
    """One streaming POST, guarded for public hosts and direct for local."""
    url = f"{conn.base_url}{path}"
    kwargs = {
        "json": body,
        "headers": headers,
        "stream": True,
        "timeout": (CONNECT_TIMEOUT, READ_TIMEOUT),
    }
    try:
        if conn.is_local:
            # Deployment-configured and deliberately internal; the tenant
            # SSRF guard would reject it for being RFC1918, which is the
            # whole point of the local option.
            return requests.post(url, verify=conn.verify_tls, **kwargs)
        assert_public_url(url)
        return requests.post(url, verify=conn.verify_tls, **kwargs)
    except SSRFError as exc:
        raise ProviderError(
            f"{conn.base_url} is not a public address. Use the local provider "
            f"for a model on your own network. ({exc})"
        ) from exc
    except requests.RequestException as exc:
        raise ProviderError(f"Could not reach {conn.base_url}: {exc}") from exc


def _check(response) -> None:
    if response.status_code < 400:
        return
    body = response.text[:400]
    if response.status_code in (401, 403):
        raise ProviderError(f"The model provider refused the API key ({response.status_code}).")
    if response.status_code == 404:
        raise ProviderError(
            f"The provider has no such endpoint or model ({response.status_code}). {body}"
        )
    if response.status_code == 429:
        raise ProviderError("The model provider is rate-limiting this key. Try again shortly.")
    raise ProviderError(f"The model provider answered {response.status_code}: {body}")


def _sse_lines(response) -> Iterator[dict]:
    """Yield the JSON payload of each `data:` line in an SSE body."""
    for raw in response.iter_lines(decode_unicode=True):
        if not raw or not raw.startswith("data:"):
            continue
        chunk = raw[5:].strip()
        if not chunk or chunk == "[DONE]":
            continue
        try:
            yield json.loads(chunk)
        except ValueError:
            logger.debug("unparsable stream chunk: %s", chunk[:120])


# ─── Anthropic ──────────────────────────────────────────────────────────────

def _anthropic_tools(tools: list[dict]) -> list[dict]:
    return [
        {"name": t["name"], "description": t["description"],
         "input_schema": t["inputSchema"]}
        for t in tools
    ]


def _stream_anthropic(conn: Connection, system: str, messages: list[dict],
                      tools: list[dict]) -> Iterator[Event]:
    body = {
        "model": conn.model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": messages,
        "stream": True,
    }
    if tools:
        body["tools"] = _anthropic_tools(tools)
    headers = {
        "x-api-key": conn.api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    response = _post(conn, "/v1/messages", body, headers)
    with response:
        _check(response)
        block: dict | None = None
        partial = ""
        for event in _sse_lines(response):
            kind = event.get("type")
            if kind == "content_block_start":
                block = event.get("content_block") or {}
                partial = ""
            elif kind == "content_block_delta":
                delta = event.get("delta") or {}
                if delta.get("type") == "text_delta":
                    yield Event("text", text=delta.get("text", ""))
                elif delta.get("type") == "input_json_delta":
                    partial += delta.get("partial_json", "")
            elif kind == "content_block_stop" and block and block.get("type") == "tool_use":
                try:
                    arguments = json.loads(partial) if partial.strip() else {}
                except ValueError:
                    arguments = {}
                yield Event("tool", tool_id=block.get("id", ""),
                            tool_name=block.get("name", ""), tool_input=arguments)
                block = None
            elif kind == "message_delta":
                usage = event.get("usage") or {}
                yield Event("usage", tokens_out=int(usage.get("output_tokens") or 0))
            elif kind == "message_start":
                usage = (event.get("message") or {}).get("usage") or {}
                yield Event("usage", tokens_in=int(usage.get("input_tokens") or 0))
            elif kind == "error":
                raise ProviderError(str((event.get("error") or {}).get("message") or event))


# ─── OpenAI-compatible (also the local kind) ────────────────────────────────

def _openai_tools(tools: list[dict]) -> list[dict]:
    return [
        {"type": "function",
         "function": {"name": t["name"], "description": t["description"],
                      "parameters": t["inputSchema"]}}
        for t in tools
    ]


def _stream_openai(conn: Connection, system: str, messages: list[dict],
                   tools: list[dict]) -> Iterator[Event]:
    body = {
        "model": conn.model,
        "messages": [{"role": "system", "content": system}, *messages],
        "stream": True,
        "max_tokens": MAX_TOKENS,
    }
    if tools:
        body["tools"] = _openai_tools(tools)
    headers = {"content-type": "application/json"}
    if conn.api_key:
        headers["authorization"] = f"Bearer {conn.api_key}"
    response = _post(conn, "/v1/chat/completions", body, headers)
    with response:
        _check(response)
        # Tool calls arrive in fragments keyed by index.
        calls: dict[int, dict] = {}
        for event in _sse_lines(response):
            if event.get("error"):
                raise ProviderError(str(event["error"].get("message") or event["error"]))
            for choice in event.get("choices") or []:
                delta = choice.get("delta") or {}
                if delta.get("content"):
                    yield Event("text", text=delta["content"])
                for fragment in delta.get("tool_calls") or []:
                    slot = calls.setdefault(
                        fragment.get("index", 0), {"id": "", "name": "", "args": ""}
                    )
                    if fragment.get("id"):
                        slot["id"] = fragment["id"]
                    fn = fragment.get("function") or {}
                    if fn.get("name"):
                        slot["name"] = fn["name"]
                    if fn.get("arguments"):
                        slot["args"] += fn["arguments"]
                if choice.get("finish_reason") == "tool_calls":
                    for slot in calls.values():
                        try:
                            arguments = json.loads(slot["args"]) if slot["args"].strip() else {}
                        except ValueError:
                            arguments = {}
                        yield Event("tool", tool_id=slot["id"], tool_name=slot["name"],
                                    tool_input=arguments)
                    calls = {}
            usage = event.get("usage") or {}
            if usage:
                yield Event("usage", tokens_in=int(usage.get("prompt_tokens") or 0),
                            tokens_out=int(usage.get("completion_tokens") or 0))


def stream(conn: Connection, system: str, messages: list[dict],
           tools: list[dict]) -> Iterator[Event]:
    """Ask the model, yielding events as they arrive."""
    if conn.provider == "anthropic":
        yield from _stream_anthropic(conn, system, messages, tools)
    else:
        yield from _stream_openai(conn, system, messages, tools)


def probe(conn: Connection) -> dict:
    """A cheap round trip, for the Test button on the settings page."""
    events = stream(conn, "Reply with the single word: ready.",
                    [{"role": "user", "content": "ready?"}], [])
    text = "".join(e.text for e in events if e.kind == "text")
    return {"ok": True, "model": conn.model, "reply": text.strip()[:120]}
