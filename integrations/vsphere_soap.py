"""vSphere SOAP (vim25) - the only place ESXi host hardware is exposed.

The vSphere Automation REST API that :mod:`integrations.virt_client` speaks
returns exactly four fields per host (``host``, ``name``, ``connection_state``,
``power_state``). There is no host-detail endpoint at all: ``vcenter/host/{id}``
is a 404. Model, vendor and serial live only in the older SOAP API, which is why
this module exists and why ``pyvmomi`` is a dependency.

Kept apart from ``virt_client`` deliberately:

* that module is the thin REST layer for **both** hypervisors and imports only
  ``requests`` - it must stay cheap;
* ``pyVmomi`` is imported inside :meth:`VSphereSoap.connect`, so a deployment
  that never ticks *Sync host hardware* never loads it, and a missing package
  degrades one opt-in feature instead of breaking every sync.

Same transport guarantees as the REST client: the SSRF allowlist is checked
before connecting and ``verify_ssl`` is honoured. One difference worth stating -
REST re-checks the allowlist before every request, while SOAP holds a single
connection, so the check happens once. That is acceptable because the connection
only ever talks to the host that was checked, but it is a difference.
"""
from __future__ import annotations

import logging

from core.ssrf import SSRFError, assert_public_host

from .virt_client import VirtAPIError

logger = logging.getLogger("danbyte.virt_sync")

# vim25 puts the useful serial in otherIdentifyingInfo, keyed by type. Ordered
# by how much operators trust them: a Dell service tag beats a generic serial.
_SERIAL_KEYS = (
    "ServiceTag",
    "EnclosureSerialNumberTag",
    "SerialNumberTag",
)


def _serial_from(summary_hw) -> str:
    """Best serial for a host, or "" when it reports nothing usable."""
    found: dict = {}
    for entry in getattr(summary_hw, "otherIdentifyingInfo", None) or []:
        key = getattr(getattr(entry, "identifierType", None), "key", "")
        value = (getattr(entry, "identifierValue", "") or "").strip()
        # Hosts routinely report placeholders rather than omitting the field.
        if value and value.lower() not in ("unknown", "none", "not specified"):
            found.setdefault(key, value)
    for key in _SERIAL_KEYS:
        if key in found:
            return found[key]
    return ""


def _esxi_version(product) -> str:
    """``VMware ESXi 8.0.3`` - without the build, which changes every patch.

    Keeping the build would mint a new Platform row on every update, which is
    noise in a catalog the operator curates.
    """
    name = (getattr(product, "name", "") or "").strip()
    version = (getattr(product, "version", "") or "").strip()
    return " ".join(p for p in (name, version) if p)


def _pnics(val) -> list:
    """[{name, mac, speed_mb}] from config.network.pnic."""
    out = []
    for p in val or []:
        device = (getattr(p, "device", "") or "").strip()
        if not device:
            continue
        speed = getattr(getattr(p, "linkSpeed", None), "speedMb", None)
        out.append({
            "name": device,
            "mac": (getattr(p, "mac", "") or "").lower(),
            "speed_mb": int(speed) if speed else None,
        })
    return out


def _switch_uplinks(vswitches, proxies) -> dict:
    """{switch name: [pnic device names]} - standard vSwitches from the
    bridge spec, distributed ones from the host's proxy-switch backing."""
    links: dict = {}
    for vs in vswitches or []:
        name = (getattr(vs, "name", "") or "").strip()
        bridge = getattr(getattr(vs, "spec", None), "bridge", None)
        nics = [str(n) for n in (getattr(bridge, "nicDevice", None) or [])]
        if name:
            links[name] = nics
    for ps in proxies or []:
        name = (getattr(ps, "dvsName", "") or "").strip()
        backing = getattr(getattr(ps, "spec", None), "backing", None)
        nics = [
            (getattr(s, "pnicDevice", "") or "")
            for s in (getattr(backing, "pnicSpec", None) or [])
        ]
        if name:
            links[name] = [n for n in nics if n]
    return links


def _vnic_ips(vnics) -> list:
    """Management addresses of an ESXi host, IPv4 and IPv6.

    These are the addresses an operator means by "192.168.110.* is UA" - a
    host's management subnet is per-site in most estates. They exist nowhere in
    the REST API, which is why they ride along with the hardware retrieval.
    """
    out = []
    for vnic in vnics or []:
        ip = getattr(getattr(vnic, "spec", None), "ip", None)
        for addr in (
            getattr(ip, "ipAddress", "") or "",
            *[
                getattr(a, "ipAddress", "") or ""
                for a in (
                    getattr(getattr(ip, "ipV6Config", None), "ipV6Address", None)
                    or []
                )
            ],
        ):
            addr = (addr or "").strip()
            if addr and addr not in out:
                out.append(addr)
    return out


