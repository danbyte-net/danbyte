import type { DevicePortLabels, PortLabelSource } from "@/lib/api"

/** The font size (px) that fits `text` inside a `w` × `h` box without ever
 * leaving it: capped by the box height and by the width the glyphs need.
 * Glyph width is taken as 0.62 em (a bold monospace/sans figure), with 14 %
 * of the width and 28 % of the height kept clear as margin, so a fitted
 * label sits inside its port marker rather than on its edges. Longer text
 * only gets smaller, never wider - the box is the hard limit. */
export function fitLabelFontPx(text: string, w: number, h: number): number {
  const n = Math.max(1, text.length)
  const byHeight = h * 0.72
  const byWidth = (w * 0.86) / (0.62 * n)
  return Math.max(0, Math.min(byHeight, byWidth))
}

/** What one port has to offer a label: its own label, its cable's, and the
 * far end of that cable. `hideLabel` is the port's own opt-out. */
export interface PortLabelFacts {
  label?: string | null
  hideLabel?: boolean | null
  cableLabel?: string | null
  peerDevice?: string | null
  /** The far port's own LABEL - a port's name is never printed as a label. */
  peerPortLabel?: string | null
  /** This port's own text colour, when it has one. */
  color?: string | null
}

/** The source in force on one device: the deployment's choice unless the
 * device forces labels off, or on (which prints the port's own label when
 * the deployment prints nothing). */
export function effectivePortLabelSource(
  deployment: PortLabelSource | undefined | null,
  device: DevicePortLabels | undefined | null
): PortLabelSource {
  if (device === "off") return ""
  if (device === "on") return deployment || "interface"
  return deployment ?? ""
}

/** The text a marker prints for `source`, or "" for nothing. */
export function portLabelText(
  source: PortLabelSource,
  facts: PortLabelFacts
): string {
  if (!source || facts.hideLabel) return ""
  switch (source) {
    case "interface":
      return facts.label?.trim() ?? ""
    case "cable":
      return facts.cableLabel?.trim() ?? ""
    case "peer_device":
      return facts.peerDevice?.trim() ?? ""
    case "peer_port":
      return facts.peerPortLabel?.trim() ?? ""
  }
}
