"""The Zabbix engine driver (#162).

Phase 0 scope: it can say whether it is reachable, what version it is, and
whether it may be handed work. It cannot answer for a check yet - `claim` is
deliberately absent, and the scheduler treats a driver without one as simply
having nothing to do.

That is the honest shape of a first release: an operator can point Danbyte at
their Zabbix, press Test, and bind an engine to a site - and nothing silently
half-works while the answering half is built.
"""
from __future__ import annotations

from django.utils import timezone

from integrations.toggles import integration_enabled

from .client import ZabbixClient, ZabbixError, ZabbixUnreachable
from .models import ZabbixConnection


def _connection(engine):
    """The connection an engine reads through.

    One per tenant today, matched by name when there are several - a multi-site
    Zabbix is one server, so the common case is one row.
    """
    qs = ZabbixConnection.objects.filter(tenant=engine.tenant, enabled=True)
    return qs.filter(name=engine.name).first() or qs.first()


class ZabbixDriver:
    def usable(self, engine) -> bool:
        """Whether this engine may be resolved to and handed work.

        Four things have to hold, and the order matters - the tenant switch is
        checked first so that turning the integration off is instant and does
        not depend on a connection being reachable.
        """
        if not integration_enabled(engine.tenant, "zabbix"):
            return False
        conn = _connection(engine)
        if conn is None or not conn.token_set:
            return False
        # A server below the floor, or one that has never answered, is not
        # something to start sending work to.
        return conn.supported

    def test(self, engine) -> dict:
        """Reach the server and describe it. Never raises."""
        conn = _connection(engine)
        if conn is None:
            return {"ok": False, "detail": "No Zabbix connection for this tenant."}
        return test_connection(conn)


def test_connection(conn: ZabbixConnection) -> dict:
    """Probe one connection and record what it said.

    Version first and unauthenticated, because that answers "is this a Zabbix,
    and can Danbyte speak to it" before the token is in play - so a wrong URL
    and a wrong token give different errors instead of one vague failure.
    """
    client = ZabbixClient(
        conn.api_url, (conn.credentials or {}).get("token", ""),
        verify_tls=conn.verify_tls,
    )
    result = {"ok": False, "detail": "", "version": "", "hosts": None}
    try:
        version = client.version()
        result["version"] = version
        conn.version = version[:32]
        if not conn.supported:
            floor = ".".join(str(p) for p in ZabbixConnection.MIN_VERSION)
            result["detail"] = (
                f"Zabbix {version} is below the supported floor ({floor}). "
                "Danbyte would be guessing at this API."
            )
        elif not conn.token_set:
            result["detail"] = f"Reached Zabbix {version}, but no API token is set."
        else:
            hosts = client.host_count()
            result["ok"] = True
            result["hosts"] = hosts
            result["detail"] = (
                f"Connected to Zabbix {version} - {hosts} host"
                f"{'' if hosts == 1 else 's'} visible to this token."
            )
    except ZabbixUnreachable as exc:
        result["detail"] = f"Could not reach {conn.url}: {exc}"
    except ZabbixError as exc:
        detail = str(exc)
        # Zabbix says "Session terminated, re-login, please" for a token it
        # does not recognise, which reads like a Danbyte bug. Name the real
        # cause and keep its words for anyone searching them.
        if "re-login" in detail or "Not authorized" in detail:
            detail = f"Zabbix rejected the API token ({detail})"
        result["detail"] = detail
    conn.last_checked_at = timezone.now()
    conn.last_error = "" if result["ok"] else result["detail"]
    conn.save(update_fields=["version", "last_checked_at", "last_error"])
    return result
