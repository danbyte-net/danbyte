"""Executing a script.

One shape for both runtimes: a child process of the RQ worker, started
from an argv list (never a shell) in its own process session, so a timeout
kills the whole tree rather than leaking grandchildren.

* **Sandboxed** - ``python -I`` with an environment built from scratch. It
  holds the run token and nothing else: no database password, no Fernet
  key, no ``DJANGO_SETTINGS_MODULE``. Whatever the script does, it does
  through the API as the run-as user.
* **Trusted** - the same launcher, plus the settings module and the
  database environment, so ``danbyte_sdk.orm`` works. Only a holder of the
  ``trust`` verb can mark a script trusted; this is worker-privilege code
  and the docs say so.

Both get CPU and memory limits, a wall-clock timeout, and caps on how much
log and output they may produce.
"""
from __future__ import annotations

import json
import logging
import os
import resource
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from django.conf import settings
from django.db.models import TextField, Value
from django.db.models.functions import Concat
from django.utils import timezone

from . import tokens
from .models import ScriptOutput, ScriptRun

logger = logging.getLogger(__name__)

LOG_LIMIT = 512 * 1024          # bytes of log kept per run
OUTPUT_LIMIT = 64 * 1024 * 1024  # total bytes of files a run may produce
OUTPUT_FILE_LIMIT = 200
MEMORY_LIMIT = 1024 * 1024 * 1024  # address space per run
FLUSH_SECONDS = 2.0
TERM_GRACE = 5.0

# The entry point the child actually runs. Keeping the user's code in a
# file and this in another means a traceback points at the script's own
# line numbers.
_BOOTSTRAP = """\
import os, sys, json, runpy, traceback
sys.path.insert(0, os.environ["DANBYTE_SDK_PATH"])
from danbyte_sdk.run import ScriptFailure
try:
    runpy.run_path(os.environ["DANBYTE_SCRIPT_PATH"], run_name="__main__")
except ScriptFailure as exc:
    print(f"script failed: {exc}", file=sys.stderr, flush=True)
    sys.exit(2)
except SystemExit:
    raise
except BaseException:
    traceback.print_exc()
    sys.exit(1)
"""


class RunnerError(RuntimeError):
    pass


def sdk_path() -> str:
    """The directory that has ``danbyte_sdk`` on it - the repo root."""
    return str(settings.BASE_DIR)


def internal_url() -> str:
    """Where the script's client should point. The loopback backend by
    default; a deployment behind a proxy that rewrites paths can override
    it with DANBYTE_INTERNAL_URL."""
    from django.conf import settings as s

    return (getattr(s, "DANBYTE_INTERNAL_URL", "") or "http://127.0.0.1:8000").rstrip("/")


def base_env(run, key: str, work: str, outputs: str) -> dict:
    """The environment a sandboxed child gets. Built from nothing, so a
    secret can only appear here if it is added on purpose."""
    url = internal_url()
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": work,
        "TMPDIR": work,
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "DANBYTE_URL": url,
        "DANBYTE_TOKEN": key,
        "DANBYTE_RUN_ID": str(run.id),
        "DANBYTE_OUTPUT_DIR": outputs,
        "DANBYTE_PARAMS": json.dumps(run.params or {}),
        "DANBYTE_SDK_PATH": sdk_path(),
    }


def trusted_env(run, env: dict) -> dict:
    """Trusted runs additionally get Django. Inheriting the worker's
    environment is the point here - the ORM needs the database."""
    env = {**os.environ, **env}
    env["DJANGO_SETTINGS_MODULE"] = os.environ.get("DJANGO_SETTINGS_MODULE", "danbyte.settings")
    env["PYTHONPATH"] = sdk_path()
    env["DANBYTE_RUN_AS_ID"] = str(run.run_as_user_id or "")
    env["DANBYTE_TENANT_ID"] = str(run.script.tenant_id or "")
    return env


def _limits(cpu_seconds: int):
    """Applied in the child between fork and exec."""

    def apply() -> None:
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 5))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NPROC, (256, 256))

    return apply


