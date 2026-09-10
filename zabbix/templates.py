"""What a provisioned host should carry beyond its name and address.

Phase 2 gave Zabbix Danbyte's inventory. That produced correct hosts that
monitored **nothing**: a Zabbix host with no template has no items, and a host
with an SNMP template but no SNMP interface has items that cannot run. This
closes both, from facts Danbyte already holds.

Three things get resolved here:

* **Templates** - from :class:`~zabbix.models.ZabbixTemplateRule`. Every rule
  that matches the device contributes, so the mapping reads as a set of small
  statements rather than one list per model.
* **An SNMP interface** - built when the device resolves to an SNMP profile,
  because that resolution is Danbyte already saying "this is how you talk to
  it". Its community and passphrases are written as **macro references**, the
  Zabbix convention: the interface names ``{$SNMP_COMMUNITY}``, never a secret.
* **The macros those references point at** - only when the connection's
  credential switch is on, and only on a host Danbyte is creating.
"""
from __future__ import annotations

from .models import ZabbixTemplateRule

#: Zabbix interface types.
IFACE_AGENT = 1
IFACE_SNMP = 2
DEFAULT_SNMP_PORT = "161"

#: Danbyte's SNMP version -> Zabbix's ``details.version``.
_SNMP_VERSION = {"v1": 1, "v2c": 2, "v3": 3}

#: Danbyte's protocol names -> Zabbix's numeric enums. Zabbix numbers them in
#: the order it added them; anything Danbyte can name that Zabbix cannot is
#: left at its default rather than guessed at.
_AUTH_PROTO = {"md5": 0, "sha": 1, "sha1": 1, "sha224": 2, "sha256": 3,
               "sha384": 4, "sha512": 5}
_PRIV_PROTO = {"des": 0, "aes": 1, "aes128": 1, "aes192": 2, "aes256": 3}

#: The macros the interface refers to. Names follow Zabbix's own official
#: templates, so a stock "… by SNMP" template works with no edits.
MACRO_COMMUNITY = "{$SNMP_COMMUNITY}"
MACRO_AUTH = "{$SNMP_AUTH_PASSPHRASE}"
MACRO_PRIV = "{$SNMP_PRIV_PASSPHRASE}"
#: Zabbix macro type 1 is "secret text" - stored encrypted and never readable
#: back through the API, which is the only acceptable way to hand a community
#: string to another system.
MACRO_SECRET = 1


def _scope_object(device, scope):
    """The id on ``device`` a rule of this scope matches against."""
    if scope == ZabbixTemplateRule.SCOPE_ROLE:
        return device.role_id
    if scope == ZabbixTemplateRule.SCOPE_PLATFORM:
        return device.platform_id
    if scope == ZabbixTemplateRule.SCOPE_TYPE:
        return device.device_type_id
    if scope == ZabbixTemplateRule.SCOPE_MANUFACTURER:
        return getattr(device.device_type, "manufacturer_id", None)
    return None


def rules_for(conn) -> list:
    """This connection's enabled rules, read once per pass."""
    return list(
        ZabbixTemplateRule.objects.filter(connection=conn, enabled=True)
    )


def templates_for(device, rules) -> list[str]:
    """The template names this device should carry, in a stable order.

    Rules stack and duplicates collapse, so a device matching three rules gets
    the union of the three - which is what a Zabbix host actually models.
    """
    out: list[str] = []
    for rule in rules:
        if rule.scope == ZabbixTemplateRule.SCOPE_TENANT:
            match = True
        else:
            wanted = _scope_object(device, rule.scope)
            match = wanted is not None and str(wanted) == str(rule.object_id)
        if not match:
            continue
        for name in rule.templates or []:
            name = (name or "").strip()
            if name and name not in out:
                out.append(name)
    return out


def snmp_interface(device, profile, address: str) -> dict | None:
    """A Zabbix SNMP interface for ``device``, or None without a profile.

    The credentials appear as macro references, never as values: that is how
    Zabbix's own templates are built, it keeps the secret in one place, and it
    means an interface Danbyte writes is readable by anyone without leaking
    anything.
    """
    if profile is None:
        return None
    params = profile.params or {}
    version = _SNMP_VERSION.get(profile.version, 2)
    details: dict = {"version": version, "bulk": 1}
    if version == 3:
        secret = profile.secret_params or {}
        # noAuthNoPriv / authNoPriv / authPriv, decided by what the profile
        # actually carries rather than by a field nobody remembers to set.
        has_auth = bool(secret.get("auth_key"))
        has_priv = bool(secret.get("priv_key"))
        details.update({
            "securityname": params.get("username", ""),
            "securitylevel": 2 if (has_auth and has_priv) else (1 if has_auth else 0),
            "contextname": params.get("context", ""),
        })
        if has_auth:
            details["authprotocol"] = _AUTH_PROTO.get(
                str(params.get("auth_proto", "sha")).lower(), 1
            )
            details["authpassphrase"] = MACRO_AUTH
        if has_priv:
            details["privprotocol"] = _PRIV_PROTO.get(
                str(params.get("priv_proto", "aes")).lower(), 1
            )
            details["privpassphrase"] = MACRO_PRIV
    else:
        details["community"] = MACRO_COMMUNITY
    return {
        "type": IFACE_SNMP,
        "main": 1,
        "useip": 1 if address else 0,
        "ip": address,
        "dns": "" if address else device.name,
        "port": str(params.get("port") or DEFAULT_SNMP_PORT),
        "details": details,
    }


def snmp_macros(profile) -> list[dict]:
    """The secret macros an SNMP interface's references point at.

    Only what the profile actually has: writing an empty ``{$SNMP_COMMUNITY}``
    would be worse than writing none, because the host would look configured
    and still not poll.
    """
    if profile is None:
        return []
    secret = profile.secret_params or {}
    out = []
    if profile.version in ("v1", "v2c"):
        community = secret.get("community")
        if community:
            out.append({"macro": MACRO_COMMUNITY, "value": community,
                        "type": MACRO_SECRET})
        return out
    if secret.get("auth_key"):
        out.append({"macro": MACRO_AUTH, "value": secret["auth_key"],
                    "type": MACRO_SECRET})
    if secret.get("priv_key"):
        out.append({"macro": MACRO_PRIV, "value": secret["priv_key"],
                    "type": MACRO_SECRET})
    return out


def profile_for(device, tenant):
    """The device's effective SNMP profile, or None.

    Uses monitoring's own resolver, so what Danbyte would poll the device with
    is exactly what it tells Zabbix to poll it with - two hierarchies that
    could disagree would be worse than none.
    """
    from monitoring.snmp_resolve import resolve_device_profile

    profile, _source = resolve_device_profile(device, tenant)
    return profile
