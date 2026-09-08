"""JSON-RPC 2.0 framing and the MCP handshake.

The Model Context Protocol allows a stateless server over plain HTTP: the
client POSTs a JSON-RPC request and reads a JSON-RPC response, with no
session id and no event stream. That is all every current client needs, so
this is a few hundred lines in one DRF view rather than an async server
and a second process.
"""
from __future__ import annotations

from typing import Any

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "danbyte"

# JSON-RPC error codes: the three standard ones plus the range MCP reserves
# for the server's own refusals.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
RATE_LIMITED = -32001
FORBIDDEN = -32002


def result(request_id: Any, payload: dict) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": payload}


def error(request_id: Any, code: int, message: str, data: dict | None = None) -> dict:
    body: dict[str, Any] = {"code": code, "message": message}
    if data:
        body["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": body}


def is_notification(message: dict) -> bool:
    """A JSON-RPC notification carries no id and expects no answer."""
    return "id" not in message


def server_info(version: str) -> dict:
    return {"name": SERVER_NAME, "title": "Danbyte", "version": version}


def initialize_result(version: str) -> dict:
    """What the client learns on connect. Only the capabilities we serve are
    advertised, so a client never offers a feature that would 404."""
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {"tools": {"listChanged": False}, "resources": {"subscribe": False}},
        "serverInfo": server_info(version),
        "instructions": (
            "Danbyte is the network source of truth: IP space, devices, racks, "
            "interfaces, cabling, circuits, virtual machines, monitoring state, "
            "lifecycle dates and the change log. Start with `types` to see what "
            "this token may read, `search` to find an object, then `get` or "
            "`list`. `explain` describes a type's fields before you write to it. "
            "Results are capped and say so; ask for the next page rather than "
            "assuming you saw everything."
        ),
    }


def text_content(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": False}


def tool_result(payload: dict | list, *, summary: str = "") -> dict:
    """MCP wants human-readable content; assistants parse JSON far better than
    prose, so the block is the JSON itself with an optional one-line lead."""
    import json

    body = json.dumps(payload, indent=2, default=str)
    text = f"{summary}\n{body}" if summary else body
    return {
        "content": [{"type": "text", "text": text}],
        "structuredContent": payload if isinstance(payload, dict) else {"items": payload},
        "isError": False,
    }


def tool_error(message: str) -> dict:
    return {"content": [{"type": "text", "text": message}], "isError": True}
