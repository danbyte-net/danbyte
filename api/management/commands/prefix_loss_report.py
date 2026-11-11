"""Which prefixes and IP addresses a backup has that this database lacks (#501).

0.19.0 and 0.19.1 shipped a migration (api 0265) that deleted every prefix
whose cidr Postgres could not read as an address, and with each one every IP
address in it. Their upgrade logged ``deleted N prefix(es) whose cidr is not
an address``. This compares a backup from before that upgrade - normally the
pre-upgrade backup the upgrade took - with the live database and lists what
is gone. It reads the backup's dump with ``pg_restore`` (no database is
created or restored) and changes nothing here.

    manage.py prefix_loss_report --backup <backup id or .dbk file>
    manage.py prefix_loss_report --dump <pg_dump -Fc file>
    ... [--all] [--json FILE]
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile

from django.core.management.base import BaseCommand, CommandError
from django.db import connection

_IS_INET = """
CREATE OR REPLACE FUNCTION pg_temp.danbyte_is_inet(t text) RETURNS boolean AS $$
BEGIN
    PERFORM t::inet;
    RETURN true;
EXCEPTION WHEN others THEN
    RETURN false;
END
$$ LANGUAGE plpgsql
"""

_ESCAPES = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", "\\": "\\"}


def _unescape(field: str):
    """One field of COPY's text format; ``None`` for ``\\N``."""
    if field == "\\N":
        return None
    if "\\" not in field:
        return field
    out, i = [], 0
    while i < len(field):
        c = field[i]
        if c != "\\" or i + 1 == len(field):
            out.append(c)
            i += 1
            continue
        nxt = field[i + 1]
        if nxt in _ESCAPES:
            out.append(_ESCAPES[nxt])
            i += 2
        elif nxt == "x":
            j = i + 2
            while j < len(field) and j < i + 4 and field[j] in "0123456789abcdefABCDEF":
                j += 1
            out.append(chr(int(field[i + 2:j], 16)) if j > i + 2 else "x")
            i = j
        elif nxt in "01234567":
            j = i + 1
            while j < len(field) and j < i + 4 and field[j] in "01234567":
                j += 1
            out.append(chr(int(field[i + 1:j], 8)))
            i = j
        else:
            out.append(nxt)
            i += 2
    return "".join(out)


def read_tables(dump: str, tables: tuple[str, ...]) -> dict[str, list[dict]]:
    """``{table: [row, ...]}`` from a ``pg_dump -Fc`` file, through
    ``pg_restore --data-only -f -`` (a script on stdout, no database)."""
    if shutil.which("pg_restore") is None:
        raise CommandError("pg_restore is not installed on this host.")
    cmd = ["pg_restore", "--data-only", "-f", "-"]
    for t in tables:
        cmd += ["-t", t]
    res = subprocess.run([*cmd, dump], capture_output=True, text=True, timeout=3600)
    if res.returncode != 0:
        raise CommandError(f"pg_restore could not read {dump}: {res.stderr.strip()[-500:]}")
    out: dict[str, list[dict]] = {t: [] for t in tables}
    table, cols = None, []
    for line in res.stdout.split("\n"):
        if table is None:
            if line.startswith("COPY ") and line.endswith(" FROM stdin;"):
                head = line[5:-len(" FROM stdin;")]
                name, _, collist = head.partition(" (")
                table = name.split(".")[-1].strip('"')
                cols = [c.strip().strip('"') for c in collist.rstrip(")").split(",")]
            continue
        if line == "\\.":
            table = None
            continue
        if table in out:
            fields = [_unescape(f) for f in line.split("\t")]
            out[table].append(dict(zip(cols, fields, strict=True)))
    return out


