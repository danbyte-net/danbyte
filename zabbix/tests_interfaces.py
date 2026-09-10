"""Reachability, and the duplicate-host bug that provisioning caused.

Giving a host an SNMP interface alongside its agent one made ``hosts_by_ip``
report two hosts on one address, so the check answered "several hosts share
this address" and went unknown - for the very host provisioning had just
finished setting up.
"""
from __future__ import annotations

from unittest import mock

from django.test import TestCase

from .client import ZabbixClient
from .driver import ZabbixDriver
from .interfaces import availability
from .severity import DEFAULT_MAP


def host(hostid, name, *ifaces):
    return {
        "hostid": hostid, "host": name, "name": name, "status": "0",
        "interfaces": list(ifaces),
    }


def iface(itype, ip, available="0", error=""):
    return {"type": itype, "ip": ip, "useip": "1", "available": available,
            "error": error}


class DedupeTests(TestCase):
    """One entry per host, however many interfaces sit on the address."""

    def _by_ip(self, rows, ips):
        with mock.patch.object(ZabbixClient, "call", return_value=rows):
            return ZabbixClient("http://z/api_jsonrpc.php", "t").hosts_by_ip(ips)

    def test_two_interfaces_on_one_address_is_still_one_host(self):
        rows = [host("1", "sw1", iface("1", "10.0.0.1"), iface("2", "10.0.0.1"))]
        got = self._by_ip(rows, {"10.0.0.1"})
        self.assertEqual([h["host"] for h in got["10.0.0.1"]], ["sw1"])

    def test_two_genuine_hosts_are_still_two(self):
        """The ambiguity this check exists for has to keep being reported."""
        rows = [
            host("1", "sw1", iface("1", "10.0.0.1")),
            host("2", "sw2", iface("1", "10.0.0.1")),
        ]
        got = self._by_ip(rows, {"10.0.0.1"})
        self.assertEqual(
            sorted(h["host"] for h in got["10.0.0.1"]), ["sw1", "sw2"]
        )

    def test_a_host_on_two_addresses_appears_under_each(self):
        rows = [host("1", "sw1", iface("1", "10.0.0.1"), iface("2", "10.0.0.2"))]
        got = self._by_ip(rows, {"10.0.0.1", "10.0.0.2"})
        self.assertEqual(set(got), {"10.0.0.1", "10.0.0.2"})


class AvailabilityTests(TestCase):
    def test_it_names_each_protocol(self):
        got = availability(host(
            "1", "sw1",
            iface("1", "10.0.0.1", available="1"),
            iface("2", "10.0.0.1", available="2", error="cannot retrieve OID"),
        ))
        self.assertEqual(got["agent"], {"state": "up"})
        self.assertEqual(got["snmp"]["state"], "down")
        self.assertIn("cannot retrieve OID", got["snmp"]["error"])

    def test_unpolled_is_unknown_not_down(self):
        """Zabbix's 0 means nothing has tried yet - grey, not red."""
        got = availability(host("1", "sw1", iface("1", "10.0.0.1")))
        self.assertEqual(got["agent"], {"state": "unknown"})

    def test_the_worst_of_two_same_type_interfaces_wins(self):
        got = availability(host(
            "1", "sw1",
            iface("2", "10.0.0.1", available="1"),
            iface("2", "10.0.0.2", available="2", error="timed out"),
        ))
        self.assertEqual(got["snmp"]["state"], "down")

    def test_an_unknown_interface_type_is_skipped(self):
        self.assertEqual(availability(host("1", "sw1", iface("9", "10.0.0.1"))), {})

    def test_a_host_with_no_interfaces_reports_nothing(self):
        self.assertEqual(availability(host("1", "sw1")), {})


class OutcomeTests(TestCase):
    """Reachability rides the outcome the status already travels in."""

    def test_the_outcome_carries_availability(self):
        rows = [host("1", "sw1", iface("2", "10.0.0.1", available="2",
                                       error="cannot retrieve OID"))]
        out = ZabbixDriver._for_host(rows, {}, DEFAULT_MAP)
        self.assertEqual(out.detail["availability"]["snmp"]["state"], "down")

    def test_a_reachable_host_with_no_problems_is_up(self):
        rows = [host("1", "sw1", iface("1", "10.0.0.1", available="1"))]
        out = ZabbixDriver._for_host(rows, {}, DEFAULT_MAP)
        self.assertEqual(out.status, "up")
        self.assertEqual(out.detail["availability"]["agent"]["state"], "up")
