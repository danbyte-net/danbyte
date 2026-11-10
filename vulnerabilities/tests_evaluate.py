"""CPE configurations and OSV ranges against one product at one version."""
from __future__ import annotations

import json

from django.test import SimpleTestCase

from . import evaluate
from .evaluate import Target
from .testing import data


def nvd_configs(cve_id: str) -> list:
    page = json.loads(data("nvd_page.json"))
    for v in page["vulnerabilities"]:
        if v["cve"]["id"] == cve_id:
            return v["cve"].get("configurations") or []
    raise KeyError(cve_id)


def cpe(product="cisco:ios_xe", version="*", update="*", part="o", **bounds) -> dict:
    vendor, name = product.split(":")
    m = {"vulnerable": bounds.pop("vulnerable", True),
         "criteria": f"cpe:2.3:{part}:{vendor}:{name}:{version}:{update}:*:*:*:*:*:*"}
    m.update(bounds)
    return m


def config(*nodes, operator=None) -> list:
    entry = {"nodes": list(nodes)}
    if operator:
        entry["operator"] = operator
    return [entry]


def node(*matches, operator="OR", negate=False) -> dict:
    return {"operator": operator, "negate": negate, "cpeMatch": list(matches)}


def xe(version, **kw) -> Target:
    return Target(kind="cpe", part="o", vendor="cisco", product="ios_xe",
                  scheme=kw.pop("scheme", "cisco_iosxe"), version=version, **kw)


class NvdExactTests(SimpleTestCase):
    def test_cve_2023_20198(self):
        configs = nvd_configs("CVE-2023-20198")
        for version, expected in [("17.9.4", "exact"), ("17.6.5", "exact"),
                                  ("17.09.04", "exact"), ("17.9.4a", None),
                                  ("17.12.1", None), ("", None)]:
            with self.subTest(version=version):
                self.assertEqual(evaluate.match_nvd(configs, xe(version))[0], expected)

    def test_unreadable_version_matches_an_exact_string_only(self):
        configs = config(node(cpe(version="special-build")),
                         )
        conf, flags = evaluate.match_nvd(configs, xe("special-build"))
        self.assertEqual(conf, "exact")
        ranged = config(node(cpe(versionEndExcluding="17.9.5")))
        conf, flags = evaluate.match_nvd(ranged, xe("special-build"))
        self.assertIsNone(conf)
        self.assertIn(evaluate.VERSION_NOT_UNDERSTOOD, flags)

    def test_awaiting_analysis_and_na(self):
        self.assertEqual(evaluate.match_nvd([], xe("17.9.4")), (None, set()))
        self.assertIsNone(evaluate.match_nvd(config(node(cpe(version="-"))), xe("17.9.4"))[0])

    def test_other_product_only(self):
        configs = config(node(cpe(product="cisco:ios", version="15.2\\(7\\)e8")))
        self.assertIsNone(evaluate.match_nvd(configs, xe("17.9.4"))[0])


