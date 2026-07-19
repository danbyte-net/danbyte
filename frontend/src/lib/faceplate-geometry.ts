/**
 * Physical geometry for the device faceplate renderer.
 *
 * Everything here is in MILLIMETRES, converted to pixels at render time via a
 * px-per-mm scale. Sources: EIA-310 (rack opening 450mm, 1U face 43.7mm),
 * SFF-8432 (SFP module 13.4×8.5mm), QSFP 2×1 stacked cage panel span 21.06mm,
 * OSFP MSA (22.58×13mm). Pitch = centre-to-centre spacing of adjacent ports on
 * real hardware (cage width + inter-port web).
 */

/** Panel constants (mm). `face` is the visible 1U panel height (43.7, not the
 * 44.45 rack pitch); max two port rows fit belly-to-belly in 1U. */
export const PANEL_MM = {
  opening: 450,
  face: 43.7,
  uPitch: 44.45,
  earWidth: 482.6,
  /** Vertical gap between belly-to-belly rows. */
  rowGap: 1.5,
  /** Horizontal gap between banks of ports. */
  bankGap: 4,
  /** Gap around group dividers. */
  groupGap: 6,
} as const

export type ConnectorFamily =
  | "rj45"
  | "sfp"
  | "qsfp"
  | "osfp"
  | "cfp2"
  | "cfp"
  | "xfp"
  | "x2"
  | "gbic"
  | "antenna"
  | "generic"
  | "usb-a"
  | "usb-b"
  | "usb-c"
  | "usb-mini"
  | "hdmi"
  | "vga"
  | "dvi"
  | "displayport"
  | "mini-dp"
  | "dsub-9"
  | "rj11"
  | "sd"
  | "audio"

export interface ConnectorDims {
  /** Faceplate cutout width (mm). */
  w: number
  /** Faceplate cutout height (mm). */
  h: number
  /** Centre-to-centre spacing of adjacent ports (mm). */
  pitch: number
}

export const CONNECTOR_MM: Record<ConnectorFamily, ConnectorDims> = {
  rj45: { w: 15, h: 13, pitch: 17.4 },
  sfp: { w: 14.25, h: 9.5, pitch: 16 },
  qsfp: { w: 18.35, h: 9.5, pitch: 21 },
  osfp: { w: 22.58, h: 13, pitch: 25 },
  cfp2: { w: 41.5, h: 12.4, pitch: 46 },
  cfp: { w: 82, h: 13.6, pitch: 86 },
  xfp: { w: 18.35, h: 9.5, pitch: 21 },
  x2: { w: 36, h: 18, pitch: 39 },
  gbic: { w: 30, h: 12, pitch: 33 },
  antenna: { w: 10, h: 10, pitch: 14 },
  generic: { w: 15, h: 13, pitch: 17.4 },
  "usb-a": { w: 13, h: 6.5, pitch: 15 },
  "usb-b": { w: 12, h: 11, pitch: 14 },
  "usb-c": { w: 10, h: 4.5, pitch: 12 },
  "usb-mini": { w: 8, h: 4.5, pitch: 10 },
  hdmi: { w: 16, h: 7, pitch: 18 },
  vga: { w: 31, h: 12.5, pitch: 33 },
  dvi: { w: 37, h: 10.5, pitch: 40 },
  displayport: { w: 16, h: 6, pitch: 18 },
  "mini-dp": { w: 8, h: 5, pitch: 10 },
  "dsub-9": { w: 31, h: 12.5, pitch: 33 },
  rj11: { w: 12, h: 10, pitch: 14 },
  sd: { w: 27, h: 4, pitch: 29 },
  audio: { w: 8, h: 8, pitch: 10 },
}

/** Families that never stack two rows high in 1U (real hardware doesn't). */
export const SINGLE_ROW_FAMILIES: ReadonlySet<ConnectorFamily> = new Set([
  "cfp",
  "cfp2",
  "x2",
  "gbic",
  "vga",
  "dvi",
  "dsub-9",
])

