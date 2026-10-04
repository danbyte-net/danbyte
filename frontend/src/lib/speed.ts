/**
 * Speeds - the ONE parser, formatter and colour scale for port and link
 * speeds. The faceplate (`faceplate-colors`), the 3D room, the topology's
 * Speed colouring and the site map all read a speed through here, so "10G"
 * means the same number and wears the same colour everywhere.
 *
 * The rules mirror the server (`api/speed.py`, `api/link_capacity.py`): a
 * bare integer is kbps, and the short form is the server's link label.
 */

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** A number, a unit letter, then an optional unit tail ("bps", "bit/s",
 * "b/s", "bE"/"E" as in 10GbE). The unit must end the word: "25GBASE-SR" is
 * an interface type, not a speed. Anything after a word break is ignored. */
const SPEED_RE =
  /^(\d+(?:\.\d+)?)\s*([kmgt])(?:bps|bits?(?:\/s)?|b\/s|be|b|e)?(?![a-z0-9])/i

const UNIT_MBPS: Record<string, number> = {
  k: 0.001,
  m: 1,
  g: 1_000,
  t: 1_000_000,
}

/**
 * Mbps from a speed as Danbyte stores it - "10G", "2.5 Gbps", "100M",
 * "1 Gbit/s", "1.6T", "512k" - or null when it isn't one. A bare integer is
 * **kbps** ("1000000" is 1G), the convention the server and switch scrapers
 * use for a numeric speed.
 */
export function parseSpeedMbps(
  value: string | null | undefined
): number | null {
  const text = (value ?? "").trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text) / 1_000
  const m = SPEED_RE.exec(text)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return n * UNIT_MBPS[m[2].toLowerCase()]
}

/**
 * A speed typed into a form, in whole kbps for a `*_kbps` field: "500M" is
 * 500000, "1G" 1000000, a bare number kbps as above. Null for blank text;
 * undefined when the text is not a speed above zero, so the form can say so
 * rather than store a guess.
 */
export function parseSpeedKbps(
  value: string | null | undefined
): number | null | undefined {
  if (!(value ?? "").trim()) return null
  const mbps = parseSpeedMbps(value)
  if (mbps == null) return undefined
  const kbps = Math.round(mbps * 1_000)
  return kbps >= 1 ? kbps : undefined
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export interface SpeedFormat {
  /** "10 Gbps" rather than "10G". */
  long?: boolean
  /** The other direction, in the same unit as the value, when it differs:
   * "100/20M", "1G/100M". */
  up?: number | null
}

/** Python's `:g` for the values a speed scales to (never exponent-sized). */
function g(n: number): string {
  return String(Number(n.toPrecision(6)))
}

/** One value in kbps → [number, unit letter]: G at 1 Gbps, M at 1 Mbps,
 * else k - the server's `short()` scaling. */
function scale(kbps: number): [string, "G" | "M" | "k"] {
  if (kbps >= 1_000_000) return [g(kbps / 1_000_000), "G"]
  if (kbps >= 1_000) return [g(kbps / 1_000), "M"]
  return [g(kbps), "k"]
}

const known = (v: number | null | undefined): v is number =>
  v != null && Number.isFinite(v) && v > 0

/**
 * A speed in kbps as text: the short form (`10G`, `500M`, `2.5G`, `64k`; an
 * asymmetric link as `100/20M` or `1G/100M`) - the same label the server
 * puts on a site map link - or the long form (`10 Gbps`, `100/20 Mbps`,
 * `1 Gbps / 100 Mbps`). Blank when unknown, never a guess.
 */
export function fmtKbps(
  kbps: number | null | undefined,
  { long = false, up }: SpeedFormat = {}
): string {
  if (!known(kbps)) return ""
  const [down, unit] = scale(kbps)
  const pair = known(up) && up !== kbps ? scale(up) : null
  const suffix = (u: string) => (long ? ` ${u}bps` : u)
  if (!pair) return `${down}${suffix(unit)}`
  const [upN, upUnit] = pair
  if (upUnit === unit) return `${down}/${upN}${suffix(unit)}`
  return long
    ? `${down}${suffix(unit)} / ${upN}${suffix(upUnit)}`
    : `${down}${unit}/${upN}${upUnit}`
}

/** {@link fmtKbps} for a speed in Mbps (an SNMP-observed speed, a parsed
 * interface speed). `up` is in Mbps too. */
export function fmtMbps(
  mbps: number | null | undefined,
  { long, up }: SpeedFormat = {}
): string {
  if (!known(mbps)) return ""
  return fmtKbps(mbps * 1_000, { long, up: known(up) ? up * 1_000 : null })
}

// ─── The colour scale ────────────────────────────────────────────────────────

export interface SpeedTier {
  /** Lower bound (Mbps) - a speed belongs to the highest tier it reaches. */
  minMbps: number
  label: string
  hex: string
}

/**
 * The ramp, slow → fast. Tailwind tints, hue-ordered so speed reads as
 * temperature: amber (legacy and WAN) → emerald/teal (access) → sky/blue/
 * indigo (aggregation) → violet/purple/fuchsia (core, 100G–1.6T).
 *
 * The 100M tier splits the old single sub-1G tier, so a 50M circuit and a
 * 500M one no longer look alike. 100M keeps the old tier's amber; below it
 * is the darker amber-700, which clears amber-500, the neutral port greys
 * and the live "down" red better than any orange (palette check, OKLab).
 */
export const SPEED_TIERS: readonly SpeedTier[] = [
  { minMbps: 0, label: "<100M", hex: "#b45309" }, // 10M, sub-100M WAN
  { minMbps: 100, label: "100M", hex: "#f59e0b" }, // FE, 100–999M WAN
  { minMbps: 1_000, label: "1G", hex: "#10b981" },
  { minMbps: 2_500, label: "2.5G", hex: "#14b8a6" }, // 2.5/5G multigig
  { minMbps: 10_000, label: "10G", hex: "#0ea5e9" },
  { minMbps: 25_000, label: "25G", hex: "#3b82f6" },
  { minMbps: 40_000, label: "40G", hex: "#6366f1" }, // 40/50G
  { minMbps: 100_000, label: "100G", hex: "#8b5cf6" },
  { minMbps: 200_000, label: "200G", hex: "#a855f7" }, // 200/300G
  { minMbps: 400_000, label: "400G+", hex: "#d946ef" }, // 400G…1.6T
]

/** The tier a speed (Mbps) falls in - the highest bound it reaches. */
export function speedTier(mbps: number): SpeedTier {
  let tier = SPEED_TIERS[0]
  for (const t of SPEED_TIERS) if (mbps >= t.minMbps) tier = t
  return tier
}

/** The tier of a speed as text, or null when it doesn't parse. */
export function speedTierOf(
  value: string | null | undefined
): SpeedTier | null {
  const mbps = parseSpeedMbps(value)
  return mbps == null ? null : speedTier(mbps)
}