class NvdRangeTests(SimpleTestCase):
    def pg(self, version):
        return Target(kind="cpe", part="a", vendor="postgresql", product="postgresql",
                      scheme="semver", version=version)

    def test_cve_2024_10979(self):
        configs = nvd_configs("CVE-2024-10979")
        for version, expected in [("16.4", "range"), ("16.0", "range"), ("16.5", None),
                                  ("17.1", None), ("17.0", "exact"), ("15.8", "range"),
                                  ("14.13 (Debian 14.13-1.pgdg120+1)", None),
                                  ("16.4 (Debian 16.4-1.pgdg120+1)", "range")]:
            with self.subTest(version=version):
                self.assertEqual(evaluate.match_nvd(configs, self.pg(version))[0], expected)

    def test_bounds(self):
        configs = config(node(cpe(versionStartExcluding="17.6.1",
                                  versionEndIncluding="17.9.4")))
        self.assertIsNone(evaluate.match_nvd(configs, xe("17.6.1"))[0])
        self.assertEqual(evaluate.match_nvd(configs, xe("17.6.2"))[0], "range")
        self.assertEqual(evaluate.match_nvd(configs, xe("17.9.4"))[0], "range")
        self.assertIsNone(evaluate.match_nvd(configs, xe("17.9.4a"))[0])

    def test_unparsed_bound_is_no_match(self):
        configs = config(node(cpe(versionEndExcluding="next release")))
        conf, flags = evaluate.match_nvd(configs, xe("17.9.4"))
        self.assertIsNone(conf)
        self.assertEqual(flags, {evaluate.UNPARSED_BOUNDS})

    def test_exact_only_scheme_does_not_test_ranges(self):
        configs = config(node(cpe(product="fortinet:fortios", versionEndExcluding="7.2.5"),
                              cpe(product="fortinet:fortios", version="7.0.1")))
        t = Target(kind="cpe", part="o", vendor="fortinet", product="fortios",
                   scheme="generic", version="7.2.1")
        conf, flags = evaluate.match_nvd(configs, t)
        self.assertIsNone(conf)
        self.assertEqual(flags, {evaluate.RANGE_NOT_UNDERSTOOD})
        t = Target(kind="cpe", part="o", vendor="fortinet", product="fortios",
                   scheme="generic", version="7.0.1")
        self.assertEqual(evaluate.match_nvd(configs, t)[0], "exact")

    def test_ios_trains(self):
        configs = config(node(cpe(product="cisco:ios", versionStartIncluding="15.2(4)e",
                                  versionEndExcluding="15.2(7)e9")))

        def ios(v):
            return Target(kind="cpe", part="o", vendor="cisco", product="ios",
                          scheme="cisco_ios", version=v)

        self.assertEqual(evaluate.match_nvd(configs, ios("15.2(7)E8"))[0], "range")
        self.assertIsNone(evaluate.match_nvd(configs, ios("15.2(7)E10"))[0])
        conf, flags = evaluate.match_nvd(configs, ios("15.2(4)M10"))
        self.assertIsNone(conf)
        self.assertEqual(flags, set())


class JunosTests(SimpleTestCase):
    def junos(self, v):
        return Target(kind="cpe", part="o", vendor="juniper", product="junos",
                      scheme="junos", version=v)

    def test_update_field(self):
        configs = config(node(cpe(product="juniper:junos", version="21.4", update="r3-s5"),
                              cpe(product="juniper:junos", version="21.4", update="-")))
        self.assertEqual(evaluate.match_nvd(configs, self.junos("21.4R3-S5.4"))[0], "exact")
        self.assertEqual(evaluate.match_nvd(configs, self.junos("21.4"))[0], "exact")
        self.assertIsNone(evaluate.match_nvd(configs, self.junos("21.4R3-S6"))[0])

    def test_any_update(self):
        configs = config(node(cpe(product="juniper:junos", version="22.1", update="*")))
        self.assertEqual(evaluate.match_nvd(configs, self.junos("22.1R2-S1"))[0], "exact")
        self.assertIsNone(evaluate.match_nvd(configs, self.junos("22.2R1"))[0])

    def test_range_in_update_form(self):
        configs = config(node(cpe(product="juniper:junos", versionStartIncluding="21.4",
                                  versionEndExcluding="21.4r3-s5")))
        self.assertEqual(evaluate.match_nvd(configs, self.junos("21.4R3-S4"))[0], "range")
        self.assertIsNone(evaluate.match_nvd(configs, self.junos("21.4R3-S5.4"))[0])


