import type {
  WirelessAuthCipher,
  WirelessAuthType,
  WirelessPmf,
} from "@/lib/api"

// Which Wi-Fi security settings go together (#177). Mirrors
// api/wifi_security.py, which enforces it; here it only narrows the form's
// options so an invalid combination can't be picked. Blank = not documented.

export const SECURITY_MODE_GROUPS: {
  label: string
  options: { value: WirelessAuthType; label: string }[]
}[] = [
  {
    label: "Personal",
    options: [
      { value: "wpa2-personal", label: "WPA2-Personal" },
      { value: "wpa3-personal", label: "WPA3-Personal (SAE)" },
      { value: "wpa2-wpa3-personal", label: "WPA2/WPA3-Personal" },
    ],
  },
  {
    label: "Enterprise",
    options: [
      { value: "wpa2-enterprise", label: "WPA2-Enterprise" },
      { value: "wpa3-enterprise", label: "WPA3-Enterprise" },
      { value: "wpa2-wpa3-enterprise", label: "WPA2/WPA3-Enterprise" },
    ],
  },
  {
    label: "Open",
    options: [
      { value: "owe", label: "Enhanced Open (OWE)" },
      { value: "open", label: "Open" },
    ],
  },
  {
    label: "Legacy",
    options: [
      { value: "wpa-personal", label: "WPA Personal (PSK)" },
      { value: "wpa-enterprise", label: "WPA Enterprise" },
      { value: "wep", label: "WEP (legacy)" },
    ],
  },
]

export const CIPHER_LABEL: Record<Exclude<WirelessAuthCipher, "">, string> = {
  auto: "Auto",
  aes: "AES-CCMP",
  "gcmp-256": "GCMP-256",
  tkip: "TKIP (legacy)",
}

export const PMF_LABEL: Record<Exclude<WirelessPmf, "">, string> = {
  disabled: "Disabled",
  optional: "Optional",
  required: "Required",
}

type Mode = WirelessAuthType

const WPA12: WirelessAuthCipher[] = ["auto", "tkip", "aes"]
const CIPHERS: Record<Mode, WirelessAuthCipher[]> = {
  "": ["auto", "tkip", "aes", "gcmp-256"],
  open: [],
  owe: ["auto", "aes", "gcmp-256"],
  wep: [],
  "wpa-personal": WPA12,
  "wpa-enterprise": WPA12,
  "wpa2-personal": WPA12,
  "wpa2-enterprise": WPA12,
  "wpa3-personal": ["auto", "aes", "gcmp-256"],
  "wpa3-enterprise": ["auto", "aes", "gcmp-256"],
  "wpa2-wpa3-personal": ["auto", "aes"],
  "wpa2-wpa3-enterprise": ["auto", "aes"],
}

const ALL_PMF: WirelessPmf[] = ["disabled", "optional", "required"]
const PMF: Record<Mode, WirelessPmf[]> = {
  "": ALL_PMF,
  open: ["disabled"],
  wep: ["disabled"],
  owe: ["required"],
  "wpa-personal": ALL_PMF,
  "wpa-enterprise": ALL_PMF,
  "wpa2-personal": ALL_PMF,
  "wpa2-enterprise": ALL_PMF,
  "wpa3-personal": ["required"],
  "wpa3-enterprise": ["required"],
  "wpa2-wpa3-personal": ["optional", "required"],
  "wpa2-wpa3-enterprise": ["optional", "required"],
}

/** Modes that authenticate with a stored passphrase. */
const PSK_MODES = new Set<Mode>([
  "wpa-personal",
  "wpa2-personal",
  "wpa3-personal",
  "wpa2-wpa3-personal",
  "wep",
])

export const ciphersFor = (mode: Mode) => CIPHERS[mode]
export const pmfFor = (mode: Mode) => PMF[mode]
/** Blank (not documented) keeps the passphrase field; a mode decides. */
export const takesPassphrase = (mode: Mode) => !mode || PSK_MODES.has(mode)
