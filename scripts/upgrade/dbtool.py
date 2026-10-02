"""Database and site helpers for the upgrade stage (``stage.sh``).

The stage runs these with whichever release is on disk at that moment, from
the app directory, so each one uses that release's own code and ``.env``::

    .venv/bin/python dbtool.py probe                 # preflight facts, key=value
    .venv/bin/python dbtool.py wait-db SECONDS       # until the database answers
    .venv/bin/python dbtool.py snapshot FILE         # pg_dump -Fc of the database
    .venv/bin/python dbtool.py restore FILE          # replace the database with FILE
    .venv/bin/python dbtool.py maintenance-off       # clear the maintenance flag
    .venv/bin/python dbtool.py release-in-flight     # free checks claimed by stopped workers
    python3 dbtool.py mail FILE SUBJECT TEXT         # stdlib SMTP, no Django

The folder this file lives in is dropped from the import path and the current
directory put first: a restore after a rollback runs the previous release's
``replace_database`` against the previous release's settings. Everything the
probe asks is wrapped, so an older release that lacks a piece answers "no"
instead of failing.
"""
from __future__ import annotations

import json
import os
import sys
import time


def _setup():
    sys.path[0] = os.getcwd()
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "danbyte.settings")
    import django

    django.setup()


def _say(key: str, value) -> None:
    text = str(value).replace("\n", " ").replace("\r", " ")
    print(f"{key}={text}", flush=True)


def probe(mail_path: str = "") -> int:
    """What the stage needs to know before it touches anything."""
    _setup()
    import platform
    import shutil

    from django.conf import settings
    from django.db import connection

    _say("python", ".".join(platform.python_version_tuple()[:2]))
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT pg_database_size(current_database())")
            _say("db_size", int(cur.fetchone()[0]))
    except Exception as exc:  # noqa: BLE001
        _say("db_size", 0)
        _say("db_error", f"{type(exc).__name__}: {exc}"[:300])

    why = []
    for tool in ("pg_dump", "pg_restore"):
        if shutil.which(tool) is None:
            why.append(f"{tool} is not installed")
    try:
        from backups.engine import dump_database  # noqa: F401
        from backups.restore import _db_ownership, replace_database  # noqa: F401

        owns, detail = _db_ownership()
        if not owns:
            why.append(detail)
    except Exception as exc:  # noqa: BLE001 - a release without the restore code
        why.append(f"this release cannot restore a database ({type(exc).__name__})")
    _say("db_rollback", 0 if why else 1)
    if why:
        _say("db_rollback_why", "; ".join(why))

    try:
        from django.core.cache import cache

        key = "danbyte:upgrade:probe"
        cache.set(key, "1", 30)
        _say("redis", 1 if cache.get(key) == "1" else 0)
        cache.delete(key)
    except Exception as exc:  # noqa: BLE001
        _say("redis", 0)
        _say("redis_error", f"{type(exc).__name__}: {exc}"[:200])
    try:
        from backups import maintenance

        state = maintenance.active() or {}
        if state and not state.get("upgrade"):
            _say("held", state.get("reason") or "maintenance")
    except Exception:  # noqa: BLE001 - a release before the flag
        pass

    # Plugins pip-installed into the venv (PLUGINS in .env); uploaded ones
    # live in the plugin folder and survive a new venv.
    _say("pip_plugins", ",".join(p.strip() for p in os.getenv("PLUGINS", "").split(",")
                                 if p.strip()))
    try:
        from django.contrib.auth import get_user_model

        _say("superuser", int(get_user_model().objects.filter(is_superuser=True,
                                                               is_active=True).exists()))
    except Exception:  # noqa: BLE001
        _say("superuser", 0)
    _say("mail", 1 if mail_path and _capture_mail(mail_path, settings) else 0)
    return 0


