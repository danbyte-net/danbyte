"""Version keys per scheme, against published comparison cases."""
from __future__ import annotations

from django.test import SimpleTestCase

from .versions import auto_scheme, compare, parse


def cmp(a: str, b: str, scheme: str):
    ka, kb = parse(a, scheme), parse(b, scheme)
    assert ka is not None, f"{scheme}: {a!r} did not parse"
    assert kb is not None, f"{scheme}: {b!r} did not parse"
    return compare(ka, kb)


class OrderingMixin:
    scheme = ""

    def assertOrdered(self, *items):
        for a, b in zip(items, items[1:], strict=False):
            with self.subTest(a=a, b=b):
                self.assertEqual(cmp(a, b, self.scheme), -1, f"{a} < {b}")
                self.assertEqual(cmp(b, a, self.scheme), 1, f"{b} > {a}")

    def assertSame(self, a, b):
        with self.subTest(a=a, b=b):
            self.assertEqual(cmp(a, b, self.scheme), 0)

    def assertUnreadable(self, *values):
        for v in values:
            with self.subTest(v=v):
                self.assertIsNone(parse(v, self.scheme))


class IosXeTests(OrderingMixin, SimpleTestCase):
    scheme = "cisco_iosxe"

    def test_letters_after_the_number(self):
        self.assertOrdered("16.12.10a", "17.6.5", "17.9.4", "17.9.4a", "17.9.4b",
                           "17.9.5", "17.12.1")

    def test_zero_padding(self):
        self.assertSame("17.09.04a", "17.9.4a")
        self.assertEqual(parse("17.09.04a", self.scheme).text, "17.9.4a")

    def test_unreadable(self):
        self.assertUnreadable("", "IOS-XE", "17", "17.9.4 extra")


class IosTests(OrderingMixin, SimpleTestCase):
    scheme = "cisco_ios"

    def test_within_a_train(self):
        self.assertOrdered("15.2(4)E10", "15.2(7)E", "15.2(7)E1", "15.2(7)E8", "15.2(7)E10")
        self.assertOrdered("12.2(55)SE", "12.2(55)SE12", "12.2(58)SE2")

    def test_cpe_form_and_case(self):
        self.assertSame("15.2(7)E8", "15.2(7)e8")
        self.assertEqual(parse("15.2(7)E8", self.scheme).text, "15.2(7)e8")

    def test_trains_are_not_comparable(self):
        self.assertIsNone(cmp("15.2(7)E8", "15.2(4)M10", self.scheme))
        self.assertIsNone(cmp("15.2(7)E8", "15.0(2)E8", self.scheme))

    def test_unreadable(self):
        self.assertUnreadable("15.2.7", "IOS 15", "17.9.4a")


class NxosTests(OrderingMixin, SimpleTestCase):
    scheme = "cisco_nxos"

    def test_order(self):
        self.assertOrdered("7.0(3)I7(8)", "7.0(3)I7(9)", "9.3(9)", "9.3(10)", "10.2(5)M",
                           "10.2(6)M")
        self.assertOrdered("5.2(1)N1(1)", "5.2(1)N1(1b)", "5.2(1)N1(2)")

    def test_feature_and_maintenance_tags(self):
        self.assertSame("10.2(5)M", "10.2(5)")
        self.assertSame("10.2(5)m", "10.2(5)M")

    def test_unreadable(self):
        self.assertUnreadable("9.3", "NX-OS 9")


class JunosTests(OrderingMixin, SimpleTestCase):
    scheme = "junos"

    def test_release_and_service(self):
        self.assertOrdered("21.4", "21.4R1", "21.4R1-S1", "21.4R2", "21.4R3-S5",
                           "21.4R3-S9", "22.1R1", "22.2R1")

    def test_build_dropped_and_cpe_update_form(self):
        self.assertSame("21.4R3-S5.4", "21.4r3-s5")
        self.assertEqual(parse("21.4R3-S5.4", self.scheme).text, "21.4r3-s5")
        self.assertSame("19.1R1.6", "19.1r1")

    def test_x_trains_are_their_own(self):
        self.assertOrdered("15.1X49-D100", "15.1X49-D200")
        self.assertIsNone(cmp("15.1X49-D200", "15.1R7", self.scheme))

    def test_unreadable(self):
        self.assertUnreadable("JUNOS", "21", "21.4Q1")


class EosTests(OrderingMixin, SimpleTestCase):
    scheme = "arista_eos"

    def test_numbers(self):
        self.assertOrdered("4.23.0.1F", "4.28.3M", "4.28.10M", "4.30.1F")

    def test_train_letter_is_a_tag(self):
        self.assertSame("4.28.3M", "4.28.3F")
        self.assertSame("4.28.3M", "4.28.3m")


