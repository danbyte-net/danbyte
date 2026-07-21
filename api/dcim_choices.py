"""Physical-media vocabularies for interfaces and cables.

These are **standards-based taxonomies** (IEEE / TIA / ITU-T media types and
the standard cable/interface type lists), not tenant data — the same kind of
fixed vocabulary as ``Cable.status`` / ``length_unit``. They give the UI a
ready-made dropdown.
Stored as plain ``CharField`` values that default to blank, so nothing is
pre-seeded; deployments can trim/extend the lists here.

The lists are **grouped** (Django "optgroup" choice format): a list of
``(group label, [(value, label), …])`` tuples. Django accepts this directly as
``choices=`` on a model field, ``get_type_display()`` still resolves, and the
``/api/dcim/choices/`` endpoint flattens it to ``{value, label, group}`` rows
so the frontend can render sub-categorised dropdowns.

Slugs track NetBox's interface/cable type vocabulary (v4.5 era) so device-type
imports and operator muscle memory carry over. Background + the parametric
cable-profile plan: ``docs/dcim/type-taxonomy.md``.
"""
from __future__ import annotations

# Type alias for readability: [(group, [(value, label), ...]), ...]
GroupedChoices = list[tuple[str, list[tuple[str, str]]]]

# ─── Interface types (standard interface-type taxonomy) ──────────────────────
INTERFACE_TYPE_CHOICES: GroupedChoices = [
    ("Virtual", [
        ("virtual", "Virtual"),
        ("bridge", "Bridge"),
        ("lag", "Link Aggregation Group (LAG)"),
    ]),
    ("Fast Ethernet (100M)", [
        ("100base-tx", "100BASE-TX (10/100ME)"),
        ("100base-t1", "100BASE-T1 (10/100ME single-pair)"),
        ("100base-fx", "100BASE-FX (10/100ME fiber)"),
        ("100base-lfx", "100BASE-LFX (10/100ME fiber)"),
    ]),
    ("Gigabit Ethernet (1G)", [
        ("1000base-t", "1000BASE-T (1GE)"),
        ("1000base-tx", "1000BASE-TX (1GE)"),
        ("1000base-sx", "1000BASE-SX (1GE)"),
        ("1000base-lx", "1000BASE-LX (1GE)"),
        ("1000base-lx10", "1000BASE-LX10/LH (1GE)"),
        ("1000base-lsx", "1000BASE-LSX (1GE)"),
        ("1000base-ex", "1000BASE-EX (1GE)"),
        ("1000base-zx", "1000BASE-ZX (1GE)"),
        ("1000base-bx10-d", "1000BASE-BX10-D (1GE BiDi Down)"),
        ("1000base-bx10-u", "1000BASE-BX10-U (1GE BiDi Up)"),
        ("1000base-cx", "1000BASE-CX (1GE DAC)"),
        ("1000base-cwdm", "1000BASE-CWDM (1GE)"),
        ("1000base-dwdm", "1000BASE-DWDM (1GE)"),
    ]),
    ("2.5 / 5 Gigabit Ethernet", [
        ("2.5gbase-t", "2.5GBASE-T (2.5GE)"),
        ("5gbase-t", "5GBASE-T (5GE)"),
    ]),
    ("10 Gigabit Ethernet", [
        ("10gbase-t", "10GBASE-T (10GE)"),
        ("10gbase-cx4", "10GBASE-CX4 (10GE DAC)"),
        ("10gbase-cu", "10GBASE-CU (10GE DAC passive twinax)"),
        ("10gbase-sr", "10GBASE-SR (10GE)"),
        ("10gbase-lr", "10GBASE-LR (10GE)"),
        ("10gbase-lrm", "10GBASE-LRM (10GE)"),
        ("10gbase-lx4", "10GBASE-LX4 (10GE)"),
        ("10gbase-er", "10GBASE-ER (10GE)"),
        ("10gbase-zr", "10GBASE-ZR (10GE)"),
        ("10gbase-br-d", "10GBASE-BR-D (10GE BiDi Down)"),
        ("10gbase-br-u", "10GBASE-BR-U (10GE BiDi Up)"),
    ]),
    ("25 Gigabit Ethernet", [
        ("25gbase-t", "25GBASE-T (25GE)"),
        ("25gbase-cr", "25GBASE-CR (25GE DAC)"),
        ("25gbase-sr", "25GBASE-SR (25GE)"),
        ("25gbase-lr", "25GBASE-LR (25GE)"),
        ("25gbase-er", "25GBASE-ER (25GE)"),
    ]),
    ("40 Gigabit Ethernet", [
        ("40gbase-cr4", "40GBASE-CR4 (40GE DAC)"),
        ("40gbase-sr4", "40GBASE-SR4 (40GE)"),
        ("40gbase-sr4-bd", "40GBASE-SR4 (40GE BiDi)"),
        ("40gbase-lr4", "40GBASE-LR4 (40GE)"),
        ("40gbase-fr4", "40GBASE-FR4 (40GE)"),
        ("40gbase-er4", "40GBASE-ER4 (40GE)"),
    ]),
    ("50 Gigabit Ethernet", [
        ("50gbase-cr", "50GBASE-CR (50GE DAC)"),
        ("50gbase-sr", "50GBASE-SR (50GE)"),
        ("50gbase-fr", "50GBASE-FR (50GE)"),
        ("50gbase-lr", "50GBASE-LR (50GE)"),
        ("50gbase-er", "50GBASE-ER (50GE)"),
    ]),
    ("100 Gigabit Ethernet", [
        ("100gbase-cr1", "100GBASE-CR1 (100GE DAC)"),
        ("100gbase-cr2", "100GBASE-CR2 (100GE DAC)"),
        ("100gbase-cr4", "100GBASE-CR4 (100GE DAC)"),
        ("100gbase-cr10", "100GBASE-CR10 (100GE DAC)"),
        ("100gbase-sr1", "100GBASE-SR1 (100GE)"),
        ("100gbase-sr1.2", "100GBASE-SR1.2 (100GE BiDi)"),
        ("100gbase-sr2", "100GBASE-SR2 (100GE)"),
        ("100gbase-sr4", "100GBASE-SR4 (100GE)"),
        ("100gbase-sr10", "100GBASE-SR10 (100GE)"),
        ("100gbase-dr", "100GBASE-DR (100GE)"),
        ("100gbase-fr1", "100GBASE-FR1 (100GE)"),
        ("100gbase-lr1", "100GBASE-LR1 (100GE)"),
        ("100gbase-lr4", "100GBASE-LR4 (100GE)"),
        ("100gbase-er4", "100GBASE-ER4 (100GE)"),
        ("100gbase-cwdm4", "100GBASE-CWDM4 (100GE)"),
        ("100gbase-zr", "100GBASE-ZR (100GE)"),
    ]),
    ("200 Gigabit Ethernet", [
        ("200gbase-cr2", "200GBASE-CR2 (200GE DAC)"),
        ("200gbase-cr4", "200GBASE-CR4 (200GE DAC)"),
        ("200gbase-sr2", "200GBASE-SR2 (200GE)"),
        ("200gbase-sr4", "200GBASE-SR4 (200GE)"),
        ("200gbase-vr2", "200GBASE-VR2 (200GE)"),
        ("200gbase-dr4", "200GBASE-DR4 (200GE)"),
        ("200gbase-fr4", "200GBASE-FR4 (200GE)"),
        ("200gbase-lr4", "200GBASE-LR4 (200GE)"),
        ("200gbase-er4", "200GBASE-ER4 (200GE)"),
    ]),
    ("400 Gigabit Ethernet", [
        ("400gbase-cr4", "400GBASE-CR4 (400GE DAC)"),
        ("400gbase-sr4", "400GBASE-SR4 (400GE)"),
        ("400gbase-sr4_2", "400GBASE-SR4.2 (400GE BiDi)"),
        ("400gbase-sr8", "400GBASE-SR8 (400GE)"),
        ("400gbase-sr16", "400GBASE-SR16 (400GE)"),
        ("400gbase-vr4", "400GBASE-VR4 (400GE)"),
        ("400gbase-dr4", "400GBASE-DR4 (400GE)"),
        ("400gbase-fr4", "400GBASE-FR4 (400GE)"),
        ("400gbase-fr8", "400GBASE-FR8 (400GE)"),
        ("400gbase-lr4", "400GBASE-LR4 (400GE)"),
        ("400gbase-lr8", "400GBASE-LR8 (400GE)"),
        ("400gbase-er8", "400GBASE-ER8 (400GE)"),
        ("400gbase-zr", "400GBASE-ZR (400GE)"),
    ]),
    ("800 Gigabit Ethernet", [
        ("800gbase-cr8", "800GBASE-CR8 (800GE DAC)"),
        ("800gbase-sr8", "800GBASE-SR8 (800GE)"),
        ("800gbase-vr8", "800GBASE-VR8 (800GE)"),
        ("800gbase-dr8", "800GBASE-DR8 (800GE)"),
    ]),
    ("1.6 Terabit Ethernet", [
        ("1.6tbase-cr8", "1.6TBASE-CR8 (1.6TE DAC)"),
        ("1.6tbase-dr8", "1.6TBASE-DR8 (1.6TE)"),
        ("1.6tbase-dr8-2", "1.6TBASE-DR8-2 (1.6TE)"),
    ]),
    ("Ethernet (pluggable transceivers)", [
        ("100base-x-sfp", "SFP (100ME)"),
        ("1000base-x-gbic", "GBIC (1GE)"),
        ("1000base-x-sfp", "SFP (1GE)"),
        ("2.5gbase-x-sfp", "SFP (2.5GE)"),
        ("10gbase-x-sfpp", "SFP+ (10GE)"),
        ("10gbase-x-xfp", "XFP (10GE)"),
        ("10gbase-x-x2", "X2 (10GE)"),
        ("10gbase-x-xenpak", "XENPAK (10GE)"),
        ("25gbase-x-sfp28", "SFP28 (25GE)"),
        ("40gbase-x-qsfpp", "QSFP+ (40GE)"),
        ("50gbase-x-qsfp28", "QSFP28 (50GE)"),
        ("50gbase-x-sfp56", "SFP56 (50GE)"),
        ("100gbase-x-cfp", "CFP (100GE)"),
        ("100gbase-x-cfp2", "CFP2 (100GE)"),
        ("100gbase-x-cfp4", "CFP4 (100GE)"),
        ("100gbase-x-cxp", "CXP (100GE)"),
        ("100gbase-x-cpak", "Cisco CPAK (100GE)"),
        ("100gbase-x-dsfp", "DSFP (100GE)"),
        ("100gbase-x-sfpdd", "SFP-DD (100GE)"),
        ("100gbase-x-qsfp28", "QSFP28 (100GE)"),
        ("100gbase-x-qsfpdd", "QSFP-DD (100GE)"),
        ("200gbase-x-cfp2", "CFP2 (200GE)"),
        ("200gbase-x-qsfp56", "QSFP56 (200GE)"),
        ("200gbase-x-qsfpdd", "QSFP-DD (200GE)"),
        ("400gbase-x-cfp2", "CFP2 (400GE)"),
        ("400gbase-x-cfp8", "CFP8 (400GE)"),
        ("400gbase-x-cdfp", "CDFP (400GE)"),
        ("400gbase-x-qsfp112", "QSFP112 (400GE)"),
        ("400gbase-x-qsfpdd", "QSFP-DD (400GE)"),
        ("400gbase-x-osfp", "OSFP (400GE)"),
        ("400gbase-x-osfp-rhs", "OSFP-RHS (400GE)"),
        ("800gbase-x-qsfpdd", "QSFP-DD (800GE)"),
        ("800gbase-x-osfp", "OSFP (800GE)"),
        ("1.6tbase-x-osfp1600", "OSFP1600 (1.6TE)"),
        ("1.6tbase-x-osfp1600-rhs", "OSFP1600-RHS (1.6TE)"),
        ("1.6tbase-x-qsfpdd1600", "QSFP-DD1600 (1.6TE)"),
    ]),
    ("Ethernet (backplane)", [
        ("1000base-kx", "1000BASE-KX (1GE)"),
        ("2.5gbase-kx", "2.5GBASE-KX (2.5GE)"),
        ("5gbase-kr", "5GBASE-KR (5GE)"),
        ("10gbase-kr", "10GBASE-KR (10GE)"),
        ("10gbase-kx4", "10GBASE-KX4 (10GE)"),
        ("25gbase-kr", "25GBASE-KR (25GE)"),
        ("40gbase-kr4", "40GBASE-KR4 (40GE)"),
        ("50gbase-kr", "50GBASE-KR (50GE)"),
        ("100gbase-kp4", "100GBASE-KP4 (100GE)"),
        ("100gbase-kr2", "100GBASE-KR2 (100GE)"),
        ("100gbase-kr4", "100GBASE-KR4 (100GE)"),
        ("1.6tbase-kr8", "1.6TBASE-KR8 (1.6TE)"),
    ]),
    ("Wireless", [
        ("ieee802.11a", "IEEE 802.11a"),
        ("ieee802.11g", "IEEE 802.11b/g"),
        ("ieee802.11n", "IEEE 802.11n (Wi-Fi 4)"),
        ("ieee802.11ac", "IEEE 802.11ac (Wi-Fi 5)"),
        ("ieee802.11ad", "IEEE 802.11ad (WiGig)"),
        ("ieee802.11ax", "IEEE 802.11ax (Wi-Fi 6)"),
        ("ieee802.11ay", "IEEE 802.11ay (WiGig)"),
        ("ieee802.11be", "IEEE 802.11be (Wi-Fi 7)"),
        ("ieee802.15.1", "IEEE 802.15.1 (Bluetooth)"),
        ("ieee802.15.4", "IEEE 802.15.4 (LR-WPAN)"),
        ("other-wireless", "Other (wireless)"),
    ]),
    ("Cellular", [
        ("gsm", "GSM"),
        ("cdma", "CDMA"),
        ("lte", "LTE"),
        ("4g", "4G"),
        ("5g", "5G"),
    ]),
    ("SONET / SDH", [
        ("sonet-oc3", "OC-3 / STM-1"),
        ("sonet-oc12", "OC-12 / STM-4"),
        ("sonet-oc48", "OC-48 / STM-16"),
        ("sonet-oc192", "OC-192 / STM-64"),
        ("sonet-oc768", "OC-768 / STM-256"),
        ("sonet-oc1920", "OC-1920 / STM-640"),
        ("sonet-oc3840", "OC-3840 / STM-1280"),
    ]),
    ("Fibre Channel", [
        ("1gfc-sfp", "SFP (1GFC)"),
        ("2gfc-sfp", "SFP (2GFC)"),
        ("4gfc-sfp", "SFP (4GFC)"),
        ("8gfc-sfpp", "SFP+ (8GFC)"),
        ("16gfc-sfpp", "SFP+ (16GFC)"),
        ("32gfc-sfpp", "SFP+ (32GFC)"),
        ("32gfc-sfp28", "SFP28 (32GFC)"),
        ("64gfc-sfpp", "SFP+ (64GFC)"),
        ("64gfc-sfpdd", "SFP-DD (64GFC)"),
        ("64gfc-qsfpp", "QSFP+ (64GFC)"),
        ("128gfc-qsfp28", "QSFP28 (128GFC)"),
    ]),
    ("InfiniBand", [
        ("infiniband-sdr", "InfiniBand SDR (2 Gbps)"),
        ("infiniband-ddr", "InfiniBand DDR (4 Gbps)"),
        ("infiniband-qdr", "InfiniBand QDR (8 Gbps)"),
        ("infiniband-fdr10", "InfiniBand FDR10 (10 Gbps)"),
        ("infiniband-fdr", "InfiniBand FDR (13.5 Gbps)"),
        ("infiniband-edr", "InfiniBand EDR (25 Gbps)"),
        ("infiniband-hdr", "InfiniBand HDR (50 Gbps)"),
        ("infiniband-ndr", "InfiniBand NDR (100 Gbps)"),
        ("infiniband-xdr", "InfiniBand XDR (250 Gbps)"),
    ]),
    ("Serial / WAN", [
        ("t1", "T1 (1.544 Mbps)"),
        ("e1", "E1 (2.048 Mbps)"),
        ("t3", "T3 (45 Mbps)"),
        ("e3", "E3 (34 Mbps)"),
    ]),
    ("Broadband (DSL / coax)", [
        ("xdsl", "xDSL"),
        ("docsis", "DOCSIS"),
        ("moca", "MoCA"),
    ]),
    ("PON", [
        ("bpon", "BPON (622 Mbps / 155 Mbps)"),
        ("epon", "EPON (1 Gbps)"),
        ("10g-epon", "10G-EPON (10 Gbps)"),
        ("gpon", "GPON (2.5 Gbps / 1.25 Gbps)"),
        ("xg-pon", "XG-PON (10 Gbps / 2.5 Gbps)"),
        ("xgs-pon", "XGS-PON (10 Gbps)"),
        ("ng-pon2", "NG-PON2 (TWDM-PON)"),
        ("25g-pon", "25G-PON (25 Gbps)"),
        ("50g-pon", "50G-PON (50 Gbps)"),
    ]),
    ("Stacking", [
        ("cisco-stackwise", "Cisco StackWise"),
        ("cisco-stackwise-plus", "Cisco StackWise Plus"),
        ("cisco-flexstack", "Cisco FlexStack"),
        ("cisco-flexstack-plus", "Cisco FlexStack Plus"),
        ("cisco-stackwise-80", "Cisco StackWise-80"),
        ("cisco-stackwise-160", "Cisco StackWise-160"),
        ("cisco-stackwise-320", "Cisco StackWise-320"),
        ("cisco-stackwise-480", "Cisco StackWise-480"),
        ("cisco-stackwise-1t", "Cisco StackWise-1T"),
        ("juniper-vcp", "Juniper VCP"),
        ("extreme-summitstack", "Extreme SummitStack"),
        ("extreme-summitstack-128", "Extreme SummitStack-128"),
        ("extreme-summitstack-256", "Extreme SummitStack-256"),
        ("extreme-summitstack-512", "Extreme SummitStack-512"),
    ]),
    ("Other", [
        ("other", "Other"),
    ]),
]

