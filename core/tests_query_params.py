"""The unknown-parameter headers stay small whatever the client sends (#503)."""
from __future__ import annotations

from urllib.parse import unquote

from django.test import SimpleTestCase

from core.query_params import (
    _MAX_HEADER_BYTES,
    _MAX_NAME_BYTES,
    _WARNING,
    _header_name,
    _header_value,
)


class HeaderValueTests(SimpleTestCase):
    def assertSmall(self, value):
        value.encode("ascii")  # raises on anything but ASCII
        self.assertNotIn("\r", value)
        self.assertNotIn("\n", value)
        self.assertLessEqual(len(value), _MAX_HEADER_BYTES)
        self.assertLessEqual(len(_WARNING.format(value)), _MAX_HEADER_BYTES)

    def test_short_names_are_unchanged(self):
        self.assertEqual(_header_value(["device_id", "foo"]), "device_id, foo")

    def test_a_long_name_is_cut_with_a_marker(self):
        value = _header_value(["x" * 1800])
        self.assertSmall(value)
        self.assertLessEqual(len(value), _MAX_NAME_BYTES)
        self.assertTrue(unquote(value).endswith("…"))
        self.assertTrue(value.startswith("x" * 50))

    def test_twenty_long_names_end_in_a_count(self):
        names = [f"filter_{i:02d}_" + "z" * 90 for i in range(20)]
        value = _header_value(names)
        self.assertSmall(value)
        parts = value.split(", ")
        shown = len(parts) - 1
        self.assertGreater(shown, 0)
        self.assertEqual(parts[-1], f"+{20 - shown} more")
        self.assertTrue(parts[0].startswith("filter_00_"))

    def test_more_than_twenty_names_are_counted(self):
        names = [f"p{i}" for i in range(25)]
        value = _header_value(names)
        self.assertSmall(value)
        self.assertTrue(value.endswith(", +5 more"))
        self.assertEqual(value.split(", ")[:2], ["p0", "p1"])

    def test_non_ascii_names_are_encoded_and_cut_on_a_character(self):
        name = "æøå\U0001F600" * 40
        enc = _header_name(name)
        self.assertSmall(enc)
        self.assertLessEqual(len(enc), _MAX_NAME_BYTES)
        # Cut between characters: the remainder decodes cleanly.
        decoded = unquote(enc, errors="strict")
        self.assertTrue(decoded.endswith("…"))
        self.assertTrue(name.startswith(decoded[:-1]))

    def test_cr_lf_names_stay_encoded(self):
        value = _header_value(["a\r\nSet-Cookie: x=1", "b\n" * 200])
        self.assertSmall(value)
        self.assertIn("a%0D%0ASet-Cookie", value)

    def test_lone_surrogate_does_not_raise(self):
        self.assertSmall(_header_value(["bad\udcff"]))
