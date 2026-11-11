# Prefixes saved before CIDR validation (#47), or by an import, can hold a
# cidr Postgres cannot read as inet: "10.0.60.0/24 " (a space), the netmask
# form "10.0.20.0/255.255.255.0", or text that is not an address ("banana").
# The prefix containment index (0262, #484) casts every cidr to inet, so one
# such row would fail the index build. This runs before 0262 (run_before).
#
# It never deletes (#501). 0.19.0 and 0.19.1 shipped a version that deleted
# these rows, and IPAddress.prefix is CASCADE, so every address in them went
# too. The name is kept so installs that ran that version do not run this one.
#
# * A value the prefix API accepts today is rewritten to what the API would
#   store: stripped, netmask to length, canonical text. Host bits set stays
#   refused, as in the API. Each rewrite is logged (old -> new) and written
#   to the prefix's change log.
# * A rewrite that would give a network the tenant already has in that VRF
#   (the API's duplicate rule) is not made: the two rows are not merged.
# * When any row can't be rewritten, the migration stops before it changes
#   anything and lists each row (tenant, id, value, why, what hangs off it)
#   with the command that fixes it: manage.py prefix_cidrs. The upgrade
#   preflights (scripts/upgrade/stage.sh, deploy/docker/entrypoint.sh) run
#   the same survey before any migration.
#
# The rule is frozen here; manage.py prefix_cidrs and the upgrade probe load
# this module so all three agree. Validity is Postgres's own inet parser,
# through a temporary function so it works on PostgreSQL 15 (no
# pg_input_is_valid). Reverse is a no-op: the old text is in the change log.

import ipaddress
import logging

from django.db import migrations

log = logging.getLogger("danbyte.migrations")

#: core.upgrade_notes: the note for installs that ran the deleting version.
#: This version ran here, so nothing was lost; it marks that note done.
NOTE_ID = "0.19.2-prefix-cleanup"

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

FIX_HINT = (
    "Give each one a valid CIDR (or delete it in the running release), then "
    "run the upgrade again:\n"
    "  python manage.py prefix_cidrs                    # list them\n"
    "  python manage.py prefix_cidrs --set <id> <cidr>  # e.g. 10.0.0.0/24\n"
    "On Docker: docker compose run --rm -e MIGRATE_ON_START=0 backend "
    "python manage.py prefix_cidrs --set <id> <cidr>\n"
    "Or in SQL: UPDATE api_prefix SET cidr = '<cidr>' WHERE id = '<id>';"
)


class UnrepairablePrefixes(RuntimeError):
    """Rows this migration will not guess at; nothing has been changed."""


def normalise(raw) -> tuple[str | None, str]:
    """``(cidr, "")`` as the prefix API stores ``raw``, or ``(None, why)``.

    PrefixSerializer.validate_cidr as of 0.19/0.20, frozen: strip, require a
    length, ``ip_network(strict=True)`` (a netmask or hostmask becomes the
    length; host bits set is refused), canonical text."""
    text = (raw or "").strip()
    if "/" not in text:
        return None, "no prefix length"
    try:
        net = ipaddress.ip_network(text, strict=True)
    except ValueError as exc:
        return None, str(exc)
    return str(net), ""


def _table_exists(cur) -> bool:
    cur.execute("SELECT to_regclass('api_prefix') IS NOT NULL")
    return bool(cur.fetchone()[0])


def unparseable_prefix_ids(connection) -> list:
    with connection.cursor() as cur:
        if not _table_exists(cur):
            return []
        cur.execute(_IS_INET)
        cur.execute("SELECT id FROM api_prefix WHERE NOT pg_temp.danbyte_is_inet(cidr)")
        return [row[0] for row in cur.fetchall()]


def survey(connection) -> list[dict]:
    """Every prefix Postgres can't read as inet, and what this migration does
    with it. Raw SQL on columns every release has, so a newer or older
    release's code can run it against this schema. Reads only.

    Each row: ``id, tenant_id, tenant, vrf_id, cidr, ips`` and either
    ``new`` (the rewrite) or ``why`` (it can't be rewritten).
    """
    with connection.cursor() as cur:
        if not _table_exists(cur):
            return []
        cur.execute(_IS_INET)
        cur.execute(
            "SELECT p.id, p.tenant_id, t.name, p.vrf_id, p.cidr,"
            " (SELECT count(*) FROM api_ipaddress i WHERE i.prefix_id = p.id)"
            " FROM api_prefix p LEFT JOIN core_tenant t ON t.id = p.tenant_id"
            " WHERE NOT pg_temp.danbyte_is_inet(p.cidr)"
            " ORDER BY t.name, p.tenant_id, p.vrf_id NULLS FIRST, p.created_at, p.id"
        )
        bad = [
            {"id": r[0], "tenant_id": r[1], "tenant": r[2] or "", "vrf_id": r[3],
             "cidr": r[4], "ips": r[5], "new": None, "why": ""}
            for r in cur.fetchall()
        ]
        if not bad:
            return []
        bad_ids = [b["id"] for b in bad]
        # Networks each (tenant, VRF) already has - the API's duplicate rule
        # (same network, not only the same text), which covers the unique
        # constraint (tenant, vrf, cidr) with nulls_distinct=False.
        taken: dict = {}
        for key in {(b["tenant_id"], b["vrf_id"]) for b in bad}:
            tenant_id, vrf_id = key
            cur.execute(
                "SELECT id, cidr FROM api_prefix WHERE tenant_id = %s"
                " AND vrf_id IS NOT DISTINCT FROM %s AND NOT (id = ANY(%s))",
                [tenant_id, vrf_id, bad_ids],
            )
            nets = taken.setdefault(key, {})
            for pk, cidr in cur.fetchall():
                try:
                    nets.setdefault(ipaddress.ip_network(cidr.strip(), strict=False),
                                    f"{cidr} ({pk})")
                except ValueError:
                    continue
        for b in bad:
            new, why = normalise(b["cidr"])
            if new is not None:
                cur.execute("SELECT pg_temp.danbyte_is_inet(%s)", [new])
                if not cur.fetchone()[0]:
                    new, why = None, f"{new} is not an address Postgres reads"
            if new is not None:
                nets = taken[(b["tenant_id"], b["vrf_id"])]
                net = ipaddress.ip_network(new)
                if net in nets:
                    new, why = None, f"would be {new}, which this VRF already has: {nets[net]}"
                else:
                    nets[net] = f"{b['cidr']!r} ({b['id']}, rewritten to {new})"
            b["new"], b["why"] = new, why
        return bad


