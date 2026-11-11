"""Replace the database's ``public`` schema with a ``pg_dump -Fc`` archive
without ever leaving it half restored.

Used by the in-app restore (``backups.restore.replace_database``) and by the
upgrade's rollback: the stage copies this file next to ``dbtool.py``, so a
rollback restores with the logic of the release being upgraded TO, whatever
the release on disk. Standard library and Django's connection only.

Dropping the schema in one statement takes a lock on every table, index,
sequence and TOAST table at once; a schema of Danbyte's size (some 3000
relations) runs out of lock slots on a stock server ("out of shared
memory", ``max_locks_per_transaction`` 64). So nothing is dropped up front:

1. The live objects move, one statement each, from ``public`` into the
   schema ``danbyte_pre_restore``. The extensions' objects (pg_trgm,
   unaccent) stay in ``public``: their members belong to the bootstrap
   superuser, so the app's role could neither move nor recreate them, and
   the old objects keep working against them.
2. ``pg_restore`` loads the dump into ``public``, one object per
   transaction; then every table, sequence and index the dump lists must be
   there.
3. Only then is the old schema dropped, a relation per statement. Failing
   that leaves a schema to drop later; the restore stands.

A failure in 2 drops what was restored and moves the old objects back: the
database is what it was. The old schema's comment says how far a run got,
so a run killed half way is put back by the next one before it starts. The
role needs what the old restore needed: to own the database (or ``public``)
and the extensions in it.
"""
from __future__ import annotations

import contextlib
import os
import re
import shutil
import subprocess

ASIDE = "danbyte_pre_restore"
# Every object in public and in the schema is a live one (moving either way).
MARK_MOVING = "danbyte restore: the live objects are being moved"
# Every live object is in the schema; what public holds came from the dump.
MARK_LIVE = "danbyte restore: the live objects, set aside while a dump is restored"
MARK_STALE = "danbyte restore: replaced by a restored dump; safe to drop"
PG_RESTORE_TIMEOUT = 3600

_REL = {"r": "TABLE", "p": "TABLE", "f": "FOREIGN TABLE", "v": "VIEW", "m": "MATERIALIZED VIEW",
        "S": "SEQUENCE"}
_TYPE = {"d": "DOMAIN", "e": "TYPE", "r": "TYPE", "c": "TYPE"}
# Kinds of object Danbyte's schema never has: met in public, the restore
# stops before it changes anything rather than half-move them.
_OTHER = (("pg_operator", "oprnamespace"),
          ("pg_opclass", "opcnamespace"), ("pg_opfamily", "opfnamespace"),
          ("pg_conversion", "connamespace"), ("pg_ts_config", "cfgnamespace"),
          ("pg_ts_dict", "dictnamespace"), ("pg_ts_parser", "prsnamespace"),
          ("pg_ts_template", "tmplnamespace"), ("pg_statistic_ext", "stxnamespace"))


class SwapError(RuntimeError):
    pass


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _one(cur, sql, args=None):
    cur.execute(sql, args)
    row = cur.fetchone()
    return row[0] if row else None


@contextlib.contextmanager
def _txn(connection):
    """One transaction on an autocommit connection, whichever alias (or
    none) it has."""
    with connection.cursor() as c:
        c.execute("BEGIN")
        try:
            yield c
        except BaseException:
            c.execute("ROLLBACK")
            raise
        c.execute("COMMIT")


def _not_extension(alias: str, catalog: str) -> str:
    return (f"NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '{catalog}'::regclass "
            f"AND d.objid = {alias}.oid AND d.deptype = 'e')")


