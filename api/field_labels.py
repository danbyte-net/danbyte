"""Human labels for model and serializer field names.

Shared by the two endpoints that describe fields to the SPA -
``api.editable_fields`` (what a write may set) and ``api.list_fields`` (what a
list row can show as a column) - so a field reads the same in the bulk-edit
dialog, the planned-change editor and the Columns menu.
"""
from __future__ import annotations

# verbose_name is right almost everywhere; these read badly capitalised, and
# acronyms lose their case through `verbose_name.capitalize()`.
LABEL_OVERRIDES: dict[tuple[str, str], str] = {
    ("api.interface", "mode"): "802.1Q mode",
    ("api.vminterface", "mode"): "802.1Q mode",
    ("api.interface", "mtu"): "MTU",
    ("api.vminterface", "mtu"): "MTU",
    ("api.interface", "mgmt_only"): "Management only",
    ("api.interface", "combo_group"): "Combo group",
    ("api.interface", "poe_mode"): "PoE mode",
    ("api.interface", "poe_type"): "PoE type",
    ("api.interface", "vlan"): "Untagged VLAN",
    ("api.vminterface", "vlan"): "Untagged VLAN",
}

# Field names whose verbose_name is an acronym, on every model.
ACRONYM_LABELS: dict[str, str] = {
    "vlan": "VLAN", "vrf": "VRF", "mtu": "MTU", "asn": "ASN", "rir": "RIR",
    "ip": "IP", "vm": "VM",
}

# The same, one word at a time, for names built from several ("oob_ip",
# "primary_ip", "vc_position", "dns_name").
ACRONYM_WORDS: dict[str, str] = {
    **{k: v for k, v in ACRONYM_LABELS.items()},
    "vc": "VC", "mac": "MAC", "dns": "DNS", "oob": "OOB", "id": "ID",
    "url": "URL", "poe": "PoE", "lag": "LAG", "lacp": "LACP", "rd": "RD",
    "bgp": "BGP", "ospf": "OSPF", "eigrp": "EIGRP", "ldp": "LDP", "bfd": "BFD",
    "vtep": "VTEP", "vni": "VNI", "evpn": "EVPN", "nat": "NAT", "ssid": "SSID",
    "psk": "PSK", "fhrp": "FHRP", "snmp": "SNMP", "ssh": "SSH", "api": "API",
    "tls": "TLS", "ipsec": "IPsec", "l2vpn": "L2VPN", "ipv4": "IPv4",
    "ipv6": "IPv6", "dhcp": "DHCP", "sla": "SLA", "cpu": "CPU",
    "vcpus": "vCPUs", "mb": "MB", "gb": "GB", "tb": "TB", "rf": "RF",
    "uuid": "UUID", "fqdn": "FQDN", "ha": "HA", "es": "ES", "rt": "RT",
    "u": "U", "oui": "OUI", "wlan": "WLAN", "vpn": "VPN", "cidr": "CIDR",
    "wwn": "WWN", "vrfs": "VRFs", "vlans": "VLANs", "ips": "IPs", "vms": "VMs",
    "macs": "MACs", "asns": "ASNs", "rirs": "RIRs", "l2vpns": "L2VPNs",
    "mh": "MH",
}

# Timestamps read as the moment, not the column name.
NAME_LABELS: dict[str, str] = {
    "created_at": "Created",
    "updated_at": "Updated",
}


def humanize(text: str) -> str:
    """``"oob_ip"`` → ``"OOB IP"``; ``"primary ip"`` → ``"Primary IP"``.

    Splits on underscores and spaces, upper-cases known acronyms word by word
    and capitalises the first word. Anything already mixed-case is kept.
    """
    words = [w for w in text.replace("_", " ").split(" ") if w]
    out = []
    for i, w in enumerate(words):
        acronym = ACRONYM_WORDS.get(w.lower())
        if acronym and (w.islower() or w.isupper()):
            out.append(acronym)
        elif i == 0:
            out.append(w[:1].upper() + w[1:])
        else:
            out.append(w)
    return " ".join(out)


def label_for_name(name: str) -> str:
    """A label for a bare field name with no model field behind it."""
    return NAME_LABELS.get(name) or ACRONYM_LABELS.get(name) or humanize(name)


def label_for_field(model_label: str, f) -> str:
    """A label for model field ``f`` on the model labelled ``model_label``
    (``"api.interface"``): an explicit override, then a whole-name acronym,
    then the field's verbose_name with acronyms kept."""
    override = LABEL_OVERRIDES.get((model_label, f.name))
    if override:
        return override
    by_name = NAME_LABELS.get(f.name) or ACRONYM_LABELS.get(f.name)
    if by_name:
        return by_name
    verbose = str(getattr(f, "verbose_name", "") or f.name.replace("_", " "))
    return humanize(verbose)
