"""CAD drawings under floor plans: upload checks, the render job, files.

A plan's ``FloorPlanDrawing`` holds the uploaded DXF (or DWG) and, once the
RQ job here has run, a sanitised SVG of its model space. The work happens off
the web worker and out of process:

1. A DWG is turned into DXF by the converter named in
   ``settings.DANBYTE_CAD_CONVERTER`` - LibreDWG's ``dwg2dxf`` or the ODA File
   Converter, nothing else. It is a C/C++ parser fed untrusted files, so it
   runs in a bubblewrap sandbox (``scripting.sandbox.program_argv``, #424):
   no network, a read-only root holding only the program (and, for a
   dynamic one, the system libraries), the staged DWG read-only and an
   output dir as the only writable place - never the Danbyte directory,
   ``.env`` or media. Also no shell, a scrubbed environment, resource limits
   and a timeout, and its output is size-checked. With no converter set, or
   no working sandbox (unless ``DANBYTE_CAD_SANDBOX=off``), DWG uploads are
   refused up front.
2. ``api/cad_engine.py`` reads the DXF with ezdxf (``ezdxf.recover``) and
   writes the SVG and its metadata. It runs as ``python -I`` in its own
   process under memory, CPU and file-size limits, so a hostile file can
   cost a failed job but never the worker. It is pure Python, so a bad file
   raises rather than corrupting memory; it is not sandboxed.
3. The SVG goes through ``svg_sanitize.sanitize_svg(profile="cad")`` - the
   only way a drawing reaches the browser - and is stored with the layers,
   units and extents.

The job never trusts its enqueue-time ids: it re-reads the drawing, checks it
still belongs to its plan's tenant and still holds the file it was queued for,
and re-checks once more before writing. A drawing replaced or deleted mid-run
is left alone.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import resource
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

from django.conf import settings
from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone

from scripting import sandbox

logger = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 50 * 1024 * 1024
#: A DWG converts to a much larger DXF; past this the converter's output is
#: refused (and RLIMIT_FSIZE stops it writing more).
MAX_CONVERTED_BYTES = 256 * 1024 * 1024
MAX_SVG_BYTES = 20 * 1024 * 1024
MAX_ELEMENTS = 250_000
MAX_TEXT_CHARS = 2_000_000
CONVERT_TIMEOUT = 300
RENDER_TIMEOUT = 600
#: Address space for the engine and the converter.
MEMORY_LIMIT = 3 * 1024 * 1024 * 1024
#: Server renders with layers left out kept per drawing; the oldest goes.
MAX_VARIANTS = 12
#: Server renders one drawing may have queued at once; past this a new one
#: is refused until one finishes, so render requests cannot pile up.
MAX_QUEUED_VARIANTS = 3
JOB_TIMEOUT = CONVERT_TIMEOUT + RENDER_TIMEOUT + 120

#: The converter programs that may be run, by file name, and how.
CONVERTERS = {"dwg2dxf": "libredwg", "ODAFileConverter": "oda"}

ENGINE = Path(__file__).with_name("cad_engine.py")
NO_CONVERTER = (
    "DWG files need a converter on the server, and none is set up. Save the "
    "drawing as DXF in your CAD program and upload that."
)
QUEUE_DOWN = "The job queue is unavailable. Reprocess the drawing once it is back."

DWG_MAGIC = (b"AC1012", b"AC1014", b"AC1015", b"AC1018", b"AC1021", b"AC1024",
             b"AC1027", b"AC1032", b"AC1009", b"AC1006", b"AC1004", b"AC1002")
BINARY_DXF = b"AutoCAD Binary DXF\r\n\x1a\x00"


#: Where a worker leaves its verdict on the sandbox for the web processes.
SANDBOX_KEY = "cad:sandbox-probe"
SANDBOX_OFF = ("off", "none", "0", "false", "no")


class ConverterUnavailable(Exception):
    pass


# ─── the converter ──────────────────────────────────────────────────────────


def sandbox_mode() -> str:
    """``bwrap`` (the default, and any value but an explicit off) or
    ``off``: DANBYTE_CAD_SANDBOX."""
    value = str(getattr(settings, "CAD_SANDBOX", "bwrap") or "bwrap").strip().lower()
    return "off" if value in SANDBOX_OFF else "bwrap"


def _no_sandbox(reason: str) -> str:
    return (
        f"DWG files are converted in a sandbox, and this server cannot build one: {reason}. "
        "Save the drawing as DXF in your CAD program and upload that."
    )


def sandbox_problem() -> str:
    """Why the converter cannot be sandboxed, as far as a web process can
    tell without starting it: no ``bwrap``, or a worker's last probe failed.
    Empty when it looks fine or the sandbox is off. The worker probes for
    real before every conversion (:func:`sandboxed`)."""
    if sandbox_mode() == "off":
        return ""
    if not sandbox.find_bwrap():
        return "bubblewrap is not installed"
    try:
        from django.core.cache import cache

        seen = cache.get(SANDBOX_KEY)
    except Exception:  # noqa: BLE001 - a cache outage leaves it to the worker
        seen = None
    if isinstance(seen, dict) and not seen.get("usable"):
        return str(seen.get("reason") or "bubblewrap failed")
    return ""


def _sandbox_probe() -> sandbox.BwrapProbe:
    """On the worker: whether bwrap works here (the script sandbox's probe),
    recorded for the web processes. ConverterUnavailable when it does not."""
    probe = sandbox.bwrap_probe()
    try:
        from django.core.cache import cache

        cache.set(SANDBOX_KEY, {"usable": probe.usable, "reason": probe.reason},
                  sandbox.PROBE_TTL)
    except Exception:  # noqa: BLE001
        pass
    if not probe.usable:
        raise ConverterUnavailable(_no_sandbox(probe.reason or "bubblewrap failed"))
    return probe


def converter() -> tuple[str, str]:
    """``(path, flavour)`` of the configured converter, or
    :class:`ConverterUnavailable` saying why not: no converter, a bad one,
    or no sandbox to run it in (:func:`sandbox_problem`)."""
    path, flavour = _configured()
    problem = sandbox_problem()
    if problem:
        raise ConverterUnavailable(_no_sandbox(problem))
    return path, flavour


def _configured() -> tuple[str, str]:
    """The converter setting, checked: the path must be absolute, an
    executable regular file not writable by everyone, and named like one of
    the two supported programs."""
    raw = (getattr(settings, "DANBYTE_CAD_CONVERTER", "") or "").strip()
    if not raw:
        raise ConverterUnavailable(NO_CONVERTER)
    if not os.path.isabs(raw):
        raise ConverterUnavailable("DANBYTE_CAD_CONVERTER must be an absolute path.")
    real = os.path.realpath(raw)
    flavour = CONVERTERS.get(os.path.basename(real)) or CONVERTERS.get(os.path.basename(raw))
    if flavour is None:
        raise ConverterUnavailable(
            "DANBYTE_CAD_CONVERTER must point at dwg2dxf (LibreDWG) or ODAFileConverter."
        )
    try:
        st = os.stat(real)
    except OSError as exc:
        raise ConverterUnavailable("The DWG converter is not installed where it is set.") from exc
    if not stat.S_ISREG(st.st_mode) or not os.access(real, os.X_OK):
        raise ConverterUnavailable("The DWG converter is not an executable file.")
    if st.st_mode & stat.S_IWOTH:
        raise ConverterUnavailable("The DWG converter is writable by everyone; refusing it.")
    return real, flavour


def converter_status() -> dict:
    """What the upload form says about DWG."""
    try:
        path, flavour = converter()
    except ConverterUnavailable as exc:
        return {"dwg": False, "converter": None, "message": str(exc)}
    return {"dwg": True, "converter": os.path.basename(path), "message": ""}


def _limits(memory: int, fsize: int, cpu: int, restrict=None):
    def apply():  # runs in the child between fork and exec
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.setsid()
        if restrict is not None:
            restrict()  # raises, so a half-confined child never starts

    return apply


def _env(tmp: str, **extra) -> dict:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": tmp,
        "TMPDIR": tmp,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        **extra,
    }


def _run(argv: list[str], *, cwd: str, env: dict, timeout: int, fsize: int, restrict=None):
    """Run a program: argv list (no shell), its own session, limits, a
    timeout that kills the whole process group. ``restrict`` runs last
    before exec (the sandbox's no_new_privs and seccomp filter)."""
    proc = subprocess.Popen(  # noqa: S603 - argv list, fixed programs
        argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        preexec_fn=_limits(MEMORY_LIMIT, fsize, timeout + 5, restrict),  # noqa: PLW1509
        close_fds=True,
    )
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, 9)
        except OSError:
            proc.kill()
        proc.communicate()
        raise
    return proc.returncode, out[-4000:], err[-4000:]


def convert_dwg(src: str, tmp: str) -> str:
    """The DXF the converter makes of ``src``, inside ``tmp``. Raises
    ValueError with a message for the operator."""
    path, flavour = _configured()
    in_dir = os.path.join(tmp, "dwg-in")
    out_dir = os.path.join(tmp, "dwg-out")
    os.makedirs(in_dir)
    os.makedirs(out_dir)
    staged = os.path.join(in_dir, "drawing.dwg")
    shutil.copyfile(src, staged)
    out = os.path.join(out_dir, "drawing.dxf")
    if flavour == "libredwg":
        argv = [path, "-y", "-o", out, staged]
        env = _env(out_dir)
    else:
        # ODA: input folder, output folder, version, type, recurse, audit, filter.
        argv = [path, in_dir, out_dir, "ACAD2018", "DXF", "0", "1", "*.DWG"]
        env = _env(out_dir, QT_QPA_PLATFORM="offscreen")
    argv, restrict = sandboxed(argv, flavour, in_dir=in_dir, out_dir=out_dir)
    try:
        code, _out, err = _run(
            argv, cwd=out_dir, env=env, timeout=CONVERT_TIMEOUT,
            fsize=MAX_CONVERTED_BYTES + 1, restrict=restrict,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Converting the DWG took too long.") from exc
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError("The DWG converter could not be started.") from exc
    if restrict is not None and code != 0 and err.lstrip().startswith(b"bwrap:"):
        logger.warning("CAD converter sandbox failed: %s", err.decode("utf-8", "replace"))
        raise ValueError("The DWG converter's sandbox could not start on this server.")
    return _take_output(out, os.path.join(tmp, "converted.dxf"), code, err)


def _take_output(out: str, dest: str, code, err: bytes) -> str:
    """Copy the converter's output into ``dest``, a file this worker made.

    The converter wrote ``out`` from inside its sandbox, but the engine reads
    the result outside it: a converter taken over by a crafted DWG could
    leave a link there to a file only the worker can read. So the output is
    opened without following a link, must be a plain file with one name, and
    the engine gets a copy, never the converter's own path."""
    try:
        fd = os.open(out, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        fd = None
    if fd is None:
        logger.warning("CAD converter exit %s: %s", code, err.decode("utf-8", "replace"))
        raise ValueError(
            "The DWG converter could not read this file (unsupported version or damaged)."
        )
    with os.fdopen(fd, "rb") as fh:
        st = os.fstat(fh.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            logger.warning("CAD converter left something other than a file at %s", out)
            raise ValueError("The DWG converter produced an unusable result.")
        if st.st_size > MAX_CONVERTED_BYTES:
            raise ValueError("The converted drawing is too large to process.")
        if st.st_size == 0:
            raise ValueError("The DWG converter produced an empty drawing.")
        with open(dest, "xb") as copy:
            shutil.copyfileobj(fh, copy, 1024 * 1024)
    return dest


def sandboxed(argv: list[str], flavour: str, *, in_dir: str, out_dir: str):
    """``(argv, restrict)``: ``argv`` wrapped in the bubblewrap sandbox, and
    what to apply before exec. The converter sees its program, the staged
    DWG read-only and ``out_dir`` read-write. ODA, a dynamically linked Qt
    program, also gets the system libraries, its install directory, a
    ``/proc`` of its own pid namespace and a private ``/tmp``.

    With ``DANBYTE_CAD_SANDBOX=off`` the argv is returned as it is (limits
    only). Otherwise a host where bwrap does not work raises
    ConverterUnavailable: the converter never runs unconfined by default."""
    if sandbox_mode() == "off":
        logger.warning("CAD converter runs outside the sandbox (DANBYTE_CAD_SANDBOX=off)")
        return argv, None
    probe = _sandbox_probe()
    oda = flavour == "oda"
    try:
        wrap = sandbox.program_argv(
            probe, argv[0], cwd=out_dir, read_only=(in_dir,), writable=(out_dir,),
            proc=oda, tmp=oda,
        )
    except sandbox.SandboxUnavailable as exc:
        raise ConverterUnavailable(str(exc)) from exc
    return wrap + argv, sandbox.program_restrictor()


# ─── upload checks ──────────────────────────────────────────────────────────


def detect_kind(name: str, head: bytes) -> str | None:
    """``"dxf"`` / ``"dwg"`` when the file's name and first bytes agree."""
    ext = os.path.splitext(name or "")[1].lower()
    if ext == ".dwg":
        return "dwg" if head[:6] in DWG_MAGIC else None
    if ext == ".dxf":
        if head.startswith(BINARY_DXF):
            return "dxf"
        if head[:6] in DWG_MAGIC:
            return None  # a DWG renamed .dxf
        text = head.lstrip(b"\xef\xbb\xbf \t\r\n")
        # An ASCII DXF opens with a group code: "0" then SECTION, or a
        # "999" comment.
        if text[:1].isdigit():
            return "dxf"
    return None


# ─── the job ────────────────────────────────────────────────────────────────


def enqueue(drawing_id, source_name: str, *, variant: str | None = None) -> bool:
    """Queue a render once the current transaction commits. False when the
    queue is unreachable (the caller marks the drawing failed)."""
    import django_rq

    def push():
        try:
            if variant:
                django_rq.get_queue("default").enqueue(
                    run_variant, str(drawing_id), source_name, variant, job_timeout=JOB_TIMEOUT
                )
            else:
                django_rq.get_queue("default").enqueue(
                    run_render, str(drawing_id), source_name, job_timeout=JOB_TIMEOUT
                )
        except Exception:  # noqa: BLE001 - Redis down
            logger.warning("RQ unavailable; CAD render for %s not queued", drawing_id)
            _queue_down(drawing_id, source_name, variant)

    transaction.on_commit(push)
    return True


def _queue_down(drawing_id, source_name: str, variant: str | None) -> None:
    from .models import FloorPlanDrawing

    d = FloorPlanDrawing.objects.filter(pk=drawing_id, source=source_name).first()
    if d is None:
        return
    if variant:
        v = dict(d.variants or {})
        if variant in v:
            v[variant] = {**v[variant], "status": "failed", "error": QUEUE_DOWN}
            FloorPlanDrawing.objects.filter(pk=d.pk).update(variants=v)
        return
    d.status = "failed"
    d.error = QUEUE_DOWN
    d.save(update_fields=["status", "error", "updated_at"])


def _current(drawing_id, source_name: str):
    """The drawing when it still holds ``source_name`` and sits in its plan's
    tenant; None otherwise."""
    from .models import FloorPlanDrawing

    d = (
        FloorPlanDrawing.objects.select_related("floor_plan")
        .filter(pk=drawing_id, source=source_name).first()
    )
    if d is None or d.floor_plan.tenant_id != d.tenant_id:
        return None
    return d


def _render(
    d, tmp: str, *, hidden=(), hide_text: bool = False, extents: dict | None = None
) -> tuple[dict, bytes]:
    """(engine metadata, sanitised SVG) for drawing ``d``. ValueError with
    the operator's message on any failure. ``extents`` frames the render by
    those instead of what it draws (a variant uses the full drawing's)."""
    from .svg_sanitize import SvgRejected, sanitize_svg

    src = os.path.join(tmp, "source")
    with d.source.open("rb") as fh, open(src, "wb") as out:
        shutil.copyfileobj(fh, out, 1024 * 1024)
    if os.path.getsize(src) > MAX_UPLOAD_BYTES:
        raise ValueError("The file is over the 50 MB limit.")
    if d.source_kind == "dwg":
        try:
            src = convert_dwg(src, tmp)
        except ConverterUnavailable as exc:
            raise ValueError(str(exc)) from exc
    svg_path = os.path.join(tmp, "out.svg")
    meta_path = os.path.join(tmp, "out.json")
    argv = [
        sys.executable, "-I", str(ENGINE), src, svg_path, meta_path,
        "--max-bytes", str(MAX_SVG_BYTES), "--max-elements", str(MAX_ELEMENTS),
        "--max-text", str(MAX_TEXT_CHARS), "--deadline", str(RENDER_TIMEOUT - 30),
    ]
    if hidden:
        hidden_path = os.path.join(tmp, "hidden.json")
        with open(hidden_path, "w", encoding="utf-8") as fh:
            json.dump(sorted(hidden), fh)
        argv += ["--hidden", hidden_path]
    if hide_text:
        argv.append("--hide-text")
    if extents:
        extents_path = os.path.join(tmp, "extents.json")
        with open(extents_path, "w", encoding="utf-8") as fh:
            json.dump({k: extents[k] for k in ("min_x", "min_y", "max_x", "max_y")}, fh)
        argv += ["--extents", extents_path]
    try:
        code, _out, err = _run(
            argv, cwd=tmp, env=_env(tmp), timeout=RENDER_TIMEOUT, fsize=MAX_SVG_BYTES * 4
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Rendering the drawing took too long.") from exc
    meta = {}
    try:
        with open(meta_path, encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        pass
    if code != 0 or not meta.get("ok"):
        if not meta.get("error"):
            logger.warning("CAD engine exit %s: %s", code, err.decode("utf-8", "replace"))
        if code is not None and code < 0:
            raise ValueError("The drawing needs more memory or time than allowed to render.")
        raise ValueError(meta.get("error") or "The drawing could not be rendered.")
    with open(svg_path, "rb") as fh:
        raw = fh.read()
    try:
        clean = sanitize_svg(
            raw, profile="cad", max_bytes=MAX_SVG_BYTES, max_elements=MAX_ELEMENTS,
            max_text=MAX_TEXT_CHARS,
        )
    except SvgRejected as exc:
        raise ValueError(f"The rendered drawing was refused: {exc}") from exc
    return meta, clean


def default_placement(layers: list, old: dict | None = None) -> dict:
    """Where a newly processed drawing sits: the old placement's position,
    rotation and opacity when there was one, and the layers the file had off
    or frozen hidden."""
    old = old if isinstance(old, dict) else {}
    return {
        "x_mm": old.get("x_mm", 0),
        "y_mm": old.get("y_mm", 0),
        "rotation": old.get("rotation", 0),
        "opacity": old.get("opacity", 60),
        "hidden_layers": [row["name"] for row in layers if not row["on"] or row["frozen"]],
        "hide_text": bool(old.get("hide_text", False)),
    }


def run_render(drawing_id: str, source_name: str) -> None:
    """RQ job: process the drawing's upload. Never raises; the outcome lands
    on the drawing."""
    d = _current(drawing_id, source_name)
    if d is None:
        return
    try:
        with tempfile.TemporaryDirectory(prefix="danbyte-cad-") as tmp:
            meta, svg = _render(d, tmp)
    except ValueError as exc:
        _fail(drawing_id, source_name, str(exc))
        return
    except Exception:  # noqa: BLE001 - the worker survives a bad file
        logger.exception("CAD render failed for %s", drawing_id)
        _fail(drawing_id, source_name, "The drawing could not be rendered.")
        return

    with transaction.atomic():
        d = _current(drawing_id, source_name)
        if d is None:
            return
        old_rendered = d.rendered.name if d.rendered else ""
        old_variants = [v.get("file") for v in (d.variants or {}).values() if v.get("file")]
        d.rendered.save("drawing.svg", ContentFile(svg), save=False)
        d.status = "ready"
        d.error = ""
        d.units = meta["units"]
        d.units_mm_per_unit = meta["mm_per_unit"]
        d.extents = meta["extents"]
        d.layers = meta["layers"]
        d.rendered_bytes = len(svg)
        d.rendered_elements = meta["elements"]
        d.simplified = meta["simplified"]
        d.skipped = meta["skipped"]
        d.variants = {}
        if not d.placement or d.processed_at is None:
            d.placement = default_placement(d.layers, d.placement)
        d.processed_at = timezone.now()
        d.save()
        stale = [n for n in [old_rendered, *old_variants] if n]
        transaction.on_commit(lambda: delete_names(stale))


def _fail(drawing_id, source_name: str, message: str) -> None:
    with transaction.atomic():
        d = _current(drawing_id, source_name)
        if d is None:
            return
        d.status = "failed"
        d.error = message[:2000]
        d.processed_at = timezone.now()
        d.save(update_fields=["status", "error", "processed_at", "updated_at"])


# ─── server renders with layers hidden (the large-drawing path) ─────────────


def variant_key(d, hidden, hide_text: bool) -> str:
    """Cache key of a render with ``hidden`` layers left out: the hidden set,
    the text switch and the rendered file it derives from."""
    body = json.dumps(
        {"h": sorted(set(hidden)), "t": bool(hide_text), "r": d.rendered.name or ""},
        separators=(",", ":"),
    )
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:24]


class TooManyRenders(Exception):
    """MAX_QUEUED_VARIANTS renders of the drawing are already queued."""


def in_flight(stamp: str, now=None) -> bool:
    """Whether a render queued at ``stamp`` (ISO time) may still be running:
    one queued longer than JOB_TIMEOUT ago was lost (a worker died) and may
    be queued again."""
    from datetime import datetime, timedelta

    try:
        at = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return False
    return at > (now or timezone.now()) - timedelta(seconds=JOB_TIMEOUT)


def request_variant(d, hidden, hide_text: bool) -> tuple[str, dict, bool]:
    """``(key, entry, queued)``: the cached render for this hidden set, or a
    newly queued one. Keeps at most MAX_VARIANTS, dropping the oldest.

    The drawing row is locked while deciding, so identical requests arriving
    together queue one job; :class:`TooManyRenders` when MAX_QUEUED_VARIANTS
    others are still in flight."""
    with transaction.atomic():
        locked = type(d).objects.select_for_update().get(pk=d.pk)
        d.variants = locked.variants
        return _request_variant(d, hidden, hide_text)


def _request_variant(d, hidden, hide_text: bool) -> tuple[str, dict, bool]:
    key = variant_key(d, hidden, hide_text)
    variants = dict(d.variants or {})
    entry = variants.get(key)
    now = timezone.now()
    if entry and (
        entry.get("status") == "ready"
        or (entry.get("status") == "queued" and in_flight(entry.get("at"), now))
    ):
        return key, entry, False
    queued = sum(
        1 for k, v in variants.items()
        if k != key and v.get("status") == "queued" and in_flight(v.get("at"), now)
    )
    if queued >= MAX_QUEUED_VARIANTS:
        raise TooManyRenders
    stale = []
    while len(variants) >= MAX_VARIANTS:
        oldest = min(variants, key=lambda k: variants[k].get("at", ""))
        if variants[oldest].get("file"):
            stale.append(variants[oldest]["file"])
        del variants[oldest]
    entry = {
        "status": "queued", "hidden_layers": sorted(set(hidden)), "hide_text": bool(hide_text),
        "at": now.isoformat(), "file": "", "bytes": 0, "elements": 0,
        "simplified": [], "error": "",
    }
    variants[key] = entry
    type(d).objects.filter(pk=d.pk).update(variants=variants)
    d.variants = variants
    if stale:
        transaction.on_commit(lambda: delete_names(stale))
    enqueue(d.pk, d.source.name, variant=key)
    return key, entry, True


def run_variant(drawing_id: str, source_name: str, key: str) -> None:
    """RQ job: render the drawing with a variant's layers left out."""
    d = _current(drawing_id, source_name)
    if d is None or key not in (d.variants or {}):
        return
    spec = d.variants[key]
    try:
        with tempfile.TemporaryDirectory(prefix="danbyte-cad-") as tmp:
            # Framed by the full drawing's extents: the canvas lays the
            # variant over the full render's box, so its viewBox must match
            # even when the hidden layers held the edges.
            meta, svg = _render(
                d, tmp, hidden=spec.get("hidden_layers") or [],
                hide_text=bool(spec.get("hide_text")),
                extents=d.extents if isinstance(d.extents, dict) else None,
            )
        outcome = {"status": "ready", "bytes": len(svg), "elements": meta["elements"],
                   "simplified": meta["simplified"], "error": ""}
    except ValueError as exc:
        svg, outcome = None, {"status": "failed", "error": str(exc)[:2000]}
    except Exception:  # noqa: BLE001
        logger.exception("CAD variant render failed for %s", drawing_id)
        svg, outcome = None, {"status": "failed", "error": "The drawing could not be rendered."}
    with transaction.atomic():
        from .models import FloorPlanDrawing

        d = _current(drawing_id, source_name)
        if d is None:
            return
        d = FloorPlanDrawing.objects.select_for_update().get(pk=d.pk)
        if key not in (d.variants or {}):
            return
        if svg is not None:
            name = d.rendered.storage.save(
                f"floor-plans/cad/{d.floor_plan_id}/variant-{key}.svg", ContentFile(svg)
            )
            outcome["file"] = name
        variants = dict(d.variants)
        variants[key] = {**variants[key], **outcome}
        FloorPlanDrawing.objects.filter(pk=d.pk).update(variants=variants)


# ─── files ──────────────────────────────────────────────────────────────────


def folder(plan_id) -> str:
    return f"floor-plans/cad/{plan_id}"


def delete_names(names) -> None:
    from django.core.files.storage import default_storage

    for name in names:
        if not name or not name.startswith("floor-plans/cad/"):
            continue
        try:
            default_storage.delete(name)
        except Exception:  # noqa: BLE001 - a missing file is fine
            logger.warning("could not delete %s", name)


def delete_folder(plan_id) -> None:
    """Remove every file of a plan's drawing."""
    from django.core.files.storage import default_storage

    base = folder(plan_id)
    try:
        _dirs, files = default_storage.listdir(base)
    except (FileNotFoundError, NotADirectoryError, OSError):
        return
    delete_names(f"{base}/{f}" for f in files)
    try:
        path = default_storage.path(base)
    except NotImplementedError:
        return
    try:
        os.rmdir(path)
    except OSError:
        pass


# ─── placement maths the canvas uses ────────────────────────────────────────


def size_units(d) -> tuple[float, float]:
    ext = d.extents if isinstance(d.extents, dict) else None
    if not ext:
        return 0.0, 0.0
    return (max(ext["max_x"] - ext["min_x"], 0.0), max(ext["max_y"] - ext["min_y"], 0.0))


def placed_box_mm(d) -> dict:
    """The drawing's box on the plan in mm, after rotation:
    ``{"x", "y", "width", "height"}``."""
    w, h = size_units(d)
    s = d.mm_per_unit
    p = d.placement or {}
    rot = int(p.get("rotation", 0) or 0)
    if rot in (90, 270):
        w, h = h, w
    return {"x": float(p.get("x_mm", 0) or 0), "y": float(p.get("y_mm", 0) or 0),
            "width": w * s, "height": h * s}


def _n(v: float) -> str:
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def transform_mm(d) -> str:
    """The SVG transform that places the drawing (viewBox units) on the plan
    in millimetres: the rotated box's top-left at (x_mm, y_mm), rotated about
    its centre."""
    w, h = size_units(d)
    box = placed_box_mm(d)
    s = d.mm_per_unit
    rot = int((d.placement or {}).get("rotation", 0) or 0)
    return (
        f"translate({_n(box['x'] + box['width'] / 2)} {_n(box['y'] + box['height'] / 2)}) "
        f"rotate({rot}) scale({_n(s)}) translate({_n(-w / 2)} {_n(-h / 2)})"
    )


def fit(d, cell_mm: int) -> dict:
    """The grid that covers the drawing placed at the origin, in ``cell_mm``
    cells; ``fits`` is False when that needs more than 512 cells a side,
    and ``min_cell_mm`` is the smallest cell that would fit."""
    box = placed_box_mm(d)
    longest = max(box["width"], box["height"])
    gw = max(1, math.ceil(box["width"] / cell_mm - 1e-9)) if box["width"] else 1
    gh = max(1, math.ceil(box["height"] / cell_mm - 1e-9)) if box["height"] else 1
    return {
        "grid_width": gw,
        "grid_height": gh,
        "fits": gw <= 512 and gh <= 512,
        "min_cell_mm": max(50, math.ceil(longest / 512)) if longest else 50,
    }
