"""The run itself: parameters in, log and files out.

Anything printed already reaches the run log; ``run.log`` adds a timestamp
and flushes, which is what you want in a loop. Files written through
``run.output`` land on the run's page as downloads.
"""
from __future__ import annotations

import csv
import io
import json
import os
import sys
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import Any


class ScriptFailure(RuntimeError):
    """Raised by :meth:`Run.fail` - ends the run as failed with a message."""


def _safe_name(name: str) -> str:
    base = os.path.basename(str(name)).strip() or "output"
    return "".join(c for c in base if c.isalnum() or c in "._- ").strip() or "output"


class Run:
    """The current run. Import the module-level ``run``; constructing your
    own is only useful in tests."""

    def __init__(self, params: dict | None = None, output_dir: str = "", run_id: str = ""):
        self._params = params
        self.output_dir = output_dir or os.environ.get("DANBYTE_OUTPUT_DIR", "")
        self.id = run_id or os.environ.get("DANBYTE_RUN_ID", "")

    @property
    def params(self) -> dict:
        """What the Run dialog (or the schedule) passed in."""
        if self._params is None:
            raw = os.environ.get("DANBYTE_PARAMS", "")
            if not raw and not sys.stdin.isatty():
                raw = sys.stdin.read()
            try:
                self._params = json.loads(raw) if raw.strip() else {}
            except ValueError:
                self._params = {}
        return self._params

    def param(self, name: str, default: Any = None) -> Any:
        return self.params.get(name, default)

    def log(self, *parts: Any) -> None:
        stamp = datetime.now(UTC).strftime("%H:%M:%S")
        print(stamp, *parts, flush=True)

    def fail(self, message: str) -> None:
        """End the run as failed. The message is the run's error."""
        raise ScriptFailure(message)

    # ─── outputs ────────────────────────────────────────────────────────

    def output(self, name: str, content: bytes | str) -> str:
        """Write a file for download from the run page. Returns its path."""
        if not self.output_dir:
            raise RuntimeError("No output directory - is this running inside Danbyte?")
        os.makedirs(self.output_dir, exist_ok=True)
        path = os.path.join(self.output_dir, _safe_name(name))
        data = content.encode() if isinstance(content, str) else content
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def output_csv(self, name: str, rows: Iterable[dict | Sequence],
                   fields: Sequence[str] | None = None) -> str:
        """A CSV from dicts (header from ``fields``, or the first row's keys)
        or from plain sequences."""
        rows = list(rows)
        buf = io.StringIO()
        if rows and isinstance(rows[0], dict):
            names = list(fields) if fields else list(rows[0].keys())
            writer = csv.DictWriter(buf, fieldnames=names, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow(row)
        else:
            writer = csv.writer(buf)
            if fields:
                writer.writerow(fields)
            writer.writerows(rows)
        name = name if name.lower().endswith(".csv") else f"{name}.csv"
        return self.output(name, buf.getvalue())

    def output_json(self, name: str, data: Any) -> str:
        name = name if name.lower().endswith(".json") else f"{name}.json"
        return self.output(name, json.dumps(data, indent=2, default=str))


run = Run()
