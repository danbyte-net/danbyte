"""The Zabbix engine driver (#162).

It answers ``zabbix``-kind checks in **bulk**: two API calls settle a thousand
targets, because Zabbix's frontend API is single-threaded per node and a call
per host would be both slow and rude.

The answer goes back through ``ingest_results`` - the same door a Danbyte
Outpost reports through - so hysteresis, history, alert rules, silences,
flapping, escalation and every notification channel behave identically whether
Danbyte watched the host or Zabbix did.
"""
from __future__ import annotations

from datetime import timedelta

from django.utils import timezone

from danbyte_checks.base import CheckOutcome
from integrations.toggles import integration_enabled

from .checker import KIND
from .client import ZabbixClient, ZabbixError, ZabbixUnreachable
from .interfaces import availability
from .models import ZabbixConnection
from .severity import clean_map, worst

#: One claim pass. Big enough that a real estate settles in a couple of
#: batches, small enough that a stalled API cannot hold every state in flight.
CLAIM_BATCH = 500


def _connection(engine):
    """The connection an engine reads through, or None.

    An explicit link. It used to be a name match with "any enabled connection"
    as the fallback, which meant a renamed engine - or a second Zabbix server -
    read the wrong estate's hosts and reported them as this one's, silently.
    An engine linked to nothing is not usable, and saying so is better than
    guessing which server somebody meant.
    """
    return (
        ZabbixConnection.objects.filter(engines=engine, enabled=True)
        .order_by("name")
        .first()
    )


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

    def claim(self, engine, now) -> int:
        """Answer this engine's due Zabbix checks, and say how many.

        Claims first (so a second tick cannot double-answer), then asks Zabbix
        once for the hosts and once for their problems. A state whose target
        Zabbix has never heard of comes back ``unknown``, never ``down``: not
        being monitored is not the same as being off, and conflating them is
        how a monitoring system loses trust.
        """
        from monitoring.models import CheckState
        from monitoring.worker import effective_interval, ingest_results

        conn = _connection(engine)
        if conn is None:
            return 0

        due = list(
            CheckState.objects.filter(
                engine=engine, kind=KIND, next_run__lte=now, in_flight=False
            ).select_related("target_ip", "template", "assignment")[:CLAIM_BATCH]
        )
        if not due:
            return 0

        for s in due:
            s.in_flight = True
            s.in_flight_since = now
            s.next_run = now + timedelta(seconds=effective_interval(s) or 300)
        CheckState.objects.bulk_update(
            due, ["in_flight", "in_flight_since", "next_run"], batch_size=2000
        )

        outcomes = self._answer(conn, [s.target_ip.ip_address for s in due])
        return ingest_results(
            {str(s.id): outcomes[s.target_ip.ip_address] for s in due},
            engine_id=engine.id,
            tenant_id=engine.tenant_id,
        )

    def _answer(self, conn, addresses) -> dict:
        """address -> CheckOutcome, from two calls.

        A failure here answers every address ``unknown`` rather than raising:
        the states are already claimed, and leaving them claimed would strand
        them until the reaper notices. Unknown is the honest word for "Zabbix
        did not tell us".
        """
        client = ZabbixClient(
            conn.api_url, (conn.credentials or {}).get("token", ""),
            verify_tls=conn.verify_tls,
        )
        wanted = {a.split("/")[0] for a in addresses}
        try:
            hosts = client.hosts_by_ip(wanted)
            ids = [h["hostid"] for rows in hosts.values() for h in rows]
            problems = client.problems_by_host(ids)
        except ZabbixError as exc:
            return {
                a: CheckOutcome.unknown(f"Zabbix: {exc}") for a in addresses
            }

        mapping = clean_map(conn.severity_map)
        out = {}
        for addr in addresses:
            outcome = self._for_host(
                hosts.get(addr.split("/")[0]) or [], problems, mapping
            )
            # The frontend URL, so a hover can open the host in Zabbix. The
            # outcome already names the host; this is what makes it a link.
            if outcome.detail.get("hostid"):
                outcome.detail["zabbix_url"] = conn.url
            out[addr] = outcome
        return out

    @staticmethod
    def _for_host(rows, problems, mapping) -> CheckOutcome:
        if not rows:
            return CheckOutcome.unknown("No Zabbix host has this address.")
        if len(rows) > 1:
            # Two hosts on one address is the operator's ambiguity to settle;
            # picking one would hide it behind a plausible-looking answer.
            names = ", ".join(sorted(r["name"] for r in rows)[:4])
            return CheckOutcome.unknown(
                f"Several Zabbix hosts share this address ({names}).")
        host = rows[0]
        detail = {"zabbix_host": host["name"], "hostid": host["hostid"]}

        # Zabbix's own switches come first - a host an operator disabled or put
        # in maintenance is deliberately quiet, and reporting it down would be
        # Danbyte arguing with a decision somebody already made.
        if str(host.get("status")) == "1":
            return CheckOutcome("unknown", None, {**detail, "state": "disabled in Zabbix"})
        if str(host.get("maintenance_status")) == "1":
            return CheckOutcome("unknown", None, {**detail, "state": "in maintenance"})

        # What Zabbix can and cannot reach the host on. Free - it rides the
        # host read the status came from - and it is the fastest answer to
        # "why is this host green in Danbyte and useless in Zabbix": an SNMP
        # interface with no community polls nothing and says so here.
        reach = availability(host)
        if reach:
            detail["availability"] = reach

        open_problems = problems.get(host["hostid"]) or []
        status = worst((p.get("severity") for p in open_problems), mapping)
        if open_problems:
            detail["problems"] = [
                {
                    "name": p.get("name"),
                    "severity": p.get("severity"),
                    "eventid": p.get("eventid"),
                }
                for p in open_problems[:10]
            ]
            detail["problem_count"] = len(open_problems)
        return CheckOutcome(status, None, detail)

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
