"""SNMP checker (pysnmp async).

``up`` when the agent answers a GET for ``oid`` (default ``sysUpTimeInstance``);
``degraded`` when it answers but the value fails an optional comparison
(``expected_value`` + ``comparator``); ``down`` when there's no response;
``unknown`` on a config/engine error.

Credentials live in ``secret_params`` (encrypted): v2c uses ``community``; v3
uses ``username`` + ``auth_key`` / ``priv_key`` with ``auth_proto`` /
``priv_proto`` names.
"""
from __future__ import annotations

from .base import CheckConfigError, CheckOutcome, register, require_port

_DEFAULT_OID = "1.3.6.1.2.1.1.3.0"  # sysUpTimeInstance

_AUTH_PROTOS = {
    "md5": "usmHMACMD5AuthProtocol",
    "sha": "usmHMACSHAAuthProtocol",
    "sha224": "usmHMAC128SHA224AuthProtocol",
    "sha256": "usmHMAC192SHA256AuthProtocol",
    "sha384": "usmHMAC256SHA384AuthProtocol",
    "sha512": "usmHMAC384SHA512AuthProtocol",
}
_PRIV_PROTOS = {
    "des": "usmDESPrivProtocol",
    "aes": "usmAesCfb128Protocol",
    "aes128": "usmAesCfb128Protocol",
    "aes192": "usmAesCfb192Protocol",
    "aes256": "usmAesCfb256Protocol",
}


def _compare(value: float, comparator: str, expected: float) -> bool:
    return {
        "eq": value == expected,
        "ne": value != expected,
        "gt": value > expected,
        "lt": value < expected,
        "ge": value >= expected,
        "le": value <= expected,
    }.get(comparator, value == expected)


@register
class SnmpChecker:
    kind = "snmp"

    def validate_params(self, params: dict) -> None:
        version = params.get("version", "v2c")
        if version not in ("v1", "v2c", "v3"):
            raise CheckConfigError("'version' must be v1, v2c or v3")
        if "port" in params and params["port"] is not None:
            require_port(params)
        comp = params.get("comparator")
        if comp is not None and comp not in ("eq", "ne", "gt", "lt", "ge", "le"):
            raise CheckConfigError("'comparator' must be one of eq/ne/gt/lt/ge/le")

    def _auth_data(self, version, params, secret_params, mod):
        if version == "v3":
            user = secret_params.get("username") or params.get("username")
            kwargs = {}
            if secret_params.get("auth_key"):
                kwargs["authKey"] = secret_params["auth_key"]
                kwargs["authProtocol"] = getattr(
                    mod, _AUTH_PROTOS.get(params.get("auth_proto", "sha"), "usmHMACSHAAuthProtocol")
                )
            if secret_params.get("priv_key"):
                kwargs["privKey"] = secret_params["priv_key"]
                kwargs["privProtocol"] = getattr(
                    mod, _PRIV_PROTOS.get(params.get("priv_proto", "aes"), "usmAesCfb128Protocol")
                )
            return mod.UsmUserData(user, **kwargs)
        community = secret_params.get("community") or params.get("community", "public")
        mp_model = 0 if version == "v1" else 1
        return mod.CommunityData(community, mpModel=mp_model)

    async def run(
        self, target: str, params: dict, secret_params: dict, timeout_ms: int
    ) -> CheckOutcome:
        try:
            import pysnmp.hlapi.v3arch.asyncio as mod
        except Exception as e:  # noqa: BLE001
            return CheckOutcome.unknown(f"pysnmp unavailable: {e}")

        version = params.get("version", "v2c")
        port = int(params.get("port", 161))
        oid = params.get("oid", _DEFAULT_OID)
        timeout_s = max(timeout_ms / 1000, 0.2)

        try:
            auth = self._auth_data(version, params, secret_params, mod)
            transport = await mod.UdpTransportTarget.create(
                (target, port), timeout=timeout_s, retries=0
            )
            error_indication, error_status, _, var_binds = await mod.get_cmd(
                mod.SnmpEngine(),
                auth,
                transport,
                mod.ContextData(),
                mod.ObjectType(mod.ObjectIdentity(oid)),
            )
        except Exception as e:  # noqa: BLE001 — engine/config issue, not an outage
            return CheckOutcome.unknown(f"snmp error: {e}")

        if error_indication:
            # No response / timeout → the agent is unreachable.
            return CheckOutcome("down", None, {"oid": oid, "error": str(error_indication)})
        if error_status:
            return CheckOutcome.unknown(f"snmp pdu error: {error_status.prettyPrint()}")

        name, value = var_binds[0]
        detail = {"oid": str(name), "value": value.prettyPrint()}

        expected = params.get("expected_value")
        if expected is not None:
            comparator = params.get("comparator", "eq")
            try:
                ok = _compare(float(value), comparator, float(expected))
            except (ValueError, TypeError):
                ok = str(value.prettyPrint()) == str(expected)
            if not ok:
                detail["expected"] = expected
                detail["comparator"] = comparator
                return CheckOutcome("degraded", None, detail)
        return CheckOutcome("up", None, detail)