class Command(BaseCommand):
    help = "List prefixes and IP addresses a backup has that this database lacks."

    def add_arguments(self, parser):
        src = parser.add_mutually_exclusive_group(required=True)
        src.add_argument("--backup", help="A backup id, or the path of a .dbk archive.")
        src.add_argument("--dump", help="A pg_dump -Fc file (an archive's db.dump).")
        parser.add_argument("--all", action="store_true",
                            help="Also list missing prefixes whose cidr was an address.")
        parser.add_argument("--json", metavar="FILE",
                            help="Write every missing row, all its columns, to FILE.")

    def handle(self, *args, **opts):
        with tempfile.TemporaryDirectory() as tmp:
            dump = opts["dump"] or self._extract(opts["backup"], tmp)
            data = read_tables(dump, ("api_prefix", "api_ipaddress"))
        self._report(data, opts)

    def _extract(self, which: str, tmp: str) -> str:
        from backups.archive import ArchiveError, Reader

        dest = os.path.join(tmp, "db.dump")
        if os.path.isfile(which):
            reader = Reader(lambda: open(which, "rb"))
        else:
            from backups.models import Backup
            from backups.restore import _reader

            try:
                backup = Backup.objects.filter(pk=which).first()
            except Exception:  # noqa: BLE001 - not a uuid
                backup = None
            if backup is None:
                raise CommandError(f"{which} is neither a file nor a backup id.")
            reader = _reader(backup)
        try:
            reader.extract("db.dump", dest)
        except ArchiveError as exc:
            raise CommandError(f"cannot read the backup: {exc}") from exc
        return dest

    def _report(self, data, opts) -> None:
        from api.models import IPAddress, Prefix
        from core.models import Tenant

        old_prefixes = {r["id"]: r for r in data["api_prefix"]}
        if not old_prefixes:
            raise CommandError("The backup holds no prefixes - is it a Danbyte database?")
        here = {str(pk) for pk in Prefix.objects.filter(pk__in=list(old_prefixes))
                .values_list("pk", flat=True)}
        missing = [r for pk, r in old_prefixes.items() if pk not in here]
        with connection.cursor() as cur:
            cur.execute(_IS_INET)
            cur.execute("SELECT v, pg_temp.danbyte_is_inet(v) FROM unnest(%s::text[]) AS v",
                        [[r["cidr"] or "" for r in missing]])
            is_inet = dict(cur.fetchall())
        bad = [r for r in missing if not is_inet.get(r["cidr"] or "", False)]
        shown = missing if opts["all"] else bad

        ips_of: dict[str, list[dict]] = {}
        for r in data["api_ipaddress"]:
            ips_of.setdefault(r.get("prefix_id"), []).append(r)
        lost_ips = [ip for p in missing for ip in ips_of.get(p["id"], [])]
        ip_here = {str(pk) for pk in IPAddress.objects.filter(
            pk__in=[ip["id"] for ip in lost_ips]).values_list("pk", flat=True)}
        names = {str(k): v for k, v in Tenant.objects.values_list("pk", "name")}

        for p in sorted(shown, key=lambda r: (names.get(r["tenant_id"], ""), r["cidr"] or "")):
            gone = [ip for ip in ips_of.get(p["id"], []) if ip["id"] not in ip_here]
            kind = "not an address" if p in bad else "an address"
            self.stdout.write(
                f"prefix {p['id']} {p['cidr']!r} ({kind}; tenant "
                f"{names.get(p['tenant_id'], p['tenant_id'])!r}, VRF {p.get('vrf_id') or 'Global'}"
                f"): missing, with {len(gone)} of its {len(ips_of.get(p['id'], []))} "
                "IP address(es)"
            )
            for ip in gone:
                extra = " ".join(x for x in (ip.get("dns_name"), ip.get("description")) if x)
                self.stdout.write(f"    {ip['ip_address']} {ip['id']} {extra}".rstrip())
        lost_ip_count = sum(1 for ip in lost_ips if ip["id"] not in ip_here)
        self.stdout.write(
            f"{len(bad)} prefix(es) whose cidr is not an address are in the backup and not "
            f"here (what api.0265 in 0.19.0/0.19.1 deleted); {len(missing) - len(bad)} other "
            f"missing prefix(es){'' if opts['all'] else ' (--all lists them)'}; "
            f"{lost_ip_count} IP address(es) of missing prefixes are gone."
        )
        if opts["json"]:
            with open(opts["json"], "w") as fh:
                json.dump({
                    "prefixes": shown,
                    "ip_addresses": [ip for p in shown for ip in ips_of.get(p["id"], [])
                                     if ip["id"] not in ip_here],
                }, fh, indent=1)
            self.stdout.write(f"wrote {opts['json']}")