/** Render scale (pixels per millimetre). At 1.5 an SFP cage is ~21×14px —
 * about today's square size, and still comfortably clickable. */
export const PX_PER_MM = { min: 1.5, default: 1.6, max: 3.2 } as const

/** Below this rendered width (px) the port number is hidden (doesn't fit). */
export const MIN_LABEL_PX = 16

// Ordered matchers — pluggable form-factor suffixes FIRST (every modular slug
// ends in its form factor: "100gbase-x-qsfp28", "64gfc-qsfpp", …), then media
// classes. First hit wins.
const FAMILY_MATCHERS: [RegExp, ConnectorFamily][] = [
  // Pluggable form factors (largest/most-specific tokens first).
  [/osfp1600(-rhs)?$|osfp(-rhs)?$/, "osfp"],
  [
    /qsfpdd1600$|qsfpdd$|qsfp112$|qsfp56$|qsfp28$|qsfpp$|cxp$|cpak$|cdfp$|cfp4$/,
    "qsfp",
  ],
  [/cfp8$|cfp$/, "cfp"],
  [/cfp2$/, "cfp2"],
  [/sfpdd$|dsfp$|sfp56$|sfp28$|sfpp$|sfp$/, "sfp"],
  [/xfp$/, "xfp"],
  [/x2$|xenpak$/, "x2"],
  [/gbic$/, "gbic"],
  // Aux-port / console connector slugs (aux_port_types + console taxonomy).
  [/^usb-a$|^usb-micro-a$/, "usb-a"],
  [/^usb-b$/, "usb-b"],
  [/^usb-c$/, "usb-c"],
  [
    /^usb-mini-[ab]$|^usb-micro-[b]$|^usb-micro-ab$|^mini-hdmi$|^micro-hdmi$/,
    "usb-mini",
  ],
  [/^hdmi$/, "hdmi"],
  [/^vga$/, "vga"],
  [/^dvi$/, "dvi"],
  [/^displayport$/, "displayport"],
  [/^mini-displayport$/, "mini-dp"],
  [/^de-9$|^db-9$/, "dsub-9"],
  [/^db-25$/, "dvi"],
  [/^rj-1[12]$|^rj11$/, "rj11"],
  [/^micro-?sd$|^sd$/, "sd"],
  [/^audio|^3\.5mm/, "audio"],
  // Wireless / cellular — a stub antenna.
  [/^ieee802\.1[15]|^gsm$|^cdma$|^lte$|^4g$|^5g$|^other-wireless$/, "antenna"],
  // Copper media / backplane / legacy WAN / broadband / stacking → RJ45-ish.
  [
    /base-t|base-k|^t1$|^e1$|^t3$|^e3$|xdsl$|docsis$|^moca$|stackwise|flexstack|summitstack|juniper-vcp/,
    "rj45",
  ],
]

/** Interface/aux/console `type` slug → connector family. Unknown or empty
 * slugs render at generic (RJ45-ish) size rather than disappearing. */
export function familyForType(slug: string): ConnectorFamily {
  const s = slug.trim().toLowerCase()
  if (!s) return "generic"
  for (const [re, fam] of FAMILY_MATCHERS) {
    if (re.test(s)) return fam
  }
  return "generic"
}

// TS mirror of api/models.py render_component_name(): resolve {position} /
// {position:N} in a template name. Uses the device's stack position when it
// has one, else the token's standalone default (N, or 1).
const POSITION_TOKEN_RE = /\{position(?::(\d+))?\}/g

/** TS mirror of the backend's render_module_name: `{module}` → the bay's
 * position the module is installed in. No default — an unresolved token
 * stays literal so the gap is visible. */
export function renderModuleName(name: string, modulePosition: string): string {
  if (!modulePosition) return name
  return name.replaceAll("{module}", modulePosition)
}

export function renderTemplateName(
  name: string,
  position: number | null
): string {
  return name.replace(POSITION_TOKEN_RE, (_, def?: string) => {
    const fallback = def !== undefined ? Number(def) : 1
    return String(position ?? fallback)
  })
}
