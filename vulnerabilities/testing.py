"""Test helpers for the vulnerabilities app."""
from __future__ import annotations

import io
from contextlib import contextmanager
from pathlib import Path

from . import products

TESTDATA = Path(__file__).resolve().parent / "testdata"

IOS_XE = ("cpe", "o", "cisco", "ios_xe")
POSTGRES = ("cpe", "a", "postgresql", "postgresql")
DJANGO = ("purl", "", "pypi", "django")


def data(name: str) -> bytes:
    return (TESTDATA / name).read_bytes()


@contextmanager
def tracking(*keys):
    """Track ``keys`` (product keys) for the duration of the block."""
    def provider():
        return list(keys)

    products.register_provider(provider)
    try:
        yield
    finally:
        products.unregister_provider(provider)


class Trickle(io.RawIOBase):
    """A reader that hands out at most ``step`` bytes per read, so a parser
    sees records split across read boundaries."""

    def __init__(self, raw: bytes, step: int = 7):
        self._buf = io.BytesIO(raw)
        self._step = step

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def seek(self, pos: int, whence: int = 0) -> int:
        return self._buf.seek(pos, whence)

    def read(self, size: int = -1) -> bytes:
        return self._buf.read(self._step if size < 0 else min(size, self._step))

    def readinto(self, b) -> int:
        data_ = self.read(len(b))
        b[: len(data_)] = data_
        return len(data_)
