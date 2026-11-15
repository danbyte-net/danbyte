/**
 * Status LEDs (docs/dcim/model-packs.md → Status LEDs): the pure part - the
 * state vocabulary the server sends (`/api/device-leds/`), how each state
 * looks and whether it blinks, and which state a named LED takes. No
 * three.js and no DOM, so it tests without a canvas; the 3D binding
 * (floorplan3d/led-binding) and the 2D overlay (components/led-overlay)
 * both read it.
 *
 * A state is `green`, `amber`, `red`, `blue`, `neutral` or `off`, with
 * `_blink` appended to a blinking one. The payload names only the lights
 * that are on: anything it leaves out - unknown, stale, not bound - is off.
 */

export type LedColor = "green" | "amber" | "red" | "blue"
export type LedBase = LedColor | "neutral" | "off"
export type LedState = LedBase | `${LedColor}_blink`

/** One device's lights: the chassis' by LED id (`SYS`, `port:Te1/0/1`)
 * and each bay's installed module's, by bay name then LED id. */
export interface DeviceLeds {
  leds: Partial<Record<string, LedState>>
  bays: Partial<Record<string, Partial<Record<string, LedState>>>>
  /** The locate beacon while it is on. */
  locate: { until: string; at: string | null; by: string } | null
}

/** `GET|POST /api/device-leds/`. */
export interface DeviceLedsPayload {
  as_of: string
  poll_seconds: number
  devices: Record<string, DeviceLeds>
}

/** How a state is drawn: its colour (null: unlit), how bright it glows
 * (the emissive strength, KHR_materials_emissive_strength's meaning) and
 * whether it blinks. */
export interface LedLook {
  base: LedBase
  color: string | null
  strength: number
  blink: boolean
}

/** The lit colours - the hue of a real indicator LED, not the UI palette:
 * these are hardware lights on a photo or a model. */
export const LED_COLORS: Record<LedColor | "neutral", string> = {
  green: "#22e55c",
  amber: "#ffb020",
  red: "#ff3030",
  blue: "#3b8cff",
  // Lit dim white: a light whose state the reader may not see.
  neutral: "#d4d4d8",
}

const STRENGTH: Record<LedColor | "neutral", number> = {
  green: 2.5,
  amber: 2.5,
  red: 2.5,
  blue: 3,
  neutral: 0.6,
}

const OFF: LedLook = { base: "off", color: null, strength: 0, blink: false }

/** A state's look. `reducedMotion` turns a blink into a steady light. An
 * unknown string reads as off - a light never shows what Danbyte doesn't
 * know. */
export function ledLook(
  state: string | null | undefined,
  reducedMotion = false
): LedLook {
  if (!state) return OFF
  const blink = state.endsWith("_blink")
  const base = (blink ? state.slice(0, -"_blink".length) : state) as LedBase
  if (base === "off" || !(base in LED_COLORS)) return OFF
  if (base === "neutral" && blink) return OFF
  return {
    base,
    color: LED_COLORS[base],
    strength: STRENGTH[base],
    blink: blink && !reducedMotion,
  }
}

/** The state of one LED: `name` without its `led:` prefix, `bay` the bay
 * its module sits in (null for the chassis' own). */
export function ledStateOf(
  dev: DeviceLeds | null | undefined,
  name: string,
  bay: string | null = null
): LedState | "off" {
  if (!dev) return "off"
  const id = name.startsWith("led:") ? name.slice(4) : name
  const s = bay === null ? dev.leds[id] : dev.bays[bay]?.[id]
  return s ?? "off"
}

/** Blink timing: on for half of each period, every blinking light in step
 * (a shared clock, like a real chassis). */
export const BLINK_PERIOD_MS = 1000

export function blinkPhaseOn(nowMs: number): boolean {
  return nowMs % BLINK_PERIOD_MS < BLINK_PERIOD_MS / 2
}

/** Whether the viewer asked for less motion. */
export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
  } catch {
    return false
  }
}

/** Human words for a state - the 2D overlay's tooltip. */
export function ledStateLabel(state: string | null | undefined): string {
  const look = ledLook(state)
  if (look.base === "off") return "Off"
  if (look.base === "neutral") return "Not shown to you"
  const word = look.base[0].toUpperCase() + look.base.slice(1)
  return state?.endsWith("_blink") ? `${word}, blinking` : word
}

/** A stable key for a payload entry, so a poll that changed nothing
 * re-applies nothing. */
export function ledsKey(dev: DeviceLeds | null | undefined): string {
  if (!dev) return ""
  const parts: string[] = []
  for (const k of Object.keys(dev.leds).sort())
    parts.push(`${k}=${dev.leds[k]}`)
  for (const [b, bay] of Object.entries(dev.bays).sort(([x], [y]) =>
    x < y ? -1 : x > y ? 1 : 0
  ))
    for (const k of Object.keys(bay ?? {}).sort())
      parts.push(`${b}\u0001${k}=${bay?.[k]}`)
  return parts.join("\u0000")
}
