"""Release version ordering: pre-releases sort below their final, describe
output keeps the pre-release, and a note for a release applies on its
pre-releases."""
from __future__ import annotations

from unittest.mock import patch

from django.test import SimpleTestCase

from core import upgrade_notes as un
from core import version as v


class CleanVersionTests(SimpleTestCase):
    def test_describe_forms(self):
        cases = {
            "v0.16.13": "0.16.13",
            "v0.16.13-3-g1234567": "0.16.13",
            "v0.17.0-dev1": "0.17.0-dev1",
            "v0.17.0-dev1-5-gabc1234": "0.17.0-dev1",
            "v0.17.0-dev1-5-gabc1234-dirty": "0.17.0-dev1",
            "0.17.0-rc2": "0.17.0-rc2",
            "": "",
        }
        for raw, want in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(v.clean_version(raw), want)

    def test_system_version_keeps_the_prerelease(self):
        with patch("core.version._git", return_value="v0.17.0-dev1-5-gabc1234"):
            self.assertEqual(v.system_version()["version"], "0.17.0-dev1")
        with patch("core.version._git", return_value=""), \
             patch("core.version.__version__", "0.17.0-dev2"):
            self.assertEqual(v.system_version()["version"], "0.17.0-dev2")


class OrderingTests(SimpleTestCase):
    def test_prereleases_sort_below_their_final(self):
        chain = ["0.16.13", "v0.17.0-dev1", "0.17.0-dev2", "v0.17.0-rc1", "0.17.0", "v0.17.1"]
        for older, newer in zip(chain, chain[1:], strict=False):
            with self.subTest(older=older, newer=newer):
                self.assertTrue(v.is_newer(newer, older))
                self.assertFalse(v.is_newer(older, newer))
        self.assertEqual(sorted(reversed(chain), key=v.parse_version), chain)

    def test_equal_versions_are_not_newer(self):
        self.assertFalse(v.is_newer("v0.17.0-dev1", "0.17.0-dev1"))
        self.assertEqual(v.compare_versions("v0.17.0", "0.17.0"), 0)
        self.assertEqual(v.compare_versions("v0.17.0-dev1-3-gabc1234", "0.17.0-dev1"), 0)

    def test_unparseable_versions_fall_back_to_numbers(self):
        self.assertTrue(v.is_newer("v0.18.0-weird+thing!", "0.17.0"))
        self.assertFalse(v.is_newer("uploaded", "0.17.0"))
        self.assertFalse(v.is_newer("", "0.17.0"))
        self.assertEqual(v.compare_versions("0.17.0-weird!", "0.17.0-dev1"), 0)

    def test_prerelease_and_core(self):
        self.assertTrue(v.is_prerelease("v0.17.0-dev2"))
        self.assertFalse(v.is_prerelease("v0.17.0"))
        self.assertFalse(v.is_prerelease("uploaded"))
        self.assertEqual(v.release_core("v0.17.0-dev2"), "0.17.0")
        self.assertEqual(v.release_core("0.16.13"), "0.16.13")


class NotesOnPreReleasesTests(SimpleTestCase):
    NOTE = un.UpgradeNote(id="0.17.0-x", version="0.17.0", title="X", body="x",
                          platforms=("systemd",))

    def test_a_release_note_applies_on_its_prereleases(self):
        with patch.object(un, "NOTES", (self.NOTE,)):
            for running in ("0.17.0-dev1", "0.17.0", "0.17.3"):
                with self.subTest(running=running):
                    self.assertEqual([n.id for n in un.applicable(running, "systemd")],
                                     ["0.17.0-x"])
                    self.assertEqual(un.ids_up_to(running), ["0.17.0-x"])
            self.assertEqual(un.applicable("0.16.13", "systemd"), [])
            self.assertEqual(un.ids_up_to("0.16.13"), [])