class HardwareContextTests(SimpleTestCase):
    """Decision 9: a mapped device type must be in the list; an unmapped one
    leaves the node out and the match partial."""

    configs = config(
        node(cpe(versionEndExcluding="17.9.5")),
        node(cpe(product="cisco:catalyst_9300", part="h", version="-", vulnerable=False),
             cpe(product="cisco:catalyst_9500", part="h", version="-", vulnerable=False)),
        operator="AND",
    )

    def test_mapped_type_in_the_list(self):
        t = xe("17.9.4", hardware=frozenset({("cisco", "catalyst_9300")}))
        self.assertEqual(evaluate.match_nvd(self.configs, t)[0], "range")

    def test_mapped_type_not_in_the_list(self):
        t = xe("17.9.4", hardware=frozenset({("cisco", "isr4451")}))
        self.assertIsNone(evaluate.match_nvd(self.configs, t)[0])

    def test_unmapped_type_is_partial(self):
        self.assertEqual(evaluate.match_nvd(self.configs, xe("17.9.4"))[0], "partial")
        # The version still has to match.
        self.assertIsNone(evaluate.match_nvd(self.configs, xe("17.9.5"))[0])

    def test_negated_node(self):
        configs = config(
            node(cpe(versionEndExcluding="17.9.5")),
            node(cpe(product="cisco:catalyst_9300", part="h", version="-", vulnerable=False),
                 negate=True),
            operator="AND",
        )
        inside = xe("17.9.4", hardware=frozenset({("cisco", "catalyst_9300")}))
        outside = xe("17.9.4", hardware=frozenset({("cisco", "isr4451")}))
        self.assertIsNone(evaluate.match_nvd(configs, inside)[0])
        self.assertEqual(evaluate.match_nvd(configs, outside)[0], "range")

    def test_application_on_an_os(self):
        configs = config(
            node(cpe(product="example:agent", part="a", versionEndExcluding="2.0")),
            node(cpe(product="microsoft:windows", part="o", vulnerable=False)),
            operator="AND",
        )

        def agent(platforms):
            return Target(kind="cpe", part="a", vendor="example", product="agent",
                          scheme="semver", version="1.5", platforms=platforms)

        self.assertEqual(evaluate.match_nvd(configs, agent(None))[0], "partial")
        self.assertEqual(evaluate.match_nvd(
            configs, agent(frozenset({("o", "microsoft", "windows")})))[0], "range")
        self.assertIsNone(evaluate.match_nvd(
            configs, agent(frozenset({("o", "canonical", "ubuntu_linux")})))[0])

    def test_exact_beats_partial(self):
        configs = [*self.configs, *config(node(cpe(version="17.9.4")))]
        self.assertEqual(evaluate.match_nvd(configs, xe("17.9.4"))[0], "exact")


