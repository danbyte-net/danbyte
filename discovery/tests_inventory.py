"""The Django-free collector: fixed commands and strict parsers, on outputs
recorded from real hosts (Debian 12 and Alpine 3.22 containers, an Ubuntu
26.04 host; the Rocky 9 rpm output is written to rpm's documented query
format)."""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase

from danbyte_checks import inventory as inv

DATA = Path(__file__).resolve().parent / "testdata"


def text(name):
    return (DATA / name).read_text()


class CommandTests(SimpleTestCase):
    def test_commands_are_constants_without_shell_expansion(self):
        for name, cmd in inv.COMMANDS.items():
            with self.subTest(name):
                # Nothing a shell would expand outside single quotes.
                outside = "".join(cmd.split("'")[0::2])
                for ch in "$`;|&<>()*?~!":
                    self.assertNotIn(ch, outside, cmd)
                self.assertNotIn("sudo", cmd)

    def test_only_listed_commands_run(self):
        conn = mock.MagicMock()
        with self.assertRaises(inv.InventoryError):
            asyncio.run(inv._run(conn, "rm -rf /", 5))
        conn.create_process.assert_not_called()


class OsReleaseTests(SimpleTestCase):
    def test_real_files(self):
        deb = inv.parse_os_release(text("debian12-os-release.txt"))
        self.assertEqual((deb["id"], deb["version_id"], deb["version_codename"]),
                         ("debian", "12", "bookworm"))
        self.assertEqual(inv.package_manager(deb), "dpkg")
        ubu = inv.parse_os_release(text("ubuntu2604-os-release.txt"))
        self.assertEqual((ubu["id"], ubu["version_id"], ubu["id_like"]),
                         ("ubuntu", "26.04", ["debian"]))
        alp = inv.parse_os_release(text("alpine322-os-release.txt"))
        self.assertEqual(alp["id"], "alpine")
        self.assertEqual(inv.package_manager(alp), "apk")
        rocky = inv.parse_os_release(text("rocky9-os-release.txt"))
        self.assertEqual((rocky["id"], rocky["version_id"]), ("rocky", "9.4"))
        self.assertEqual(rocky["id_like"], ["rhel", "centos", "fedora"])
        self.assertEqual(inv.package_manager(rocky), "rpm")

    def test_hostile_values_are_dropped(self):
        facts = inv.parse_os_release(
            'ID=debian\nVERSION_ID="$(reboot)"\nPRETTY_NAME="a`id`b"\n'
            'VERSION_CODENAME=bookworm;rm\nNAME="ok \\"quoted\\""\n')
        self.assertEqual(facts["version_id"], "")
        self.assertEqual(facts["pretty_name"], "")
        self.assertEqual(facts["version_codename"], "")
        self.assertEqual(facts["name"], 'ok "quoted"')

    def test_no_id_is_unsupported(self):
        with self.assertRaises(inv.InventoryError) as ctx:
            inv.parse_os_release("NAME=Something\n")
        self.assertEqual(ctx.exception.status, inv.UNSUPPORTED)

    def test_unknown_distro_has_no_reader(self):
        self.assertIsNone(inv.package_manager({"id": "gentoo", "id_like": []}))
        self.assertEqual(inv.package_manager({"id": "linuxmint", "id_like": ["ubuntu"]}),
                         "dpkg")


class DpkgTests(SimpleTestCase):
    def test_debian_12(self):
        r = inv.parse_dpkg(text("debian12-dpkg.txt"))
        by = {p.name: p for p in r.packages}
        self.assertEqual(len(r.packages), 88)
        self.assertEqual(r.skipped, 0)
        # A binNMU: the binary carries +b13, its source does not.
        self.assertEqual((by["bash"].version, by["bash"].source_version),
                         ("5.2.15-2+b13", "5.2.15-2"))
        self.assertEqual(by["base-files"].source_name, "base-files")

    def test_ubuntu_source_names_and_multiarch(self):
        r = inv.parse_dpkg(text("ubuntu2604-dpkg.txt"))
        by = {p.name: p for p in r.packages}
        # libssl3t64:amd64 -> libssl3t64, advised as source package openssl.
        self.assertEqual(by["libssl3t64"].source_name, "openssl")
        self.assertEqual(by["libssl3t64"].arch, "amd64")
        self.assertEqual(by["openssh-server"].version, "1:10.2p1-2ubuntu3.8")
        self.assertEqual(by["login"].source_name, "util-linux")
        # "rc" (removed, config kept) is not installed.
        self.assertNotIn("linux-image-7.0.0-28-generic", by)
        self.assertEqual(r.skipped, 1)

    def test_malformed_lines_are_skipped(self):
        r = inv.parse_dpkg("bad line\nUPPER\t1.0\tUPPER\t1.0\tamd64\tii \n"
                           "ok\t1.0\tok\t1.0\tamd64\tii \n" + "x\t1 0\tx\t1\tamd64\tii \n")
        self.assertEqual([p.name for p in r.packages], ["ok"])
        self.assertEqual(r.skipped, 3)

    def test_package_cap(self):
        lines = "".join(f"p{i}\t1.0\tp{i}\t1.0\tamd64\tii \n" for i in range(30))
        with mock.patch.object(inv, "MAX_PACKAGES", 10):
            r = inv.parse_dpkg(lines)
        self.assertEqual(len(r.packages), 10)
        self.assertTrue(r.truncated)