def build_command(run, work: str) -> list[str]:
    """argv for the child. Python only today; the branch is where another
    language plugs in."""
    language = run.script.language
    if language != "python":
        raise RunnerError(f"{language} scripts cannot run on this version.")
    script_path = os.path.join(work, "script.py")
    with open(script_path, "w") as fh:
        fh.write(run.source or "")
    boot = os.path.join(work, "_danbyte_boot.py")
    with open(boot, "w") as fh:
        fh.write(_BOOTSTRAP)
    # -I isolates: no user site-packages, no inherited PYTHONPATH, no cwd
    # on sys.path. Trusted runs need the environment, so only -B there.
    flags = ["-B"] if run.trusted else ["-I", "-B"]
    return [sys.executable, *flags, boot]


class _LogPump:
    """Reads the child's output and lands it on the run in chunks, so the
    page shows a live log without one UPDATE per line."""

    def __init__(self, run: ScriptRun):
        self.run = run
        self.buffer: list[str] = []
        self.size = 0
        self.truncated = False
        self.last_flush = time.monotonic()

    def feed(self, text: str) -> None:
        if not self.truncated:
            if self.size + len(text) > LOG_LIMIT:
                self.buffer.append("\n… log truncated at the size limit.\n")
                self.truncated = True
            else:
                self.buffer.append(text)
                self.size += len(text)
        if time.monotonic() - self.last_flush >= FLUSH_SECONDS:
            self.flush()

    def flush(self) -> None:
        chunk = "".join(self.buffer)
        self.buffer = []
        truncated = self.truncated
        self.last_flush = time.monotonic()
        if not chunk and not truncated:
            return
        # Append in the database, so a long log is never read back into
        # Python just to add a line to it.
        ScriptRun.objects.filter(pk=self.run.pk).update(
            log=Concat("log", Value(chunk), output_field=TextField()),
            truncated=truncated, updated_at=timezone.now(),
        )


def pump_until_done(proc, pump: _LogPump, timeout: float) -> tuple[int | None, bool]:
    """Read the child's output until it exits or runs out of time.

    Single-threaded on purpose: a reader thread would open a second
    database connection just to append log lines, and inside a
    transaction it would not even see the run row.
    """
    deadline = time.monotonic() + timeout
    fd = proc.stdout.fileno()
    os.set_blocking(fd, False)
    timed_out = False
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            timed_out = True
            break
        ready, _, _ = select.select([fd], [], [], min(left, FLUSH_SECONDS))
        if ready:
            chunk = os.read(fd, 65536)
            if chunk:
                pump.feed(chunk.decode(errors="replace"))
                continue
            break  # EOF: the child closed its output
        pump.flush()  # nothing to read; still land what we have
        if proc.poll() is not None:
            break
    # Drain whatever is buffered before deciding the outcome.
    if not timed_out:
        while True:
            try:
                chunk = os.read(fd, 65536)
            except BlockingIOError:
                break
            if not chunk:
                break
            pump.feed(chunk.decode(errors="replace"))
    pump.flush()
    if timed_out:
        return None, True
    try:
        return proc.wait(timeout=TERM_GRACE), False
    except subprocess.TimeoutExpired:
        return None, True


def collect_outputs(run: ScriptRun, outputs: str) -> int:
    """Move whatever the script wrote into ScriptOutput rows."""
    import mimetypes

    from django.core.files import File

    if not os.path.isdir(outputs):
        return 0
    total = 0
    saved = 0
    for name in sorted(os.listdir(outputs))[:OUTPUT_FILE_LIMIT]:
        path = os.path.join(outputs, name)
        if not os.path.isfile(path):
            continue
        size = os.path.getsize(path)
        if total + size > OUTPUT_LIMIT:
            logger.warning("run %s exceeded the output limit; dropping %s", run.id, name)
            break
        total += size
        with open(path, "rb") as fh:
            out = ScriptOutput(
                run=run, name=name, size=size,
                content_type=mimetypes.guess_type(name)[0] or "application/octet-stream",
            )
            out.file.save(name, File(fh), save=True)
        saved += 1
    return saved


def create_run(script, *, user, params=None, scheduled: bool = False) -> ScriptRun:
    """A queued run, with the code and the run-as user snapshotted so the
    record still makes sense after the script is edited."""
    run_as = script.owner if script.run_as == "owner" and script.owner_id else user
    return ScriptRun.objects.create(
        script=script, params=params or {}, status="queued", scheduled=scheduled,
        trusted=script.trusted, source=script.source, started_by=user, run_as_user=run_as,
    )