class OsvTests(SimpleTestCase):
    def django(self, version):
        return Target(kind="purl", part="", vendor="pypi", product="django",
                      scheme="pep440", version=version)

    def osv(self, name="osv_django.json"):
        rec = json.loads(data(name))
        from .sources import normalise_osv

        n = normalise_osv(rec)
        return {n["osv"]["id"]: n["osv"]}

    def test_ecosystem_ranges_and_versions(self):
        osv = self.osv()
        for version, expected in [("4.2.15", "range"), ("4.2.16", None), ("4.1", None),
                                  ("5.0.8", "exact"), ("5.0.9", None), ("5.1", None),
                                  ("4.2.0", "exact"), ("5.0.3", "range")]:
            with self.subTest(version=version):
                self.assertEqual(evaluate.match_osv(osv, self.django(version))[0], expected)

    def test_semver_range(self):
        osv = self.osv("osv_npm.json")
        t = Target(kind="purl", part="", vendor="npm", product="example-merge",
                   scheme="semver", version="2.1.3")
        self.assertEqual(evaluate.match_osv(osv, t)[0], "range")
        t = Target(kind="purl", part="", vendor="npm", product="example-merge",
                   scheme="semver", version="2.1.4")
        self.assertIsNone(evaluate.match_osv(osv, t)[0])

    def adv(self, package, ranges=(), versions=(), purl_type="deb"):
        return {"X-1": {"modified": "", "fixed_in": [], "affected": [
            {"ecosystem": "Debian:12", "name": package.split("/")[-1], "purl_type": purl_type,
             "package": package, "ranges": list(ranges), "versions": list(versions)}]}}

    def test_dpkg_ecosystem(self):
        osv = self.adv("debian/openssl", ranges=[{"type": "ECOSYSTEM", "events": [
            {"introduced": "0"}, {"fixed": "3.0.15-1~deb12u1"}]}])

        def t(v):
            return Target(kind="purl", part="", vendor="deb", product="debian/openssl",
                          scheme="dpkg", version=v, release=("debian", "12"))

        self.assertEqual(evaluate.match_osv(osv, t("3.0.14-1~deb12u2"))[0], "range")
        self.assertEqual(evaluate.match_osv(osv, t("3.0.15-1~deb12u0"))[0], "range")
        self.assertIsNone(evaluate.match_osv(osv, t("3.0.15-1~deb12u1"))[0])
        self.assertIsNone(evaluate.match_osv(osv, t("3.0.15-1"))[0])

    def test_last_affected_and_reintroduced(self):
        osv = self.adv("debian/x", ranges=[{"type": "ECOSYSTEM", "events": [
            {"introduced": "1.0"}, {"last_affected": "1.4"}, {"introduced": "2.0"},
            {"fixed": "2.2"}]}])

        def t(v):
            return Target(kind="purl", part="", vendor="deb", product="debian/x",
                          scheme="dpkg", version=v, release=("debian", "12"))

        for v, expected in [("0.9", None), ("1.0", "range"), ("1.4", "range"),
                            ("1.5", None), ("2.1", "range"), ("2.2", None)]:
            with self.subTest(v=v):
                self.assertEqual(evaluate.match_osv(osv, t(v))[0], expected)

    def test_unknown_ecosystem_is_exact_only(self):
        osv = self.adv("org.example/lib", purl_type="maven", versions=["1.2.3"],
                       ranges=[{"type": "ECOSYSTEM", "events": [
                           {"introduced": "0"}, {"fixed": "1.3"}]}])

        def t(v):
            return Target(kind="purl", part="", vendor="maven", product="org.example/lib",
                          scheme="generic", version=v)

        self.assertEqual(evaluate.match_osv(osv, t("1.2.3"))[0], "exact")
        conf, flags = evaluate.match_osv(osv, t("1.2.4"))
        self.assertIsNone(conf)
        self.assertEqual(flags, {evaluate.RANGE_NOT_UNDERSTOOD})

    def test_other_package_ignored(self):
        self.assertIsNone(evaluate.match_osv(self.osv(), Target(
            kind="purl", part="", vendor="pypi", product="flask", scheme="pep440",
            version="4.2.15"))[0])



def _fixed(version: str) -> list:
    return [{"type": "ECOSYSTEM", "events": [{"introduced": "0"}, {"fixed": version}]}]


def distro_osv(*entries, osv_id="DEBIAN-CVE-2024-0001") -> dict:
    """One OSV record through the parser, as the store keeps it."""
    from .sources import normalise_osv

    rec = {"id": osv_id, "modified": "2024-10-01T00:00:00Z", "aliases": ["CVE-2024-0001"],
           "affected": [{"package": {"ecosystem": eco, "name": name}, "ranges": _fixed(fix)}
                        for eco, name, fix in entries]}
    n = normalise_osv(rec)
    return {n["osv"]["id"]: n["osv"]}