# ─── Cable types (standard cable-type taxonomy) ──────────────────────────────
CABLE_TYPE_CHOICES: GroupedChoices = [
    ("Copper — twisted pair", [
        ("cat3", "CAT3"),
        ("cat5", "CAT5"),
        ("cat5e", "CAT5e"),
        ("cat6", "CAT6"),
        ("cat6a", "CAT6a"),
        ("cat7", "CAT7"),
        ("cat7a", "CAT7a"),
        ("cat8", "CAT8"),
        ("mrj21-trunk", "MRJ21 Trunk"),
    ]),
    ("Copper — twinax / DAC", [
        ("dac-active", "Direct Attach Copper (Active)"),
        ("dac-passive", "Direct Attach Copper (Passive)"),
    ]),
    ("Copper — coaxial", [
        ("coaxial", "Coaxial"),
        ("rg-6", "RG-6"),
        ("rg-8", "RG-8"),
        ("rg-11", "RG-11"),
        ("rg-59", "RG-59"),
        ("rg-62", "RG-62"),
        ("rg-213", "RG-213"),
        ("lmr-100", "LMR-100"),
        ("lmr-200", "LMR-200"),
        ("lmr-400", "LMR-400"),
    ]),
    ("Fiber — multimode", [
        ("mmf", "Multimode Fiber"),
        ("mmf-om1", "Multimode Fiber (OM1)"),
        ("mmf-om2", "Multimode Fiber (OM2)"),
        ("mmf-om3", "Multimode Fiber (OM3)"),
        ("mmf-om4", "Multimode Fiber (OM4)"),
        ("mmf-om5", "Multimode Fiber (OM5)"),
    ]),
    ("Fiber — single-mode", [
        ("smf", "Single-mode Fiber"),
        ("smf-os1", "Single-mode Fiber (OS1)"),
        ("smf-os2", "Single-mode Fiber (OS2)"),
    ]),
    ("Fiber — other", [
        ("aoc", "Active Optical Cabling (AOC)"),
    ]),
    ("Power / other", [
        ("power", "Power"),
        ("usb", "USB"),
    ]),
]