class VSphereSoap:
    """A short-lived vim25 session, used for the one thing REST can't answer."""

    def __init__(self, source):
        self.source = source
        self._si = None

    def connect(self) -> VSphereSoap:
        try:
            assert_public_host(self.source.host, self.source.port)
        except SSRFError as exc:
            raise VirtAPIError(str(exc)) from exc
        try:
            from pyVim.connect import SmartConnect
        except ImportError as exc:  # pragma: no cover - depends on the install
            raise VirtAPIError(
                "This feature needs pyvmomi (used for host hardware and "
                "port-group VLANs). Install it, or turn the option off on "
                "this source."
            ) from exc
        creds = self.source.credentials or {}
        try:
            self._si = SmartConnect(
                host=self.source.host,
                port=self.source.port,
                user=creds.get("username", ""),
                pwd=creds.get("password", ""),
                disableSslCertValidation=not self.source.verify_ssl,
            )
        except Exception as exc:  # pyVmomi raises a wide range of its own
            raise VirtAPIError(f"vCenter SOAP connect failed: {exc}") from exc
        return self

    def hosts(self) -> list[dict]:
        """``[{name, model, vendor, serial, platform}]`` for every ESXi host.

        Fetched with a single ``PropertyCollector`` retrieval over an explicit
        path set. The obvious ``for h in view.view: h.hardware.systemInfo.model``
        is a network round trip **per property per host**, which is the
        difference between one call and hundreds on a real estate.
        """
        if self._si is None:
            self.connect()
        from pyVmomi import vim, vmodl

        paths = [
            "name",
            "hardware.systemInfo.vendor",
            "hardware.systemInfo.model",
            "summary.hardware",
            "summary.config.product",
            # Management addresses, for ip-scope placement rules. Free: it is
            # one more path on a retrieval already being made, not a new call.
            "config.network.vnic",
            # Physical NICs + switch uplink specs (issue #55) - same
            # retrieval, no extra round trip.
            "config.network.pnic",
            "config.network.vswitch",
            "config.network.proxySwitch",
        ]
        content = self._si.RetrieveContent()
        view = content.viewManager.CreateContainerView(
            content.rootFolder, [vim.HostSystem], True
        )
        try:
            spec = vmodl.query.PropertyCollector.FilterSpec(
                objectSet=[
                    vmodl.query.PropertyCollector.ObjectSpec(
                        obj=view,
                        skip=False,
                        selectSet=[
                            vmodl.query.PropertyCollector.TraversalSpec(
                                type=vim.view.ContainerView,
                                path="view",
                                skip=False,
                            )
                        ],
                    )
                ],
                propSet=[
                    vmodl.query.PropertyCollector.PropertySpec(
                        type=vim.HostSystem, pathSet=paths
                    )
                ],
            )
            rows = content.propertyCollector.RetrieveContents([spec]) or []
        finally:
            try:
                view.Destroy()
            except Exception:
                pass  # best effort; the session teardown collects it anyway

        out = []
        for row in rows:
            props = {p.name: p.val for p in (row.propSet or [])}
            name = (props.get("name") or "").strip()
            if not name:
                continue
            out.append({
                "name": name,
                "vendor": (props.get("hardware.systemInfo.vendor") or "").strip(),
                "model": (props.get("hardware.systemInfo.model") or "").strip(),
                "serial": _serial_from(props.get("summary.hardware")),
                "platform": _esxi_version(props.get("summary.config.product")),
                "ips": _vnic_ips(props.get("config.network.vnic")),
                "pnics": _pnics(props.get("config.network.pnic")),
                "switch_uplinks": _switch_uplinks(
                    props.get("config.network.vswitch"),
                    props.get("config.network.proxySwitch"),
                ),
            })
        return out

    def portgroup_vlans(self) -> dict:
        """``{port group name: vlan id}`` for every port group with a plain tag.

        The REST API never exposes a port group's VLAN - not on the NIC
        backing, not on ``vcenter/network`` - which is why vCenter VMs never
        got VLAN links (#46). SOAP has it in two places:

        * standard switches: each host's ``config.network.portgroup`` carries
          ``spec.vlanId``;
        * distributed switches: each ``DistributedVirtualPortgroup``'s
          ``defaultPortConfig.vlan`` (only ``VlanIdSpec`` - a trunk range is
          not an access VLAN and is deliberately skipped).

        Tag 0 means untagged on both, so it is omitted rather than minting a
        "VLAN 0" the operator never made.
        """
        if self._si is None:
            self.connect()
        from pyVmomi import vim

        out: dict = {}
        content = self._si.RetrieveContent()

        view = content.viewManager.CreateContainerView(
            content.rootFolder, [vim.HostSystem], True
        )
        try:
            for host in view.view:
                net = getattr(getattr(host, "config", None), "network", None)
                for pg in getattr(net, "portgroup", None) or []:
                    name = getattr(pg.spec, "name", "") or ""
                    vlan = getattr(pg.spec, "vlanId", None)
                    if name and isinstance(vlan, int) and 0 < vlan < 4095:
                        out.setdefault(name, vlan)
        finally:
            try:
                view.Destroy()
            except Exception:
                pass

        view = content.viewManager.CreateContainerView(
            content.rootFolder, [vim.dvs.DistributedVirtualPortgroup], True
        )
        try:
            for pg in view.view:
                cfg = getattr(pg, "config", None)
                vlan_spec = getattr(
                    getattr(cfg, "defaultPortConfig", None), "vlan", None
                )
                vid = getattr(vlan_spec, "vlanId", None)
                # TrunkVlanSpec's vlanId is a range list, not an int - skip.
                if pg.name and isinstance(vid, int) and 0 < vid < 4095:
                    out.setdefault(pg.name, vid)
        finally:
            try:
                view.Destroy()
            except Exception:
                pass
        return out

    def close(self) -> None:
        if self._si is None:
            return
        try:
            from pyVim.connect import Disconnect

            Disconnect(self._si)
        except Exception:
            pass  # the session expires on its own regardless
        finally:
            self._si = None