def _capture_mail(path: str, settings) -> bool:
    """Keep what it takes to mail the digest recipients should the database
    be lost later on (a failed restore): the upgrade cannot read it then.
    Mode 600, and the stage deletes it when it finishes."""
    try:
        import re

        from core.models import DeploymentSettings

        dep = DeploymentSettings.load()
        recipients = [r for r in re.split(r"[,\s]+", dep.digest_recipients or "") if r]
        if not dep.smtp_host or not recipients:
            return False
        try:
            from monitoring.notify import _deployment_name

            name = _deployment_name()
        except Exception:  # noqa: BLE001
            name = "Danbyte"
        data = {
            "host": dep.smtp_host, "port": dep.smtp_port or 587,
            "security": dep.smtp_security, "username": dep.smtp_username or "",
            "password": (dep.secrets or {}).get("password", ""),
            "from": getattr(dep, "email_from", "") or settings.DEFAULT_FROM_EMAIL,
            "to": recipients, "name": name,
        }
        fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh)
        return True
    except Exception:  # noqa: BLE001 - no alert mail is not a reason to stop
        return False


def wait_db(seconds: str) -> int:
    _setup()
    from django.db import connection

    deadline = time.monotonic() + float(seconds)
    while True:
        try:
            connection.ensure_connection()
            return 0
        except Exception as exc:  # noqa: BLE001
            connection.close()
            if time.monotonic() > deadline:
                print(f"the database did not answer: {exc}", file=sys.stderr)
                return 1
            time.sleep(3)


def snapshot(path: str) -> int:
    _setup()
    from backups.engine import dump_database

    # The whole database (#281): the service account's alone from pg_dump's
    # first byte, not made private after the fact.
    old = os.umask(0o077)
    try:
        dump_database(path)
    finally:
        os.umask(old)
    return 0


def restore(path: str) -> int:
    _setup()
    from backups.restore import replace_database

    replace_database(path)
    return 0


def maintenance_off() -> int:
    _setup()
    from backups import maintenance

    maintenance.leave()
    return 0


def release_in_flight() -> int:
    """Every worker is stopped: a check still marked in flight was claimed by
    one of them and would otherwise wait for the reaper."""
    _setup()
    from django.utils import timezone

    from monitoring.models import CheckState

    n = CheckState.objects.filter(in_flight=True).update(
        in_flight=False, in_flight_since=None, next_run=timezone.now())
    print(f"released {n} check(s)")
    return 0


def mail(path: str, subject: str, text: str) -> int:
    import smtplib
    import ssl
    from email.message import EmailMessage

    with open(path) as fh:
        cfg = json.load(fh)
    msg = EmailMessage()
    msg["Subject"] = f"[{cfg.get('name') or 'Danbyte'}] {subject}"
    msg["From"] = cfg["from"]
    msg["To"] = ", ".join(cfg["to"])
    msg.set_content(text + "\n")
    port = int(cfg.get("port") or 587)
    if cfg.get("security") == "ssl":
        server = smtplib.SMTP_SSL(cfg["host"], port, timeout=20,
                                  context=ssl.create_default_context())
    else:
        server = smtplib.SMTP(cfg["host"], port, timeout=20)
    with server:
        if cfg.get("security") == "starttls":
            server.starttls(context=ssl.create_default_context())
        if cfg.get("username"):
            server.login(cfg["username"], cfg.get("password") or "")
        server.send_message(msg)
    return 0


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, args = argv[0], argv[1:]
    try:
        if cmd == "probe":
            return probe(os.environ.get("DANBYTE_UPGRADE_MAIL", ""))
        if cmd == "wait-db" and len(args) == 1:
            return wait_db(args[0])
        if cmd == "snapshot" and len(args) == 1:
            return snapshot(args[0])
        if cmd == "restore" and len(args) == 1:
            return restore(args[0])
        if cmd == "maintenance-off":
            return maintenance_off()
        if cmd == "release-in-flight":
            return release_in_flight()
        if cmd == "mail" and len(args) == 3:
            return mail(*args)
    except Exception as exc:  # noqa: BLE001 - the stage quotes stderr
        print(f"{cmd}: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