# ─── Console port types (serial / USB console connectors) ────────────────────
# NetBox's consoleport type vocabulary, so devicetype-library imports carry over.
CONSOLE_PORT_TYPE_CHOICES: GroupedChoices = [
    ("Serial", [
        ("de-9", "DE-9"),
        ("db-25", "DB-25"),
        ("rj-11", "RJ-11"),
        ("rj-12", "RJ-12"),
        ("rj-45", "RJ-45"),
        ("mini-din-8", "Mini-DIN 8"),
    ]),
    ("USB", [
        ("usb-a", "USB Type A"),
        ("usb-b", "USB Type B"),
        ("usb-c", "USB Type C"),
        ("usb-mini-a", "USB Mini A"),
        ("usb-mini-b", "USB Mini B"),
        ("usb-micro-a", "USB Micro A"),
        ("usb-micro-b", "USB Micro B"),
        ("usb-micro-ab", "USB Micro AB"),
    ]),
    ("Other", [
        ("other", "Other"),
    ]),
]

# ─── Power port types (device power inlets) ──────────────────────────────────
# The high-traffic subset of NetBox's (very long) power connector taxonomy —
# IEC 60320 couplers, NEMA locking/non-locking, and DC. Free-text still allowed
# (fields are lenient CharFields), so anything else round-trips on import.
POWER_PORT_TYPE_CHOICES: GroupedChoices = [
    ("IEC 60320", [
        ("iec-60320-c6", "C6"),
        ("iec-60320-c8", "C8"),
        ("iec-60320-c14", "C14"),
        ("iec-60320-c16", "C16"),
        ("iec-60320-c20", "C20"),
        ("iec-60320-c22", "C22"),
    ]),
    ("NEMA (non-locking)", [
        ("nema-5-15p", "NEMA 5-15P"),
        ("nema-5-20p", "NEMA 5-20P"),
        ("nema-6-15p", "NEMA 6-15P"),
        ("nema-6-20p", "NEMA 6-20P"),
    ]),
    ("NEMA (locking)", [
        ("nema-l5-20p", "NEMA L5-20P"),
        ("nema-l5-30p", "NEMA L5-30P"),
        ("nema-l6-20p", "NEMA L6-20P"),
        ("nema-l6-30p", "NEMA L6-30P"),
    ]),
    ("DC", [
        ("dc-terminal", "DC Terminal"),
        ("saf-d-grid", "Saf-D-Grid"),
    ]),
    ("Other", [
        ("hardwired", "Hardwired"),
        ("other", "Other"),
    ]),
]

