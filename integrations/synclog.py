"""Capture one sync run's log onto the row that ran it.

The rotating ``/var/log/danbyte/danbyte.log`` (``DANBYTE_LOG_DIR``) and the
journal already receive everything - but a user reporting a sync problem
usually can't shell into the box, and on Docker "the log file" is three
containers away. So each run's lines are also captured and stored on the
source itself, where the UI can show them with a copy button: *open the
source page, copy the sync log, paste it into the issue.*

Bounded (last ``MAX_LINES`` lines) so a huge estate can't bloat the row, and
attached per-thread so two sources syncing in parallel workers don't
interleave into each other's capture.
"""
from __future__ import annotations

import logging
import threading
from contextlib import contextmanager

MAX_LINES = 1000

#: Loggers whose records belong in a virt sync run's capture.
_LOGGER_NAMES = ("danbyte.virt_sync", "danbyte.external_sync")


class _BufferHandler(logging.Handler):
    """Collects formatted records for the thread that created it."""

    def __init__(self):
        super().__init__(level=logging.INFO)
        self.lines: list[str] = []
        self._thread = threading.get_ident()
        self.setFormatter(
            logging.Formatter("{asctime} {levelname} {message}", style="{")
        )

    def emit(self, record: logging.LogRecord) -> None:
        if threading.get_ident() != self._thread:
            return  # another worker's run - not ours to record
        if len(self.lines) >= MAX_LINES:
            if len(self.lines) == MAX_LINES:
                self.lines.append(f"... truncated at {MAX_LINES} lines")
            return
        try:
            self.lines.append(self.format(record))
        except Exception:  # noqa: BLE001 - logging must never break the sync
            pass


@contextmanager
def capture_sync_log():
    """Collect this thread's sync log lines; yields the handler.

    Read ``handler.text()`` afterwards. Console/file handlers are untouched -
    this is an additional listener, not a redirect.
    """
    handler = _BufferHandler()
    loggers = [logging.getLogger(n) for n in _LOGGER_NAMES]
    for lg in loggers:
        lg.addHandler(handler)
    try:
        yield handler
    finally:
        for lg in loggers:
            lg.removeHandler(handler)


def text_of(handler: _BufferHandler) -> str:
    return "\n".join(handler.lines)
