"""Well-known products for "Suggest mappings" (#451).

A small table of public CPE names for the network operating systems,
hypervisors, server operating systems and common server software a
platform or application is usually called after. Each entry is keyed by the
words a platform's (or application's) name, slug or manufacturer is written
with, normalised: lowercase, every run of other characters a word break,
letters and digits split (``IOS-XE 17.9`` -> ``ios xe 17 9``). An alias
matches a run of consecutive words joined (``ios xe`` -> ``iosxe``), so
``Cisco IOS XE``, ``ios-xe`` and ``IOS_XE`` all find ``cisco:ios_xe``.

Every vendor:product here was checked against the NVD CPE dictionary
(``cpeMatchString``); a product whose name was not certain was left out.
Pure Python, no Django.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

_WORD = re.compile(r"[a-z]+|[0-9]+")
MAX_WORDS = 12


@dataclass(frozen=True)
class Known:
    part: str
    vendor: str
    product: str
    title: str
    #: Matched alone (``iosxe``, ``nxos``).
    aliases: tuple[str, ...]
    #: Matched only with ``vendors`` in the name or manufacturer for high
    #: confidence, medium without (``ios`` alone could be Apple's).
    weak: tuple[str, ...] = ()
    #: The vendor as people write it (``cisco``, ``paloalto``).
    vendors: tuple[str, ...] = ()
    #: The manufacturer alone suggests it (medium): the vendor's one OS.
    vendor_default: bool = False
    #: At most this confidence: a second name the same product's older
    #: records use.
    cap: str = "high"

    @property
    def cpe(self) -> str:
        return f"cpe:2.3:{self.part}:{self.vendor}:{self.product}"


def _k(part, vendor, product, title, aliases, weak=(), vendors=(), vendor_default=False,
       cap="high"):
    return Known(part, vendor, product, title, tuple(aliases), tuple(weak), tuple(vendors),
                 vendor_default, cap)


#: Platforms (``o``/``a``) and applications (``a``). Hardware is not listed:
#: model names are too many and too close to guess.
KNOWN: tuple[Known, ...] = (
    # Network operating systems
    _k("o", "cisco", "ios", "Cisco IOS", [], ["ios"], ["cisco"]),
    _k("o", "cisco", "ios_xe", "Cisco IOS XE", ["iosxe"], vendors=["cisco"]),
    _k("o", "cisco", "ios_xr", "Cisco IOS XR", ["iosxr"], vendors=["cisco"]),
    _k("o", "cisco", "nx-os", "Cisco NX-OS", ["nxos"], vendors=["cisco"]),
    _k("a", "cisco", "adaptive_security_appliance_software", "Cisco ASA Software",
       ["ciscoasa", "adaptivesecurityappliance"], ["asa"], ["cisco"]),
    _k("a", "cisco", "firepower_threat_defense", "Cisco Firepower Threat Defense",
       ["firepowerthreatdefense", "ciscoftd"], ["ftd"], ["cisco"]),
    _k("o", "juniper", "junos", "Juniper Junos OS", ["junos"], vendors=["juniper"],
       vendor_default=True),
    _k("o", "juniper", "junos_os_evolved", "Juniper Junos OS Evolved",
       ["junosevolved", "junososevolved"], ["evo"], ["juniper"]),
    _k("o", "arista", "eos", "Arista EOS", ["aristaeos"], ["eos"], ["arista"],
       vendor_default=True),
    _k("o", "fortinet", "fortios", "Fortinet FortiOS", ["fortios", "fortigate"],
       vendors=["fortinet"], vendor_default=True),
    _k("o", "paloaltonetworks", "pan-os", "Palo Alto Networks PAN-OS", ["panos"],
       vendors=["paloalto", "paloaltonetworks"], vendor_default=True),
    _k("o", "mikrotik", "routeros", "MikroTik RouterOS", ["routeros"], vendors=["mikrotik"],
       vendor_default=True),
    _k("o", "arubanetworks", "arubaos", "Aruba ArubaOS", ["arubaos"], vendors=["aruba"]),
    _k("o", "hpe", "arubaos-cx", "HPE Aruba AOS-CX", ["arubaoscx", "aoscx"],
       vendors=["aruba", "hpe"]),
    _k("o", "dell", "networking_os10", "Dell Networking OS10", ["dellos10", "networkingos10"],
       ["os10"], ["dell"]),
    _k("o", "extremenetworks", "extremexos", "Extreme Networks ExtremeXOS",
       ["extremexos", "exos"], vendors=["extreme", "extremenetworks"]),
    _k("o", "ui", "edgeos", "Ubiquiti EdgeOS", ["edgeos"], vendors=["ubiquiti", "ui"]),
    _k("a", "ui", "unifi_network_application", "Ubiquiti UniFi Network Application",
       ["unifinetworkapplication", "unifinetwork", "unificontroller"],
       vendors=["ubiquiti", "ui"]),
    _k("a", "netgate", "pfsense", "Netgate pfSense", ["pfsense"]),
    _k("a", "opnsense", "opnsense", "OPNsense", ["opnsense"]),
    _k("o", "sonicwall", "sonicos", "SonicWall SonicOS", ["sonicos"], vendors=["sonicwall"]),
    _k("o", "openwrt", "openwrt", "OpenWrt", ["openwrt"]),
    # Hypervisors and virtualisation
    _k("o", "vmware", "esxi", "VMware ESXi", ["esxi", "vsphereesxi"], vendors=["vmware"]),
    _k("a", "vmware", "vcenter_server", "VMware vCenter Server", ["vcenter", "vcsa"],
       vendors=["vmware"]),
    _k("a", "proxmox", "virtual_environment", "Proxmox Virtual Environment",
       ["proxmoxve", "proxmoxvirtualenvironment", "pve"], ["proxmox"]),
    # Server operating systems
    _k("o", "canonical", "ubuntu_linux", "Ubuntu Linux", ["ubuntu"]),
    _k("o", "debian", "debian_linux", "Debian Linux", ["debian"]),
    _k("o", "redhat", "enterprise_linux", "Red Hat Enterprise Linux",
       ["rhel", "redhatenterpriselinux", "redhatlinux"]),
    _k("o", "rockylinux", "rocky_linux", "Rocky Linux", ["rockylinux"], ["rocky"]),
    _k("o", "almalinux", "almalinux", "AlmaLinux", ["almalinux"]),
    _k("o", "centos", "centos", "CentOS", ["centos"]),
    _k("o", "suse", "linux_enterprise_server", "SUSE Linux Enterprise Server",
       ["sles", "suselinuxenterpriseserver"]),
    _k("o", "fedoraproject", "fedora", "Fedora", ["fedora"]),
    _k("o", "oracle", "linux", "Oracle Linux", ["oraclelinux"], ["ol"], ["oracle"]),
    _k("o", "freebsd", "freebsd", "FreeBSD", ["freebsd"]),
    _k("o", "alpinelinux", "alpine_linux", "Alpine Linux", ["alpinelinux"], ["alpine"]),
    _k("o", "microsoft", "windows_server_2012", "Windows Server 2012",
       ["windowsserver2012", "winserver2012", "ws2012"]),
    _k("o", "microsoft", "windows_server_2016", "Windows Server 2016",
       ["windowsserver2016", "winserver2016", "ws2016"]),
    _k("o", "microsoft", "windows_server_2019", "Windows Server 2019",
       ["windowsserver2019", "winserver2019", "ws2019"]),
    _k("o", "microsoft", "windows_server_2022", "Windows Server 2022",
       ["windowsserver2022", "winserver2022", "ws2022"]),
    _k("o", "microsoft", "windows_server_2025", "Windows Server 2025",
       ["windowsserver2025", "winserver2025", "ws2025"]),
    # Server software (applications)
    _k("a", "postgresql", "postgresql", "PostgreSQL", ["postgresql", "postgres"]),
    _k("a", "oracle", "mysql", "MySQL", ["mysql"]),
    _k("a", "mariadb", "mariadb", "MariaDB", ["mariadb"]),
    _k("a", "microsoft", "sql_server", "Microsoft SQL Server", ["sqlserver", "mssql"]),
    _k("a", "redis", "redis", "Redis", ["redis"]),
    _k("a", "apache", "http_server", "Apache HTTP Server",
       ["apachehttpserver", "apachehttpd", "httpd", "apache2"], ["apache"]),
    _k("a", "apache", "tomcat", "Apache Tomcat", ["tomcat"]),
    _k("a", "f5", "nginx_open_source", "nginx", ["nginx"]),
    _k("a", "nginx", "nginx", "nginx (older records)", ["nginx"], cap="medium"),
    _k("a", "haproxy", "haproxy", "HAProxy", ["haproxy"]),
    _k("a", "openbsd", "openssh", "OpenSSH", ["openssh"]),
    _k("a", "openssl", "openssl", "OpenSSL", ["openssl"]),
    _k("a", "isc", "bind", "ISC BIND", ["bind9", "iscbind"], ["bind"], ["isc"]),
    _k("a", "samba", "samba", "Samba", ["samba"]),
    _k("a", "microsoft", "exchange_server", "Microsoft Exchange Server",
       ["exchangeserver", "msexchange"], ["exchange"], ["microsoft"]),
    _k("a", "elastic", "elasticsearch", "Elasticsearch", ["elasticsearch"]),
    _k("a", "grafana", "grafana", "Grafana", ["grafana"]),
    _k("a", "zabbix", "zabbix", "Zabbix", ["zabbix"]),
    _k("a", "jenkins", "jenkins", "Jenkins", ["jenkins"]),
    _k("a", "gitlab", "gitlab", "GitLab", ["gitlab"]),
    _k("a", "kubernetes", "kubernetes", "Kubernetes", ["kubernetes", "k8s"]),
)


# ─── normalisation ──────────────────────────────────────────────────────────


def words(*texts: str) -> list[str]:
    """Lowercase words of ``texts``: letters and digits apart, everything
    else a break (``IOS-XE 17.9.4a`` -> ``ios xe 17 9 4 a``)."""
    out: list[str] = []
    for text in texts:
        out.extend(_WORD.findall((text or "").lower()))
    return out[:MAX_WORDS * max(1, len(texts))]


def runs(ws: list[str]) -> set[str]:
    """Every run of consecutive words, joined (``ios xe`` -> ios, xe, iosxe)."""
    ws = ws[:MAX_WORDS]
    return {"".join(ws[i:j]) for i in range(len(ws)) for j in range(i + 1, len(ws) + 1)}


def compact(text: str) -> str:
    """``nx-os`` -> ``nxos``: a product or vendor as one word."""
    return "".join(words(text))


# ─── lookup ─────────────────────────────────────────────────────────────────


def _capped(confidence: str, e: Known) -> str:
    return "medium" if e.cap == "medium" else confidence


@dataclass(frozen=True)
class Hit:
    entry: Known
    confidence: str  # high | medium
    alias: str
    #: Matched by an alias that needs no context.
    strong: bool = False


def lookup(names: list[str], manufacturer: str = "", parts: tuple[str, ...] = ("o", "a"),
           ) -> list[Hit]:
    """Known products a subject named ``names`` (its name, slug) made by
    ``manufacturer`` most likely is, best first. A product whose alias is
    part of a longer one that matched (``ios`` in ``iosxe``) is dropped."""
    own: set[str] = set()
    for n in names:
        own |= runs(words(n))
    maker = runs(words(manufacturer)) if manufacturer else set()
    context = own | maker
    found: list[Hit] = []
    for e in KNOWN:
        if e.part not in parts:
            continue
        strong = [a for a in e.aliases if a in own]
        weak = [a for a in e.weak if a in own]
        has_vendor = any(v in context for v in e.vendors)
        if strong:
            found.append(Hit(e, _capped("high", e), max(strong, key=len), True))
        elif weak and maker and e.vendors and not has_vendor:
            # Someone else's product by that word (Apple's iOS).
            continue
        elif weak:
            found.append(Hit(e, _capped("high" if has_vendor else "medium", e),
                             max(weak, key=len)))
        elif e.vendor_default and maker and any(v in maker for v in e.vendors):
            found.append(Hit(e, "medium", ""))
    named = [h for h in found if h.alias]
    kept = [h for h in found
            if not h.alias or not any(o.alias != h.alias and h.alias in o.alias
                                      for o in named)]
    # A product the name itself names beats one only its maker suggests, and
    # a plain alias beats a bare word that needed context it lacked.
    if any(h.alias for h in kept):
        kept = [h for h in kept if h.alias]
    if any(h.strong for h in kept):
        kept = [h for h in kept if h.strong or h.confidence == "high"]
    order = {"high": 0, "medium": 1}
    return sorted(kept, key=lambda h: (order[h.confidence], -len(h.alias)))
