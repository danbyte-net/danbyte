"""The Zabbix JSON-RPC API, as three POSTs and a token.

No SDK. The whole API is one endpoint that takes ``{jsonrpc, method, params,
id}``, and adding a dependency to an airgapped installer to send that would buy
nothing - the same call made for the assistant's model providers and for Azure
Key Vault, both of which ship as plain ``requests``.

Outbound goes through :func:`core.ssrf.safe_post`, so a tenant-configured URL is
never a way to reach an internal service. A Zabbix on RFC1918 - which is most of
them - is reached by a deployment admin allow-listing it under Settings →
Security → Outbound connections. That is deliberate: unlike Vault and the local
model provider, this URL is set by a *tenant* admin, so it does not get their
bypass.
"""
from __future__ import annotations

import json

from core.ssrf import safe_post


class ZabbixError(RuntimeError):
    """The server answered, and the answer was no."""


class ZabbixUnreachable(ZabbixError):
    """The server did not answer at all."""


class ZabbixClient:
    def __init__(self, url: str, token: str = "", *, verify_tls=True, timeout=20):
        self.url = url
        self.token = token
        self.verify_tls = verify_tls
        self.timeout = timeout
        self._id = 0

    def call(self, method: str, params=None, *, authenticated=True):
        self._id += 1
        headers = {"Content-Type": "application/json-rpc"}
        # apiinfo.version is the one method that must NOT carry auth - Zabbix
        # rejects the call outright if it does, which makes it the right probe
        # for "is this a Zabbix, and which one" before any token exists.
        if authenticated and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "method": method,
                "params": params if params is not None else {},
                "id": self._id,
            }
        )
        try:
            resp = safe_post(
                self.url,
                headers=headers,
                data=body,
                timeout=self.timeout,
                verify=self.verify_tls,
            )
        except Exception as exc:
            raise ZabbixUnreachable(str(exc)) from exc

        if resp.status_code != 200:
            raise ZabbixError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        try:
            payload = resp.json()
        except ValueError as exc:
            # Almost always the frontend URL pointing at the login page rather
            # than the API - worth saying so instead of "invalid JSON".
            raise ZabbixError(
                "The URL did not return a JSON-RPC response - check it points "
                "at the Zabbix frontend."
            ) from exc

        if "error" in payload:
            err = payload["error"]
            raise ZabbixError(err.get("data") or err.get("message") or str(err))
        return payload.get("result")

    def version(self) -> str:
        return self.call("apiinfo.version", authenticated=False)

    def hosts_by_ip(self, ips):
        """Zabbix hosts that answer on any of ``ips``, keyed by address.

        One call for the whole batch - a thousand targets must not be a
        thousand round trips, and Zabbix's frontend API is single-threaded per
        node. ``maintenance_status`` comes back too: a host inside a Zabbix
        maintenance window is deliberately quiet, not down.
        """
        if not ips:
            return {}
        rows = self.call("host.get", {
            "output": ["hostid", "host", "name", "status", "maintenance_status"],
            # `available` and `error` are how Zabbix says whether it can reach
            # the host at all on each protocol, and why not when it cannot.
            "selectInterfaces": ["type", "ip", "dns", "useip", "available", "error"],
            "filter": {"ip": list(ips)},
        }) or []
        out = {}
        for row in rows:
            # Per host, not per interface. A host with an agent *and* an SNMP
            # interface on one address is one host - counting interfaces made
            # it look like two, and the caller reported an ambiguity that was
            # not there. Provisioning an SNMP interface used to break the check
            # for the very host it had just fixed.
            for addr in {
                iface.get("ip") for iface in (row.get("interfaces") or [])
            }:
                if addr and addr in ips:
                    out.setdefault(addr, []).append(row)
        return out

    def problems_by_host(self, hostids):
        """Unresolved, unsuppressed problems for ``hostids``, by host id.

        Two calls, because ``problem.get`` does not carry the host: a problem
        names the *trigger* that raised it (``objectid``), and the trigger is
        what belongs to a host. ``trigger.get`` resolves the whole batch at
        once, so this stays two round trips whether it is ten hosts or ten
        thousand.

        ``suppressed=False`` is what makes a Zabbix maintenance window mean
        something here: somebody who silenced a host in Zabbix should not then
        be paged by Danbyte for the same host.
        """
        if not hostids:
            return {}
        problems = self.call("problem.get", {
            "output": ["eventid", "objectid", "severity", "name", "clock"],
            "hostids": list(hostids),
            "recent": False,
            "suppressed": False,
        }) or []
        if not problems:
            return {}

        trigger_ids = sorted({p["objectid"] for p in problems if p.get("objectid")})
        host_by_trigger = {}
        if trigger_ids:
            for trg in self.call("trigger.get", {
                "output": ["triggerid"],
                "triggerids": trigger_ids,
                "selectHosts": ["hostid"],
            }) or []:
                host_by_trigger[trg["triggerid"]] = [
                    h["hostid"] for h in trg.get("hosts") or []
                ]

        out = {}
        for problem in problems:
            for hostid in host_by_trigger.get(problem.get("objectid"), []):
                out.setdefault(hostid, []).append(problem)
        return out

    def all_hosts(self):
        """Every host, with what matching needs: interfaces, inventory, name.

        One call. A host list is small next to its history, and matching a
        thousand devices against a paged fetch would be far worse than one
        read of the lot.
        """
        return self.call("host.get", {
            # proxyid is 7.0's name; 6.x answers with proxy_hostid. Both are
            # asked for, and the one the server knows comes back.
            "output": ["hostid", "host", "name", "status", "proxyid", "proxy_hostid",
                       "monitored_by"],
            "selectInterfaces": ["interfaceid", "type", "ip", "dns", "useip", "port"],
            # Serial for matching; model, vendor and OS so an adopted host
            # can say what it is rather than arriving as a blank device.
            "selectInventory": ["serialno_a", "model", "vendor", "os", "type"],
            # Linked templates and groups come along on the same read: planning
            # has to know what a host already carries, and asking per host
            # would turn one call into a thousand. Without the groups here,
            # every pass proposed the same groups again and apply found nothing
            # to do - noise on every sync, forever.
            "selectParentTemplates": ["templateid", "host"],
            "selectHostGroups": ["groupid", "name"],
        }) or []

    def group_ids(self, names) -> list:
        """Ids for several groups, creating the ones that do not exist.

        One read for the lot, then a create per missing name - a host usually
        wants two or three groups and Zabbix has no bulk create for them.
        """
        names = [n for n in names if n]
        if not names:
            return []
        found = self.call("hostgroup.get", {
            "output": ["groupid", "name"], "filter": {"name": names},
        }) or []
        have = {g["name"]: g["groupid"] for g in found}
        out = []
        for name in names:
            gid = have.get(name)
            if gid is None:
                gid = self.call("hostgroup.create", {"name": name})["groupids"][0]
            out.append(gid)
        return out

    def host_groups(self, hostid: str) -> set:
        """Group names a host is already in, so Danbyte only ever adds."""
        found = self.call("host.get", {
            "output": ["hostid"], "hostids": hostid,
            "selectHostGroups": ["groupid", "name"],
        }) or []
        if not found:
            return set()
        rows = found[0].get("hostgroups") or found[0].get("groups") or []
        return {g["name"] for g in rows}

    def add_groups(self, hostid: str, group_ids) -> None:
        """Put a host in more groups without removing the ones it has.

        ``host.massadd``, not ``host.update``: update replaces the group set,
        and a host has to be in at least one, so a bad update could orphan it.
        """
        ids = [{"groupid": g} for g in group_ids]
        if ids:
            self.call("host.massadd", {"hosts": [{"hostid": hostid}],
                                       "groups": ids})

    def group_id(self, name: str) -> str:
        """The id of a host group, created if this is the first host in it.

        Zabbix will not accept a host without a group, so this is not optional
        - and creating one named after the site is better than dumping every
        Danbyte host into one bucket nobody can filter.
        """
        found = self.call("hostgroup.get", {
            "output": ["groupid"], "filter": {"name": [name]},
        }) or []
        if found:
            return found[0]["groupid"]
        return self.call("hostgroup.create", {"name": name})["groupids"][0]

    def template_ids(self, names) -> dict:
        """``{name: templateid}`` for the templates that exist.

        A name Zabbix does not have is simply absent from the answer. The
        caller reports it - inventing a template, or silently dropping the
        host's only one, are both worse than saying so.
        """
        names = [n for n in names if n]
        if not names:
            return {}
        found = self.call("template.get", {
            "output": ["templateid", "host"], "filter": {"host": names},
        }) or []
        return {t["host"]: t["templateid"] for t in found}

    def all_templates(self) -> list:
        """Every template on the server, for the rule form to pick from.

        ``host`` is the technical name templates are linked by and the one a
        rule stores; ``name`` is what Zabbix shows. Usually identical, but the
        form displays the visible one and saves the technical one, so a rule
        keeps working if somebody renames the display name.
        """
        found = self.call("template.get", {
            "output": ["templateid", "host", "name"],
        }) or []
        rows = [
            {"value": t["host"], "label": t.get("name") or t["host"]}
            for t in found
        ]
        return sorted(rows, key=lambda r: r["label"].lower())

    def host_templates(self, hostid: str) -> set:
        """Template names already linked to a host, so Danbyte only ever adds."""
        found = self.call("host.get", {
            "output": ["hostid"], "hostids": hostid,
            "selectParentTemplates": ["templateid", "host"],
        }) or []
        if not found:
            return set()
        return {t["host"] for t in found[0].get("parentTemplates") or []}

    def link_templates(self, hostid: str, template_ids) -> None:
        """Link templates to an existing host, **additively**.

        ``host.massadd`` rather than ``host.update``: update replaces the
        linked set, so one pass would silently unlink every template somebody
        attached by hand. Danbyte adds what it knows and removes nothing.
        """
        ids = [{"templateid": t} for t in template_ids]
        if ids:
            self.call("host.massadd", {"hosts": [{"hostid": hostid}],
                                       "templates": ids})

    def host_interfaces(self, hostid: str) -> list:
        found = self.call("host.get", {
            "output": ["hostid"], "hostids": hostid,
            "selectInterfaces": ["interfaceid", "type", "ip", "dns", "useip", "port"],
        }) or []
        return (found[0].get("interfaces") if found else []) or []

    def create_interface(self, hostid: str, payload: dict) -> str:
        return self.call(
            "hostinterface.create", {"hostid": hostid, **payload}
        )["interfaceids"][0]

    def host_macro_names(self, hostid: str) -> set:
        """Which macros a host already has.

        Names only, deliberately: a secret macro's value never comes back, so
        presence is the only question Danbyte can honestly ask - and the only
        one it should, since a value somebody changed is theirs.
        """
        found = self.call("usermacro.get", {
            "output": ["macro"], "hostids": hostid,
        }) or []
        return {m["macro"] for m in found}

    def add_macros(self, hostid: str, macros) -> None:
        for m in macros:
            self.call("usermacro.create", {"hostid": hostid, **m})

    def update_interface(self, interfaceid: str, payload: dict) -> None:
        """Change an existing interface. ``host.update`` cannot do this - an
        address correction has to go to ``hostinterface.update`` or it is
        accepted and quietly does nothing."""
        self.call("hostinterface.update", {"interfaceid": interfaceid, **payload})

    def all_proxies(self) -> list:
        """Every proxy on the server, for the rule form to pick from."""
        found = self.call("proxy.get", {"output": ["proxyid", "name"]}) or []
        return sorted(
            ({"value": p["name"], "label": p["name"]} for p in found),
            key=lambda r: r["label"].lower(),
        )

    def proxy_id(self, name: str) -> str | None:
        """A proxy's id by name, or None when Zabbix has no such proxy.

        Never created: a proxy is a running process somebody installed, and
        inventing a record for one that does not exist would park the host on
        a proxy that will never poll it.
        """
        if not name:
            return None
        found = self.call("proxy.get", {
            "output": ["proxyid", "name"], "filter": {"name": [name]},
        }) or []
        return found[0]["proxyid"] if found else None

    # ── maintenance periods ─────────────────────────────────────────────
    def maintenances(self, maintenanceids) -> dict:
        """The periods Danbyte wrote that still exist, by id - so one deleted
        by hand in Zabbix is noticed and re-created rather than assumed."""
        ids = [str(i) for i in maintenanceids if i]
        if not ids:
            return {}
        rows = self.call("maintenance.get", {
            "output": ["maintenanceid", "name", "active_since", "active_till"],
            "maintenanceids": ids,
            "selectHosts": ["hostid"],
        }) or []
        return {r["maintenanceid"]: r for r in rows}

    def create_maintenance(self, payload: dict) -> str:
        result = self.call("maintenance.create", payload) or {}
        return str((result.get("maintenanceids") or [""])[0])

    def update_maintenance(self, maintenanceid: str, payload: dict) -> None:
        self.call("maintenance.update", {"maintenanceid": maintenanceid, **payload})

    def delete_maintenances(self, maintenanceids) -> None:
        ids = [str(i) for i in maintenanceids if i]
        if ids:
            self.call("maintenance.delete", ids)

    # ── acknowledgements ────────────────────────────────────────────────
    #: ``event.acknowledge`` action bits. Unacknowledge is 6.0+, which is the
    #: floor, so no branch.
    ACK, MESSAGE, UNACK = 2, 4, 16

    def acknowledge(self, eventids, *, message: str = "", acknowledge=True) -> None:
        ids = [str(i) for i in eventids if i]
        if not ids:
            return
        action = self.ACK if acknowledge else self.UNACK
        params = {"eventids": ids, "action": action}
        if message:
            params["action"] = action | self.MESSAGE
            params["message"] = message[:2048]
        self.call("event.acknowledge", params)

    def create_host(self, payload: dict) -> str:
        return self.call("host.create", payload)["hostids"][0]

    def update_host(self, hostid: str, payload: dict) -> None:
        self.call("host.update", {"hostid": hostid, **payload})

    def delete_hosts(self, hostids) -> None:
        if hostids:
            self.call("host.delete", list(hostids))

    def host_count(self) -> int:
        """How many hosts the token can see.

        Doubles as the auth probe: it is a normal read, so it fails the way
        every later call will fail, and the number is worth telling the
        operator - a token scoped to nothing returns 0 rather than an error,
        which no exception would have revealed.
        """
        return int(self.call("host.get", {"countOutput": True}))