def describe(row: dict) -> str:
    vrf = row["vrf_id"] or "Global"
    return (f"prefix {row['id']} cidr {row['cidr']!r} (tenant {row['tenant']!r} "
            f"{row['tenant_id']}, VRF {vrf}, {row['ips']} IP address(es))")


def _dependents(apps, using, pk) -> str:
    """What deleting the prefix would have taken with it, by model - the
    0.19.0/0.19.1 version of this migration did."""
    from django.db.models.deletion import Collector, ProtectedError, RestrictedError

    Prefix = apps.get_model("api", "Prefix")
    collector = Collector(using=using)
    try:
        collector.collect(list(Prefix.objects.filter(pk=pk)))
    except (ProtectedError, RestrictedError):
        return "protected"
    counts: dict[str, int] = {}
    for model, objs in collector.data.items():
        counts[model._meta.label] = counts.get(model._meta.label, 0) + len(objs)
    for qs in collector.fast_deletes:
        n = qs.count()
        if n:
            counts[qs.model._meta.label] = counts.get(qs.model._meta.label, 0) + n
    counts.pop("api.Prefix", None)
    return ", ".join(f"{n} {label}" for label, n in sorted(counts.items())) or "nothing"


def _change_log(apps, row: dict) -> None:
    """The rewrite in the prefix's own change log, as the system."""
    try:
        Entry = apps.get_model("audit", "ChangeLogEntry")
    except LookupError:
        return
    fields = {name for f in Entry._meta.concrete_fields for name in (f.name, f.attname)}
    values = {
        "tenant_id": row["tenant_id"], "user": None, "user_name": "upgrade",
        "action": "update", "object_type": "api.prefix", "object_label": "Prefix",
        "object_id": str(row["id"]), "object_repr": row["new"][:255],
        "changes": {"cidr": {"old": row["cidr"], "new": row["new"]}},
        "via": "system", "cause": "upgrade: migration api.0265 (#501)",
    }
    Entry.objects.create(**{k: v for k, v in values.items() if k in fields})


def _mark_note_done(apps) -> None:
    try:
        Dep = apps.get_model("core", "DeploymentSettings")
    except LookupError:
        return
    dep = Dep.objects.filter(pk=1).first()
    if dep is None:  # a fresh install: its first load marks the note done
        return
    done = list(dep.upgrade_notes_done or [])
    if NOTE_ID not in done:
        Dep.objects.filter(pk=1).update(upgrade_notes_done=[*done, NOTE_ID])


def repair_unparseable(apps, schema_editor):
    _mark_note_done(apps)
    connection = schema_editor.connection
    rows = survey(connection)
    if not rows:
        return
    Prefix = apps.get_model("api", "Prefix")
    using = connection.alias
    stuck = [r for r in rows if r["new"] is None]
    for r in rows:
        deps = _dependents(apps, using, r["id"])
        if r["new"] is not None:
            log.warning("api.0265: %s -> %r (kept with it: %s)", describe(r), r["new"], deps)
        else:
            log.warning("api.0265: cannot repair %s: %s (hanging off it: %s)",
                        describe(r), r["why"], deps)
    if stuck:
        lines = "\n".join(f"  - {describe(r)}: {r['why']}" for r in stuck)
        raise UnrepairablePrefixes(
            f"{len(stuck)} prefix(es) hold a cidr that is not a network, and the "
            f"upgrade will not guess or delete them. Nothing has been changed.\n"
            f"{lines}\n{FIX_HINT}"
        )
    for r in rows:
        Prefix.objects.filter(pk=r["id"]).update(cidr=r["new"])
        _change_log(apps, r)
    log.warning("api.0265: rewrote %d prefix cidr(s) to CIDR form; nothing was deleted",
                len(rows))


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0261_sbom_package_ids"),
    ]

    run_before = [
        ("api", "0262_natural_name_and_inet_indexes"),
    ]

    operations = [
        migrations.RunPython(repair_unparseable, migrations.RunPython.noop),
    ]