# ─── Power outlet types (PDU outlets) ────────────────────────────────────────
POWER_OUTLET_TYPE_CHOICES: GroupedChoices = [
    ("IEC 60320", [
        ("iec-60320-c5", "C5"),
        ("iec-60320-c7", "C7"),
        ("iec-60320-c13", "C13"),
        ("iec-60320-c15", "C15"),
        ("iec-60320-c19", "C19"),
        ("iec-60320-c21", "C21"),
    ]),
    ("NEMA (non-locking)", [
        ("nema-5-15r", "NEMA 5-15R"),
        ("nema-5-20r", "NEMA 5-20R"),
        ("nema-6-15r", "NEMA 6-15R"),
        ("nema-6-20r", "NEMA 6-20R"),
    ]),
    ("NEMA (locking)", [
        ("nema-l5-20r", "NEMA L5-20R"),
        ("nema-l5-30r", "NEMA L5-30R"),
        ("nema-l6-20r", "NEMA L6-20R"),
        ("nema-l6-30r", "NEMA L6-30R"),
    ]),
    ("DC", [
        ("dc-terminal", "DC Terminal"),
        ("saf-d-grid", "Saf-D-Grid"),
    ]),
    ("Other", [
        ("hardwired", "Hardwired"),
        ("other", "Other"),
    ]),
]


