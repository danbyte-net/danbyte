"""Bounded, streaming readers for uploaded vulnerability files (#451).

An NVD year feed is hundreds of megabytes of JSON once unpacked, an OSV
ecosystem zip holds tens of thousands of files. Nothing here loads a whole
file: JSON arrays are walked one element at a time with the standard
library's ``JSONDecoder.raw_decode`` (decision 20 - no new dependency), and
every reader has a hard ceiling so a gzip or zip bomb, a single huge record
or deeply nested JSON stops with a clear error instead of filling memory.

Pure Python, no Django.
"""
from __future__ import annotations

import codecs
import gzip
import io
import json
import zipfile
from collections.abc import Iterator

GZIP_MAGIC = b"\x1f\x8b"
ZIP_MAGIC = b"PK\x03\x04"

_WS = " \t\r\n"


class ImportFormatError(ValueError):
    """The file is not what its kind expects; the message is for the user."""


class LimitExceeded(ImportFormatError):
    """A size, count or depth limit was reached."""


class CappedReader(io.RawIOBase):
    """Reads at most ``limit`` bytes from ``raw``; one byte more raises."""

    def __init__(self, raw, limit: int, what: str = "The file"):
        self._raw = raw
        self._left = limit
        self._limit = limit
        self._what = what

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            size = 1 << 20
        chunk = self._raw.read(min(size, self._left + 1))
        self._left -= len(chunk)
        if self._left < 0:
            mb = self._limit // (1024 * 1024)
            raise LimitExceeded(f"{self._what} unpacks to more than {mb} MB.")
        return chunk

    def readinto(self, b) -> int:
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def sniff(fileobj) -> str:
    """``gzip``, ``zip`` or ``plain`` from the first bytes; rewinds."""
    head = fileobj.read(4)
    fileobj.seek(0)
    if head[:2] == GZIP_MAGIC:
        return "gzip"
    if head == ZIP_MAGIC:
        return "zip"
    return "plain"


def open_stream(fileobj, *, max_bytes: int, what: str = "The file"):
    """A binary reader over ``fileobj``, gunzipped when it is gzip, capped at
    ``max_bytes`` of (unpacked) content. Zip files go through
    :func:`iter_zip_members`."""
    kind = sniff(fileobj)
    if kind == "zip":
        raise ImportFormatError(f"{what} is a zip archive; this kind takes JSON or gzip.")
    if kind == "gzip":
        return CappedReader(gzip.GzipFile(fileobj=fileobj, mode="rb"), max_bytes, what)
    return CappedReader(fileobj, max_bytes, what)


def iter_zip_members(path_or_file, *, suffixes: tuple[str, ...], max_members: int,
                     max_member_bytes: int, max_total_bytes: int
                     ) -> Iterator[tuple[str, CappedReader]]:
    """``(name, reader)`` for each member whose name ends in one of
    ``suffixes``. Each reader is capped at ``max_member_bytes`` and all of
    them together at ``max_total_bytes``, whatever the headers claim."""
    try:
        archive = zipfile.ZipFile(path_or_file)
    except (zipfile.BadZipFile, OSError) as exc:
        raise ImportFormatError("Not a readable zip archive.") from exc
    with archive:
        infos = archive.infolist()
        if len(infos) > max_members:
            raise LimitExceeded(f"The archive has more than {max_members} files.")
        left = max_total_bytes
        for info in infos:
            if info.is_dir() or not info.filename.lower().endswith(suffixes):
                continue
            if info.flag_bits & 0x1:
                raise ImportFormatError("Encrypted archives are not supported.")
            if info.file_size > max_member_bytes:
                raise LimitExceeded(f"{info.filename} is larger than the per-file limit.")
            if left <= 0:
                raise LimitExceeded("The archive unpacks to more than the total limit.")
            try:
                raw = archive.open(info)
            except (zipfile.BadZipFile, NotImplementedError, OSError) as exc:
                raise ImportFormatError(f"{info.filename} cannot be read.") from exc
            reader = CappedReader(raw, min(max_member_bytes, left), info.filename)
            with raw:
                yield info.filename, reader
            left -= reader._limit - max(reader._left, 0)