class RpmTests(SimpleTestCase):
    def test_rocky_9(self):
        r = inv.parse_rpm(text("rocky9-rpm.txt"))
        by = {p.name: p for p in r.packages}
        self.assertNotIn("gpg-pubkey", by)
        self.assertEqual(r.skipped, 1)  # the line without tabs
        self.assertEqual(by["openssl-libs"].version, "1:3.0.7-27.el9")
        self.assertEqual(by["openssl-libs"].source_name, "openssl")
        self.assertEqual(by["python3-libs"].source_name, "python3.9")
        self.assertEqual(by["NetworkManager"].version, "1:1.46.0-8.el9_4")
        self.assertEqual(by["tzdata"].arch, "noarch")

    def test_no_epoch_reads_as_zero(self):
        r = inv.parse_rpm("bash\t5.1.8-9.el9\tx86_64\tbash-5.1.8-9.el9.src.rpm\n")
        self.assertEqual(r.packages[0].version, "0:5.1.8-9.el9")


class ApkTests(SimpleTestCase):
    def test_alpine_322(self):
        r = inv.parse_apk_installed(text("alpine322-installed.txt"))
        by = {p.name: p for p in r.packages}
        self.assertIn("musl", by)
        self.assertEqual(by["alpine-baselayout"].version, "3.7.0-r0")
        self.assertEqual(by["alpine-baselayout"].arch, "x86_64")
        # A subpackage is advised under its origin.
        self.assertEqual(by["libcrypto3"].source_name, "openssl")
        self.assertEqual(r.skipped, 0)


class _Proc:
    def __init__(self, out: bytes, status=0):
        self._chunks = [out[i:i + 65536] for i in range(0, len(out), 65536)] + [b""]
        self.stdout = self
        self.exit_status = status
        self.closed = False

    async def read(self, n):
        return self._chunks.pop(0)

    def close(self):
        self.closed = True

    async def wait_closed(self):
        return None


class _Conn:
    def __init__(self, outputs: dict):
        self.outputs = outputs
        self.ran = []

    async def create_process(self, command, **kw):
        self.ran.append(command)
        assert kw.get("stdin") is not None and kw.get("stderr") is not None
        out, status = self.outputs.get(command, (b"", 1))
        return _Proc(out, status)


class ReadHostTests(SimpleTestCase):
    def test_reads_os_release_then_the_package_list(self):
        conn = _Conn({inv.COMMANDS["os_release"]: (text("debian12-os-release.txt").encode(), 0),
                      inv.COMMANDS["dpkg"]: (text("debian12-dpkg.txt").encode(), 0)})
        r = asyncio.run(inv.read_host(conn, 10))
        self.assertEqual(r.status, inv.OK)
        self.assertEqual(r.manager, "dpkg")
        self.assertEqual(len(r.packages), 88)
        self.assertEqual(conn.ran, [inv.COMMANDS["os_release"], inv.COMMANDS["dpkg"]])

    def test_output_cap(self):
        conn = _Conn({inv.COMMANDS["os_release"]: (b"x" * 200_000, 0)})
        with mock.patch.object(inv, "MAX_OUTPUT", 100_000):
            with self.assertRaises(inv.InventoryError) as ctx:
                asyncio.run(inv.read_host(conn, 10))
        self.assertIn("larger than", ctx.exception.message)

    def test_unsupported_distro(self):
        conn = _Conn({inv.COMMANDS["os_release"]: (b"ID=gentoo\n", 0)})
        r = asyncio.run(inv.read_host(conn, 10))
        self.assertEqual(r.status, inv.UNSUPPORTED)
        self.assertEqual(r.packages, [])


class ConnectOptionTests(SimpleTestCase):
    def test_nothing_from_the_local_account(self):
        opts = inv.connect_options(username="u", password="pw", known_hosts=b"h k v\n")
        self.assertIsNone(opts["agent_path"])
        self.assertIsNone(opts["config"])
        self.assertIsNone(opts["client_keys"])
        self.assertFalse(opts["public_key_auth"])
        self.assertFalse(opts["gss_auth"])
        self.assertEqual(opts["known_hosts"], b"h k v\n")

    def test_no_pinned_key_never_connects(self):
        with mock.patch("asyncssh.connect") as connect:
            r = asyncio.run(inv.collect("192.0.2.1", username="u", password="pw",
                                        known_hosts=None, timeout=5))
        self.assertEqual(r.status, inv.HOST_KEY_REFUSED)
        connect.assert_not_called()

    def test_a_bad_key_is_auth_failed_without_the_key_in_the_message(self):
        r = asyncio.run(inv.collect("192.0.2.1", username="u", private_key="SECRET-NOT-A-KEY",
                                    known_hosts=b"x", timeout=5))
        self.assertEqual(r.status, inv.AUTH_FAILED)
        self.assertNotIn("SECRET", r.message)

    def test_host_key_mismatch_is_refused(self):
        import asyncssh

        def boom(*a, **kw):
            raise asyncssh.HostKeyNotVerifiable("no match")

        with mock.patch("asyncssh.connect", side_effect=boom):
            r = asyncio.run(inv.collect("192.0.2.1", username="u", password="pw",
                                        known_hosts=b"x", timeout=5))
        self.assertEqual(r.status, inv.HOST_KEY_REFUSED)

    def test_login_refused(self):
        import asyncssh

        def boom(*a, **kw):
            raise asyncssh.PermissionDenied("bad pw hunter2")

        with mock.patch("asyncssh.connect", side_effect=boom):
            r = asyncio.run(inv.collect("192.0.2.1", username="u", password="hunter2",
                                        known_hosts=b"x", timeout=5))
        self.assertEqual(r.status, inv.AUTH_FAILED)
        self.assertNotIn("hunter2", r.message)