def objects(connection, schema: str) -> list[tuple[str, str]]:
    """``(kind, qualified name)`` of every object of ``schema`` that is not
    an extension's, in an order that can be moved or dropped one by one:
    relations (an owned sequence goes with its table), then routines, then
    types, then collations. Raises when the schema holds a kind this module does not move."""
    s = _q(schema)
    out: list[tuple[str, str]] = []
    with connection.cursor() as c:
        for cat, col in _OTHER:
            n = _one(c, f"SELECT count(*) FROM {cat} o JOIN pg_namespace n ON n.oid = o.{col} "
                        f"WHERE n.nspname = %s AND {_not_extension('o', cat)}", [schema])
            if n:
                raise SwapError(f"schema {schema} holds {n} object(s) of {cat}, which a restore "
                                "does not move; nothing was changed")
        c.execute(
            "SELECT c.relkind, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = %s AND c.relkind IN ('r','p','f','v','m','S') "
            f"AND {_not_extension('c', 'pg_class')} "
            # an identity or serial column's sequence moves and drops with its table
            "AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = "
            "'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i') "
            "AND d.refclassid = 'pg_class'::regclass)) "
            # views first, then tables (partitions after their parents), then sequences
            "ORDER BY CASE c.relkind WHEN 'v' THEN 0 WHEN 'm' THEN 1 WHEN 'S' THEN 3 ELSE 2 END, "
            "c.relispartition, c.relname", [schema])
        out += [(_REL[k], f"{s}.{_q(n)}") for k, n in c.fetchall()]
        c.execute(
            "SELECT p.proname, pg_get_function_identity_arguments(p.oid) FROM pg_proc p "
            "JOIN pg_namespace n ON n.oid = p.pronamespace "
            f"WHERE n.nspname = %s AND {_not_extension('p', 'pg_proc')} ORDER BY p.proname", [schema])
        out += [("ROUTINE", f"{s}.{_q(n)}({args})") for n, args in c.fetchall()]
        c.execute(
            "SELECT t.typtype, t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace "
            "WHERE n.nspname = %s AND t.typtype IN ('d','e','r','c') "
            "AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c') "
            f"AND {_not_extension('t', 'pg_type')} ORDER BY t.typname", [schema])
        out += [(_TYPE[k], f"{s}.{_q(n)}") for k, n in c.fetchall()]
        # Last: a column or an index may use one (natural_sort).
        c.execute(
            "SELECT o.collname FROM pg_collation o JOIN pg_namespace n ON n.oid = o.collnamespace "
            f"WHERE n.nspname = %s AND {_not_extension('o', 'pg_collation')} ORDER BY o.collname",
            [schema])
        out += [("COLLATION", f"{s}.{_q(n)}") for (n,) in c.fetchall()]
    return out


def _move(connection, src: str, dst: str) -> int:
    """Every non-extension object of ``src`` into ``dst``, a statement
    (and a few locks) each."""
    moved = 0
    for kind, name in objects(connection, src):
        with connection.cursor() as c:
            c.execute(f"ALTER {kind} {name} SET SCHEMA {_q(dst)}")
        moved += 1
    return moved


def _drop_objects(connection, schema: str) -> int:
    """Every non-extension object of ``schema`` dropped, a statement each."""
    dropped = 0
    for kind, name in objects(connection, schema):
        what = kind
        if kind == "ROUTINE":
            # an aggregate or a procedure needs its own word
            with connection.cursor() as c:
                k = _one(c, "SELECT prokind FROM pg_proc WHERE oid = to_regprocedure(%s)", [name])
            if k is None:  # gone with something dropped before it
                continue
            what = {"a": "AGGREGATE", "p": "PROCEDURE"}.get(k, "FUNCTION")
        with connection.cursor() as c:
            c.execute(f"DROP {what} IF EXISTS {name} CASCADE")
        dropped += 1
    return dropped


def _mark(connection) -> str | None:
    with connection.cursor() as c:
        if not _one(c, "SELECT count(*) FROM pg_namespace WHERE nspname = %s", [ASIDE]):
            return None
        return _one(c, "SELECT obj_description(oid, 'pg_namespace') FROM pg_namespace "
                       "WHERE nspname = %s", [ASIDE]) or ""


def _set_mark(connection, mark: str) -> None:
    with connection.cursor() as c:
        c.execute(f"COMMENT ON SCHEMA {_q(ASIDE)} IS %s", [mark])


def terminate_other_sessions(connection) -> int:
    with connection.cursor() as c:
        return int(_one(c, "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity "
                           "WHERE datname = current_database() AND pid <> pg_backend_pid()") or 0)


def drop_aside(connection) -> int:
    """The replaced objects, a relation per statement, then their schema."""
    n = _drop_objects(connection, ASIDE)
    with connection.cursor() as c:
        c.execute(f"DROP SCHEMA IF EXISTS {_q(ASIDE)} CASCADE")
    return n


def set_aside(connection) -> int:
    objects(connection, "public")  # an object it cannot move stops it here
    with _txn(connection) as c:
        c.execute(f"CREATE SCHEMA {_q(ASIDE)}")
        c.execute(f"COMMENT ON SCHEMA {_q(ASIDE)} IS %s", [MARK_MOVING])
    n = _move(connection, "public", ASIDE)
    _set_mark(connection, MARK_LIVE)
    return n


def put_back(connection) -> None:
    """Undo a set-aside, from wherever it stopped: what was restored goes
    (only once every live object had moved out), the live objects come
    back, the schema they waited in goes. Safe to repeat."""
    mark = _mark(connection)
    if mark is None:
        return
    if mark == MARK_LIVE:
        _drop_objects(connection, "public")
        # From here on public holds live objects again (the ones moved
        # back): a run killed now must never drop them as restored ones.
        _set_mark(connection, MARK_MOVING)
    _move(connection, ASIDE, "public")
    with connection.cursor() as c:
        c.execute(f"DROP SCHEMA {_q(ASIDE)}")  # empty now, or this fails


