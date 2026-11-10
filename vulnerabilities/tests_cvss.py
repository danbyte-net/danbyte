"""CVSS 3.x base score calculator against published vectors and scores."""
from __future__ import annotations

from decimal import Decimal

from django.test import SimpleTestCase

from . import cvss

#: (vector, base score) - scores as published by NVD / the FIRST calculator.
KNOWN = [
    # CVE-2023-20198 (Cisco IOS XE web UI), CVE-2021-44228 (Log4Shell)
    ("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", "10.0"),
    # CVE-2024-10979 (PostgreSQL PL/Perl)
    ("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", "8.8"),
    # CVE-2025-1094 (PostgreSQL libpq)
    ("CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H", "8.1"),
    ("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "9.8"),
    # CVE-2014-0160 (Heartbleed) rescored under 3.x
    ("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", "7.5"),
    ("CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", "7.8"),
    ("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N", "5.3"),
    # Scope changed: the reflected and stored XSS classics, local escape.
    ("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", "6.1"),
    ("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N", "6.4"),
    ("CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N", "5.4"),
    ("CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H", "8.8"),
    ("CVSS:3.1/AV:A/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "8.8"),
    ("CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N", "3.1"),
    # No impact is 0.0 whatever the exploitability.
    ("CVSS:3.1/AV:P/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N", "0.0"),
]


class BaseScoreTests(SimpleTestCase):
    def test_published_vectors(self):
        for vector, score in KNOWN:
            with self.subTest(vector=vector):
                self.assertEqual(cvss.base_score(vector), Decimal(score))

    def test_temporal_metrics_do_not_change_the_base_score(self):
        self.assertEqual(
            cvss.base_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:P/RL:O/RC:C"),
            Decimal("9.8"))

    def test_invalid_vectors_raise(self):
        for vector in (
            "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",           # no prefix
            "CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P",            # not 3.x
            "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H",       # A missing
            "CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",   # bad value
            "CVSS:3.1/AV:N/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
            "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/ZZ:1",
            "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:Q/C:H/I:H/A:H",
            None,
        ):
            with self.subTest(vector=vector), self.assertRaises(cvss.CvssError):
                cvss.base_score(vector)

    def test_mismatch_is_refused(self):
        vector = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"  # 7.5
        self.assertEqual(cvss.matches(vector, 7.5), (True, Decimal("7.5")))
        ok, recomputed = cvss.matches(vector, 9.8)
        self.assertFalse(ok)
        self.assertEqual(recomputed, Decimal("7.5"))
        self.assertEqual(cvss.matches("CVSS:3.1/garbage", 7.5), (False, None))

    def test_severity_scale(self):
        self.assertEqual(cvss.severity(Decimal("0.0"), "3.1"), "none")
        self.assertEqual(cvss.severity(Decimal("3.9"), "3.1"), "low")
        self.assertEqual(cvss.severity(Decimal("4.0"), "3.1"), "medium")
        self.assertEqual(cvss.severity(Decimal("7.0"), "3.1"), "high")
        self.assertEqual(cvss.severity(Decimal("9.0"), "4.0"), "critical")
        self.assertEqual(cvss.severity(Decimal("10.0"), "2.0"), "high")
        self.assertEqual(cvss.severity(None, "3.1"), "")

    def test_attack_vector(self):
        self.assertEqual(cvss.attack_vector("CVSS:3.1/AV:A/AC:L"), "adjacent")
        self.assertEqual(cvss.attack_vector("AV:L/AC:L/Au:N/C:P/I:P/A:P"), "local")
        self.assertEqual(cvss.attack_vector("CVSS:4.0/AV:P/AC:L"), "physical")
        self.assertEqual(cvss.attack_vector(""), "")