# ─── Aux port types (everything no other component type models) ─────────────
# USB data ports, video outputs, card slots, grounding — the "model
# everything" catch-all. USB *console* stays a console-port type.
AUX_PORT_TYPE_CHOICES: GroupedChoices = [
    ("USB", [
        ("usb-a", "USB Type A"),
        ("usb-b", "USB Type B"),
        ("usb-c", "USB Type C"),
        ("usb-mini-b", "USB Mini B"),
        ("usb-micro-b", "USB Micro B"),
    ]),
    ("Video", [
        ("hdmi", "HDMI"),
        ("mini-hdmi", "Mini HDMI"),
        ("vga", "VGA (DE-15)"),
        ("dvi", "DVI"),
        ("displayport", "DisplayPort"),
        ("mini-displayport", "Mini DisplayPort"),
    ]),
    ("Storage", [
        ("sd", "SD card"),
        ("microsd", "microSD card"),
    ]),
    ("Other", [
        ("rj11", "RJ11"),
        ("audio-3.5mm", "Audio 3.5 mm"),
        ("grounding", "Grounding lug"),
        ("other", "Other"),
    ]),
]


# ─── Front / rear port connector types ──────────────────────────────────────
# The panel connector. Fibre connectors carry a standard **fibre count** (see
# CONNECTOR_FIBERS) that pre-fills a front port's `positions`; copper is 1.
FRONT_PORT_TYPE_CHOICES: GroupedChoices = [
    ("Fibre — simplex/duplex", [
        ("lc", "LC (simplex)"),
        ("lc-duplex", "LC Duplex"),
        ("lc-apc", "LC/APC (simplex)"),
        ("lc-apc-duplex", "LC/APC Duplex"),
        ("sc", "SC (simplex)"),
        ("sc-duplex", "SC Duplex"),
        ("sc-apc", "SC/APC (simplex)"),
        ("st", "ST"),
        ("fc", "FC"),
        ("mtrj", "MTRJ (duplex)"),
    ]),
    ("Fibre — array (MPO/MTP)", [
        ("mpo-8", "MPO-8 / MTP-8"),
        ("mpo-12", "MPO-12 / MTP-12"),
        ("mpo-16", "MPO-16 / MTP-16"),
        ("mpo-24", "MPO-24 / MTP-24"),
    ]),
    ("Copper", [
        ("8p8c", "8P8C (RJ45)"),
        ("8p6c", "8P6C"),
        ("8p4c", "8P4C"),
        ("8p2c", "8P2C"),
        ("gg45", "GG45"),
        ("tera-4p", "TERA 4P"),
        ("bnc", "BNC"),
        ("f", "F connector"),
        ("mrj21", "MRJ21"),
    ]),
    ("Other", [
        ("other", "Other"),
    ]),
]

