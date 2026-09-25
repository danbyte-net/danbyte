"""Which Wi-Fi security settings go together (#177).

A security mode says the framework (WPA2/WPA3, Personal/Enterprise, OWE,
open); the cipher and PMF (Protected Management Frames) have to fit it. The
tables here are the one place that says what fits; the serializer refuses
anything else, and the form offers only what fits (frontend
``lib/wifi-security.ts`` mirrors them). Blank always means "not documented".

The older "WPA Personal" / "WPA Enterprise" values stay valid, as they came
in from NetBox and existing records, meaning WPA or WPA2 unspecified.
"""
from __future__ import annotations

PERSONAL = {"wpa-personal", "wpa2-personal", "wpa3-personal", "wpa2-wpa3-personal"}
ENTERPRISE = {"wpa-enterprise", "wpa2-enterprise", "wpa3-enterprise", "wpa2-wpa3-enterprise"}
#: Modes that authenticate with a passphrase stored as the PSK. SAE (WPA3)
#: still derives from one, and WEP has a key of its own.
PSK_MODES = PERSONAL | {"wep"}

#: mode → the ciphers it can run ("" = not documented).
CIPHERS = {
    "": {"", "auto", "tkip", "aes", "gcmp-256"},
    "open": {""},
    "owe": {"", "auto", "aes", "gcmp-256"},
    "wep": {""},
    "wpa-personal": {"", "auto", "tkip", "aes"},
    "wpa-enterprise": {"", "auto", "tkip", "aes"},
    "wpa2-personal": {"", "auto", "tkip", "aes"},
    "wpa2-enterprise": {"", "auto", "tkip", "aes"},
    # WPA3 forbids TKIP; GCMP-256 is WPA3 (Enterprise 192-bit, and SAE-GCMP).
    "wpa3-personal": {"", "auto", "aes", "gcmp-256"},
    "wpa3-enterprise": {"", "auto", "aes", "gcmp-256"},
    # A transition network serves both: only what both sides share.
    "wpa2-wpa3-personal": {"", "auto", "aes"},
    "wpa2-wpa3-enterprise": {"", "auto", "aes"},
}

#: mode → the PMF settings it allows. WPA3 and OWE require PMF; a
#: transition network cannot switch it off; open and WEP have none.
PMF = {
    "": {"", "disabled", "optional", "required"},
    "open": {"", "disabled"},
    "wep": {"", "disabled"},
    "owe": {"", "required"},
    "wpa-personal": {"", "disabled", "optional", "required"},
    "wpa-enterprise": {"", "disabled", "optional", "required"},
    "wpa2-personal": {"", "disabled", "optional", "required"},
    "wpa2-enterprise": {"", "disabled", "optional", "required"},
    "wpa3-personal": {"", "required"},
    "wpa3-enterprise": {"", "required"},
    "wpa2-wpa3-personal": {"", "optional", "required"},
    "wpa2-wpa3-enterprise": {"", "optional", "required"},
}

_CIPHER_NAME = {"auto": "Auto", "tkip": "TKIP", "aes": "AES-CCMP", "gcmp-256": "GCMP-256"}


def problems(mode: str, cipher: str, pmf: str, *, psk: bool) -> dict[str, str]:
    """Field → what is wrong with this combination; empty when it fits.
    ``psk`` is whether the network has (or is being given) a passphrase."""
    mode, cipher, pmf = mode or "", cipher or "", pmf or ""
    out = {}
    if cipher not in CIPHERS.get(mode, CIPHERS[""]):
        out["auth_cipher"] = (
            f"{_CIPHER_NAME.get(cipher, cipher)} doesn't go with this security mode."
            if cipher else "Pick a cipher that goes with this security mode."
        )
    if pmf not in PMF.get(mode, PMF[""]):
        allowed = sorted(p for p in PMF.get(mode, PMF[""]) if p)
        out["pmf"] = f"This security mode allows PMF {' or '.join(allowed)}."
    if psk and mode and mode not in PSK_MODES:
        out["psk"] = ("This security mode takes no passphrase - clear the stored "
                      "one to switch to it.")
    return out