class DistroReleaseTests(SimpleTestCase):
    """OSV advisories for distro packages are per release (#451, B0)."""

    def setUp(self):
        self.osv = distro_osv(("Debian:11", "openssl", "1.1.1w-0+deb11u2"),
                              ("Debian:12", "openssl", "3.0.15-1~deb12u1"),
                              ("Debian:13", "openssl", "3.3.2-1"))

    def t(self, version, release=None, product="debian/openssl", scheme="dpkg", vendor="deb"):
        return Target(kind="purl", part="", vendor=vendor, product=product, scheme=scheme,
                      version=version, release=release)

    def test_parser_keeps_the_release(self):
        (adv,) = self.osv.values()
        self.assertEqual([a["ecosystem"] for a in adv["affected"]],
                         ["Debian:11", "Debian:12", "Debian:13"])

    def test_only_the_hosts_release_counts(self):
        d11, d12, d13 = ("debian", "11"), ("debian", "12"), ("debian", "13")
        for version, release, expected in [
                ("3.0.14-1~deb12u2", d12, "range"),
                # Fixed on 12; Debian 13's later fix used to make this a match.
                ("3.0.15-1~deb12u1", d12, None),
                ("1.1.1w-0+deb11u1", d11, "range"),
                # Fixed on 11; Debian 12's fix is a later version.
                ("1.1.1w-0+deb11u2", d11, None),
                ("3.3.2-1", d13, None),
                ("3.3.1-1", d13, "range"),
                # No entry for that release: not affected.
                ("1.0.0-1", ("debian", "14"), None)]:
            with self.subTest(version=version, release=release):
                conf, flags = evaluate.match_osv(self.osv, self.t(version, release))
                self.assertEqual(conf, expected)
                self.assertEqual(flags, set())

    def test_unknown_release_needs_every_release_to_agree(self):
        conf, flags = evaluate.match_osv(self.osv, self.t("1.0.0-1"))
        self.assertEqual((conf, flags), ("partial", set()))
        conf, flags = evaluate.match_osv(self.osv, self.t("9.9-1"))
        self.assertEqual((conf, flags), (None, set()))
        conf, flags = evaluate.match_osv(self.osv, self.t("3.0.15-1~deb12u1"))
        self.assertIsNone(conf)
        self.assertEqual(flags, {evaluate.RELEASE_UNKNOWN})

    def test_entry_without_ecosystem_tests_as_before(self):
        osv = {"X-1": {"modified": "", "fixed_in": [], "affected": [
            {"purl_type": "deb", "package": "debian/openssl", "versions": [],
             "ranges": _fixed("3.0.15-1~deb12u1")}]}}
        self.assertEqual(evaluate.match_osv(osv, self.t("3.0.14-1"))[0], "range")
        self.assertEqual(evaluate.match_osv(osv, self.t("3.0.14-1", ("debian", "12")))[0],
                         "range")

    def test_ubuntu_tilde_revision(self):
        osv = distro_osv(("Ubuntu:22.04:LTS", "apache2", "2.4.52-1ubuntu4.10~22.04.1"),
                         ("Ubuntu:24.04:LTS", "apache2", "2.4.58-1ubuntu8.5"),
                         osv_id="UBUNTU-CVE-2024-0001")
        jammy = ("ubuntu", "22.04")

        def t(v):
            return self.t(v, jammy, product="ubuntu/apache2")

        self.assertEqual(evaluate.match_osv(osv, t("2.4.52-1ubuntu4.10~22.04"))[0], "range")
        self.assertIsNone(evaluate.match_osv(osv, t("2.4.52-1ubuntu4.10~22.04.1"))[0])
        self.assertIsNone(evaluate.match_osv(osv, t("2.4.52-1ubuntu4.10"))[0])

    def test_rpm_release_and_epoch(self):
        osv = distro_osv(("Rocky Linux:9", "openssl", "1:3.0.7-25.el9_3"),
                         ("AlmaLinux:8", "openssl", "1:1.1.1k-12.el8_9"),
                         osv_id="RLSA-2024:0001")

        def t(v, release=("rocky", "9")):
            return self.t(v, release, product="rocky/openssl", scheme="rpm", vendor="rpm")

        self.assertEqual(evaluate.match_osv(osv, t("1:3.0.7-24.el9"))[0], "range")
        # No epoch is epoch 0, below the fix's 1.
        self.assertEqual(evaluate.match_osv(osv, t("3.0.9-1.el9"))[0], "range")
        self.assertIsNone(evaluate.match_osv(osv, t("1:3.0.7-25.el9_3"))[0])
        self.assertIsNone(evaluate.match_osv(osv, t("1:3.0.7-24.el9", ("rocky", "8")))[0])

    def test_other_ecosystems_ignore_the_release(self):
        osv = {"GHSA-x": {"modified": "", "fixed_in": [], "affected": [
            {"ecosystem": "PyPI", "purl_type": "pypi", "package": "django", "versions": [],
             "ranges": _fixed("4.2.16")}]}}
        t = Target(kind="purl", part="", vendor="pypi", product="django", scheme="pep440",
                   version="4.2.15")
        self.assertEqual(evaluate.match_osv(osv, t), ("range", set()))