def enqueue(run: ScriptRun) -> None:
    from api.devicetype_import_tasks import _enqueue

    _enqueue(run_script, run, "script run")


def run_script(run_id: str) -> ScriptRun | None:
    """Execute one run. Never raises into the worker: the row carries the
    outcome."""
    run = ScriptRun.objects.select_related("script", "run_as_user").filter(pk=run_id).first()
    if run is None:
        logger.warning("script run %s not found", run_id)
        return None
    try:
        from rq import get_current_job

        job = get_current_job()
        if job is not None:
            ScriptRun.objects.filter(pk=run.pk).update(rq_job_id=job.id)
    except Exception:  # noqa: BLE001 - running inline, no job
        pass

    run.status = "running"
    run.started_at = timezone.now()
    run.log = ""
    run.save(update_fields=["status", "started_at", "log", "updated_at"])

    work = tempfile.mkdtemp(prefix=f"script-{str(run.id)[:8]}-")
    outputs = os.path.join(work, "outputs")
    os.makedirs(outputs, exist_ok=True)
    token = None
    proc = None
    pump = _LogPump(run)
    try:
        if run.run_as_user is None:
            raise RunnerError("This script has no user to run as.")
        token, key = tokens.mint(run)
        env = base_env(run, key, work, outputs)
        if run.trusted:
            env = trusted_env(run, env)
        env["DANBYTE_SCRIPT_PATH"] = os.path.join(work, "script.py")
        cmd = build_command(run, work)
        timeout = run.script.effective_timeout

        proc = subprocess.Popen(  # noqa: S603 - argv list, no shell, fixed interpreter
            cmd, cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            start_new_session=True, preexec_fn=_limits(timeout), close_fds=True,
        )
        code, timed_out = pump_until_done(proc, pump, timeout)
        if timed_out:
            _kill(proc)
            code = proc.returncode
            status = "timeout"
            error = f"the script ran longer than {timeout}s and was stopped"
        else:
            status = "success" if code == 0 else "failed"
            error = "" if code == 0 else f"the script exited with code {code}"

        saved = collect_outputs(run, outputs)
        run.refresh_from_db()
        run.status = status
        run.exit_code = code
        run.error = error
        run.finished_at = timezone.now()
        run.save(update_fields=["status", "exit_code", "error", "finished_at", "updated_at"])
        logger.info("script run %s %s (%s output file(s))", run.id, status, saved)
    except Exception as exc:  # noqa: BLE001 - land it on the row
        logger.exception("script run %s failed to execute", run_id)
        if proc is not None and proc.poll() is None:
            _kill(proc)
        pump.flush()
        run.refresh_from_db()
        run.status = "failed"
        run.error = str(exc)[:2000]
        run.finished_at = timezone.now()
        run.save(update_fields=["status", "error", "finished_at", "updated_at"])
    finally:
        if proc is not None and proc.stdout is not None:
            proc.stdout.close()
        tokens.revoke(token)
        shutil.rmtree(work, ignore_errors=True)
    run.refresh_from_db()
    return run


def _kill(proc) -> None:
    """SIGTERM the whole session, then SIGKILL what is left - so a script
    that forked a sleeper leaves nothing behind."""
    for sig, wait in ((signal.SIGTERM, TERM_GRACE), (signal.SIGKILL, 2)):
        try:
            os.killpg(os.getpgid(proc.pid), sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            proc.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def cancel(run: ScriptRun) -> bool:
    """Ask the worker to stop a queued or running job."""
    if not run.active:
        return False
    stopped = False
    if run.rq_job_id:
        try:
            import django_rq
            from rq.command import send_stop_job_command
            from rq.job import Job

            conn = django_rq.get_connection("low")
            job = Job.fetch(run.rq_job_id, connection=conn)
            if job.get_status() == "started":
                send_stop_job_command(conn, run.rq_job_id)
            else:
                job.cancel()
            stopped = True
        except Exception:  # noqa: BLE001 - fall through to the row update
            logger.warning("could not stop RQ job for run %s", run.id, exc_info=True)
    ScriptRun.objects.filter(pk=run.pk, status__in=("queued", "running")).update(
        status="canceled", error="canceled", finished_at=timezone.now(),
        updated_at=timezone.now(),
    )
    return stopped