class JsonStream:
    """Walks one JSON document from a binary reader without loading it.

    Only the containers the caller asks to enter are streamed; every other
    value (a record, a header field) is decoded whole and must fit in
    ``value_cap`` characters.
    """

    def __init__(self, reader, *, value_cap: int, chunk: int = 1 << 20):
        self._reader = reader
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._json = json.JSONDecoder()
        self._buf = ""
        self._pos = 0
        self._eof = False
        self._chunk = chunk
        self._cap = value_cap
        self._started = False

    # ── buffer ──
    def _fill(self) -> bool:
        if self._eof:
            return False
        try:
            data = self._reader.read(self._chunk)
        except (OSError, EOFError, gzip.BadGzipFile, zipfile.BadZipFile) as exc:
            raise ImportFormatError("The file is truncated or corrupt.") from exc
        if self._pos > self._chunk:
            self._buf = self._buf[self._pos:]
            self._pos = 0
        try:
            text = self._decoder.decode(data, final=not data)
        except UnicodeDecodeError as exc:
            raise ImportFormatError("The file is not UTF-8 text.") from exc
        if not self._started:
            text = text.lstrip("﻿")
            self._started = bool(text)
        self._buf += text
        if not data:
            self._eof = True
        return True

    def _skip_ws(self) -> None:
        while True:
            while self._pos < len(self._buf) and self._buf[self._pos] in _WS:
                self._pos += 1
            if self._pos < len(self._buf) or not self._fill():
                return

    def peek(self) -> str:
        """The next non-whitespace character, ``""`` at the end."""
        self._skip_ws()
        return self._buf[self._pos] if self._pos < len(self._buf) else ""

    def expect(self, chars: str) -> str:
        ch = self.peek()
        if not ch or ch not in chars:
            found = repr(ch) if ch else "the end of the file"
            raise ImportFormatError(f"Malformed JSON: expected {chars!r}, found {found}.")
        self._pos += 1
        return ch

    def value(self, cap: int | None = None):
        """Decode the next complete value (at most ``cap`` characters)."""
        cap = self._cap if cap is None else cap
        self._skip_ws()
        while True:
            try:
                value, end = self._json.raw_decode(self._buf, self._pos)
            except json.JSONDecodeError:
                end = None
            except RecursionError:
                raise LimitExceeded("The JSON is nested too deeply.") from None
            # A scalar cut at the end of the buffer ("12" of "1234") decodes
            # too: it is only complete when something follows it.
            if end is not None and (end < len(self._buf) or self._eof):
                if end - self._pos > cap:
                    raise LimitExceeded(f"A single record is larger than {cap // 1024} KB.")
                self._pos = end
                return value
            if len(self._buf) - self._pos > cap:
                raise LimitExceeded(f"A single record is larger than {cap // 1024} KB.")
            if not self._fill():
                raise ImportFormatError("Malformed JSON or a truncated file.")

    def end(self) -> None:
        if self.peek():
            raise ImportFormatError("Unexpected data after the JSON document.")

    # ── containers ──
    def iter_array(self, max_items: int) -> Iterator:
        """Each element of the array that starts here."""
        self.expect("[")
        if self.peek() == "]":
            self._pos += 1
            return
        count = 0
        while True:
            count += 1
            if count > max_items:
                raise LimitExceeded(f"More than {max_items} records.")
            yield self.value()
            if self.expect(",]") == "]":
                return

    def iter_object(self, *, stream_keys: set[str], header_cap: int, max_items: int,
                    header: dict) -> Iterator[tuple[str, object]]:
        """Walk the object that starts here. A key in ``stream_keys`` yields
        ``(key, element)`` per element of its array (and sets ``header[key]``
        to ``...``); any other key's value is decoded (``header_cap``) into
        ``header``."""
        self.expect("{")
        if self.peek() == "}":
            self._pos += 1
            return
        while True:
            key = self.value(cap=1024)
            if not isinstance(key, str):
                raise ImportFormatError("Malformed JSON: an object key is not a string.")
            self.expect(":")
            if key in stream_keys:
                # The key is marked as seen, so an empty list is told apart
                # from a missing one.
                header[key] = ...
                if self.peek() != "[":
                    raise ImportFormatError(f"'{key}' is not a list.")
                for item in self.iter_array(max_items):
                    yield key, item
            else:
                header[key] = self.value(cap=header_cap)
            if self.expect(",}") == "}":
                return