class SemverTests(OrderingMixin, SimpleTestCase):
    scheme = "semver"

    def test_semver_spec_precedence(self):
        # semver.org, section 11.
        self.assertOrdered("1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
                           "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0")
        self.assertOrdered("1.0.0", "2.0.0", "2.1.0", "2.1.1")

    def test_build_metadata_and_trailing_zeros(self):
        self.assertSame("1.0.0+20130313144700", "1.0.0")
        self.assertSame("16.4", "16.4.0")

    def test_loose_forms(self):
        self.assertSame("14.13 (Debian 14.13-1.pgdg120+1)", "14.13")
        self.assertSame("v1.24.0", "1.24.0")
        self.assertOrdered("1.1.1", "1.1.1a", "1.1.1w", "1.1.2")
        self.assertOrdered("9.6beta1", "9.6rc1", "9.6")
        self.assertOrdered("1.0rc2", "1.0rc10")

    def test_unreadable(self):
        self.assertUnreadable("latest", "abc1", "1.0_beta", "")


class Pep440Tests(OrderingMixin, SimpleTestCase):
    scheme = "pep440"

    def test_pre_post_dev(self):
        # PEP 440's own ordering example.
        self.assertOrdered("1.0.dev456", "1.0a1", "1.0a2.dev456", "1.0a12.dev456", "1.0a12",
                           "1.0b1.dev456", "1.0b2", "1.0b2.post345.dev456", "1.0b2.post345",
                           "1.0rc1.dev456", "1.0rc1", "1.0", "1.0+abc.5", "1.0.post456.dev34",
                           "1.0.post456", "1.1.dev1")

    def test_normalised(self):
        self.assertSame("5.2", "5.2.0")
        self.assertSame("1.0-RC1", "1.0rc1")
        self.assertEqual(parse("1.0-RC1", self.scheme).text, "1.0rc1")

    def test_epoch(self):
        self.assertOrdered("2024.1", "1!0.1")

    def test_unreadable(self):
        self.assertUnreadable("not a version", "1.0~rc1")


class DpkgTests(OrderingMixin, SimpleTestCase):
    """dpkg's own comparison cases (lib/dpkg/t/t-version.c, deb-version(7))."""

    scheme = "dpkg"

    def test_tilde_sorts_before_everything(self):
        self.assertOrdered("1.0~rc1", "1.0")
        self.assertOrdered("1.0~~", "1.0~~a", "1.0~", "1.0", "1.0a")
        self.assertOrdered("1.0~beta1~svn1245", "1.0~beta1", "1.0")

    def test_epochs(self):
        self.assertOrdered("2.0", "1:0.9")
        self.assertOrdered("1:1.0", "2:0.1")
        self.assertSame("0:1.0", "1.0")

    def test_revisions(self):
        self.assertOrdered("1.0-1", "1.0-2", "1.0-10")
        self.assertOrdered("1.0", "1.0-1")
        self.assertSame("1.0", "1.0-0")
        self.assertOrdered("1.0-1", "1.0-1+deb12u1", "1.0-2")
        self.assertOrdered("1.0", "1.0+deb12u1")

    def test_letters_before_other_characters(self):
        self.assertOrdered("1.0a", "1.0+", "1.0.1")
        self.assertOrdered("1.2.3-1ubuntu1", "1.2.3-1ubuntu2", "1.2.3-2")

    def test_numbers(self):
        self.assertOrdered("1.9", "1.10")
        self.assertSame("1.002", "1.2")
        self.assertOrdered("10.3-3", "10.3-3+deb13u1")

    def test_unreadable(self):
        self.assertUnreadable("abc", "1.0 2", "-1")


class ApkTests(OrderingMixin, SimpleTestCase):
    scheme = "apk"

    def test_suffixes_and_revisions(self):
        self.assertOrdered("1.2.3_alpha1", "1.2.3_beta2", "1.2.3_pre1", "1.2.3_rc1", "1.2.3",
                           "1.2.3-r1", "1.2.3_p1", "1.2.4")
        self.assertOrdered("1.2.3-r0", "1.2.3-r10")
        self.assertOrdered("1.2", "1.2a", "1.2.1")
        self.assertOrdered("3.1.4-r5", "3.3.0-r0")

    def test_unreadable(self):
        self.assertUnreadable("1.2.3-1", "v1", "1.2_foo")


class GenericTests(OrderingMixin, SimpleTestCase):
    scheme = "generic"

    def test_tokens(self):
        self.assertSame("R7.2", "r7.2")
        self.assertOrdered("7.2", "7.10")
        self.assertUnreadable("none")


class AutoSchemeTests(SimpleTestCase):
    def test_auto(self):
        cases = [
            (("cpe", "o", "cisco", "ios"), "cisco_ios"),
            (("cpe", "o", "cisco", "ios_xe"), "cisco_iosxe"),
            (("cpe", "o", "cisco", "nx-os"), "cisco_nxos"),
            (("cpe", "o", "juniper", "junos"), "junos"),
            (("cpe", "o", "arista", "eos"), "arista_eos"),
            (("cpe", "a", "postgresql", "postgresql"), "semver"),
            (("cpe", "o", "fortinet", "fortios"), "generic"),
            (("purl", "", "pypi", "django"), "pep440"),
            (("purl", "", "npm", "lodash"), "semver"),
            (("purl", "", "deb", "debian/openssl"), "dpkg"),
            (("purl", "", "apk", "alpine/openssl"), "apk"),
            (("purl", "", "maven", "org.apache/log4j"), "generic"),
        ]
        for key, scheme in cases:
            with self.subTest(key=key):
                self.assertEqual(auto_scheme(*key), scheme)