def _settle_leftover(connection, say) -> None:
    """An earlier run's schema: put the live objects back, or finish its drop."""
    mark = _mark(connection)
    if mark is None:
        return
    if mark == MARK_STALE:
        say(f"dropping {ASIDE}, left by an earlier restore")
        drop_aside(connection)
        return
    if mark not in (MARK_MOVING, MARK_LIVE):
        raise SwapError(f"a schema named {ASIDE} exists that this restore did not make; "
                        "rename or drop it first")
    say("an earlier restore stopped half way: putting the objects it set aside back")
    put_back(connection)


def _pg(connection) -> tuple[dict, list[str], dict]:
    db = connection.settings_dict
    args = []
    for flag, key in (("-h", "HOST"), ("-p", "PORT"), ("-U", "USER")):
        if db.get(key):
            args += [flag, str(db[key])]
    env = {**os.environ}
    if db.get("PASSWORD"):
        env["PGPASSWORD"] = str(db["PASSWORD"])
    return db, args, env


def toc(dump: str, connection) -> dict[str, set[str]]:
    """What the archive creates in ``public``, from its table of contents."""
    if not os.path.isfile(dump) or not os.access(dump, os.R_OK):
        raise SwapError(f"the dump {dump} cannot be read")
    if shutil.which("pg_restore") is None:
        raise SwapError("pg_restore is not installed on this host.")
    _db, _args, env = _pg(connection)
    res = subprocess.run(["pg_restore", "-l", dump], env=env, capture_output=True, text=True,
                         timeout=600)
    if res.returncode != 0:
        raise SwapError(f"the dump cannot be read: {(res.stderr or '').strip()[-400:]}")
    want: dict[str, set[str]] = {"TABLE": set(), "SEQUENCE": set(), "INDEX": set()}
    for line in res.stdout.splitlines():
        m = re.match(r"^\d+; \d+ \d+ (TABLE|SEQUENCE|INDEX) public (\S+) ", line)
        if m:
            want[m.group(1)].add(m.group(2))
    if not want["TABLE"]:
        raise SwapError("the dump holds no tables")
    return want


def missing_objects(connection, want: dict[str, set[str]]) -> list[str]:
    kinds = {"TABLE": ["r", "p"], "SEQUENCE": ["S"], "INDEX": ["i", "I"]}
    missing = []
    with connection.cursor() as c:
        for what, names in want.items():
            c.execute("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                      "WHERE n.nspname = 'public' AND c.relkind::text = ANY(%s)", [kinds[what]])
            have = {r[0] for r in c.fetchall()}
            missing += [f"{what.lower()} {n}" for n in sorted(names - have)]
    return missing


def _pg_restore(dump: str, connection) -> None:
    db, args, env = _pg(connection)
    # Not --single-transaction: one transaction per object keeps the locks
    # few; the set-aside objects are what make the whole thing undoable.
    cmd = ["pg_restore", "-w", "--no-owner", "--no-privileges", "--exit-on-error",
           *args, "-d", db["NAME"], dump]
    try:
        res = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=PG_RESTORE_TIMEOUT)
    except subprocess.TimeoutExpired as exc:
        raise SwapError(f"pg_restore timed out after {PG_RESTORE_TIMEOUT}s") from exc
    if res.returncode != 0:
        raise SwapError(f"pg_restore failed: {(res.stderr or '').strip()[-800:]}")


def _undo(connection, exc: Exception) -> SwapError:
    try:
        connection.close()
        put_back(connection)
    except Exception as undo:  # noqa: BLE001
        return SwapError(f"{exc}; and moving the previous objects back failed too ({undo}) - "
                         f"they are kept, intact, in schema {ASIDE}")
    return SwapError(f"{exc} - the database was left as it was")


def replace_public(dump: str, connection, say=lambda msg: None) -> None:
    """Make ``public`` exactly the dump's, or leave it as it was and raise."""
    want = toc(dump, connection)
    terminate_other_sessions(connection)
    _settle_leftover(connection, say)
    try:
        n = set_aside(connection)
        say(f"set aside the live schema: {n} objects moved to {ASIDE}")
        _pg_restore(dump, connection)
        missing = missing_objects(connection, want)
        if missing:
            raise SwapError(f"the restore is incomplete: {len(missing)} object(s) missing, e.g. "
                            + ", ".join(missing[:5]))
    except Exception as exc:
        raise _undo(connection, exc) from exc
    say(f"restored {len(want['TABLE'])} tables, {len(want['INDEX'])} indexes")
    _set_mark(connection, MARK_STALE)
    try:
        n = drop_aside(connection)
        say(f"dropped the replaced schema ({n} objects)")
    except Exception as exc:  # noqa: BLE001 - the restore stands; the next one drops it
        say(f"warning: the replaced schema {ASIDE} could not be dropped ({exc}); "
            "the next restore drops it")