# Fibre count per connector — used to pre-fill FrontPort.positions. Anything
# not listed (copper, other) defaults to 1. An industry spec, not tenant data.
CONNECTOR_FIBERS: dict[str, int] = {
    "lc-duplex": 2, "lc-apc-duplex": 2, "sc-duplex": 2, "mtrj": 2,
    "mpo-8": 8, "mpo-12": 12, "mpo-16": 16, "mpo-24": 24,
}


def flatten_choices(groups: GroupedChoices) -> list[tuple[str, str]]:
    """Grouped → flat ``[(value, label), …]`` (e.g. for validation sets)."""
    return [(value, label) for _, options in groups for value, label in options]


# Free-text speed suggestions (the `speed` field stays free-form; these populate
# a datalist dropdown). Danbyte's short "10G" style, not raw kbps ints.
COMMON_SPEEDS: list[str] = [
    "10M", "100M", "1G", "2.5G", "5G", "10G", "25G",
    "40G", "50G", "100G", "200G", "400G", "800G", "1.6T",
]


from django.apps import apps
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response


@extend_schema(
    summary="DCIM type/choice vocabularies for interface, cable, and port dropdowns",
    tags=["dcim"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Single source of truth for the DCIM dropdowns: grouped interface, "
            "cable, console/power/aux/front-port type choices (each row carries "
            "value/label/group), duplex/mode/PoE options, connector fibre counts, "
            "and common speed suggestions."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def dcim_choices_view(request):
    """``GET /api/dcim/choices/`` — single source of truth for the interface /
    cable type dropdowns + speed suggestions (the frontend fetches this rather
    than duplicating the long lists). Each choice carries its ``group`` so the
    UI can render sub-categorised (optgroup-style) dropdowns."""

    def fmt(groups: GroupedChoices):
        return [
            {"value": value, "label": label, "group": group}
            for group, options in groups
            for value, label in options
        ]

    def flat(pairs):
        return [{"value": v, "label": l} for v, l in pairs]

    return Response({
        "interface_types": fmt(INTERFACE_TYPE_CHOICES),
        "interface_duplex": flat([
            ("half", "Half"), ("full", "Full"), ("auto", "Auto"),
        ]),
        # Sourced from the model fields themselves so the dropdowns can never
        # drift from what `bulk_update` will accept.
        "interface_modes": flat(
            apps.get_model("api", "Interface")._meta.get_field("mode").flatchoices
        ),
        "feed_legs": flat(
            apps.get_model("api", "PowerOutlet")._meta.get_field("feed_leg").flatchoices
        ),
        "poe_modes": flat([
            ("pd", "PD (powered device)"), ("pse", "PSE (supplying power)"),
        ]),
        "poe_types": flat([
            ("type1-ieee802.3af", "802.3af (Type 1)"),
            ("type2-ieee802.3at", "802.3at (Type 2)"),
            ("type3-ieee802.3bt", "802.3bt (Type 3)"),
            ("type4-ieee802.3bt", "802.3bt (Type 4)"),
            ("passive-24v-2pair", "Passive 24V (2-pair)"),
            ("passive-24v-4pair", "Passive 24V (4-pair)"),
            ("passive-48v-2pair", "Passive 48V (2-pair)"),
            ("passive-48v-4pair", "Passive 48V (4-pair)"),
        ]),
        "cable_types": fmt(CABLE_TYPE_CHOICES),
        "front_port_types": fmt(FRONT_PORT_TYPE_CHOICES),
        # value → fibre count, so the front-port form can pre-fill `positions`.
        "connector_fibers": CONNECTOR_FIBERS,
        "console_port_types": fmt(CONSOLE_PORT_TYPE_CHOICES),
        "power_port_types": fmt(POWER_PORT_TYPE_CHOICES),
        "power_outlet_types": fmt(POWER_OUTLET_TYPE_CHOICES),
        "aux_port_types": fmt(AUX_PORT_TYPE_CHOICES),
        "common_speeds": COMMON_SPEEDS,
    })
