// Colour helpers shared by every surface that paints a data-driven colour:
// badges, the rack elevation, topology cards, and the diagram exports.

/**
 * Black or white text for a fill, by perceived luminance (Rec. 709).
 *
 * Status and role rows also carry a server-computed `text_color`, from a
 * different luminance formula, and the two disagree near the threshold.
 * ColorBadge, the topology cards and pills, and the diagram exports (SVG,
 * PNG, PDF, draw.io) use this and ignore `text_color`, so a colour reads the
 * same on screen as in an exported file.
 */
export function readableText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return "#fff"
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 0xff
  const g = (v >> 8) & 0xff
  const b = v & 0xff
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return L > 0.6 ? "#0a0a0a" : "#fff"
}
