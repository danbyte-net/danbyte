import { useMemo } from "react"

import { cn } from "@/lib/utils"
import {
  BLINK_PERIOD_MS,
  ledLook,
  ledStateLabel,
  ledStateOf,
  prefersReducedMotion,
} from "@/lib/led-state"
import type { DeviceLeds } from "@/lib/led-state"
import { useDeviceLeds } from "@/lib/use-device-leds"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * A device's status LEDs drawn over its rack-face image (a rack elevation,
 * the device page's faceplate): small lights at the LEDs' places on the
 * photo, in the same states and colours as the 3D model's
 * (docs/dcim/model-packs.md → Status LEDs).
 *
 * These are the device's own hardware lights on a picture of it - not a
 * status pill beside a name (docs/design/visual-language.md). The overlay
 * knows nothing of where the image came from: it takes positions, so it
 * sits on a generated face (`image_leds`) or any other image that lists
 * them.
 *
 * The parent is the image's box, `position: relative`; the overlay fills
 * it and lets the pointer through except on the lights themselves.
 */

/** One LED on a face image: its name as the model names it (`SYS`,
 * `port:Te1/0/1`; no `led:` prefix needed), its centre and size normalised
 * 0..1 to the image, and the source it is bound to. `bay` is the module bay
 * of a module's LED (null or absent: the chassis' own). */
export interface LedPosition {
  name: string
  x: number
  y: number
  w: number
  h: number
  source?: string | null
  bay?: string | null
}

/** Smallest a light is drawn (px): a 3 mm LED on a 19-inch face is under
 * a pixel in a narrow rack column. */
const MIN_PX = 3

function pct(v: number) {
  return `${Math.max(0, Math.min(1, v)) * 100}%`
}

export function LedOverlay({
  positions,
  leds,
  className,
}: {
  positions: readonly LedPosition[]
  /** The device's lights (`/api/device-leds/`); null or absent: all off. */
  leds: DeviceLeds | null | undefined
  className?: string
}) {
  const reduced = useMemo(() => prefersReducedMotion(), [])
  // Every blinking light starts at the same point of the shared one-second
  // cycle, so they flash together, like a real chassis.
  const phaseDelay = `-${Date.now() % BLINK_PERIOD_MS}ms`
  if (positions.length === 0) return null
  return (
    <div
      className={cn("pointer-events-none absolute inset-0", className)}
      data-led-overlay
    >
      {positions.map((p) => {
        const state = ledStateOf(leds, p.name, p.bay ?? null)
        const look = ledLook(state, reduced)
        const label = p.name.startsWith("led:") ? p.name.slice(4) : p.name
        return (
          <Tooltip key={`${p.bay ?? ""}\u0001${p.name}`}>
            <TooltipTrigger asChild>
              <span
                role="img"
                aria-label={`${label}: ${ledStateLabel(state)}`}
                data-led={label}
                data-led-state={look.base}
                data-led-blink={look.blink ? "" : undefined}
                className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-[1px]"
                style={{
                  left: pct(p.x),
                  top: pct(p.y),
                  width: `max(${pct(p.w)}, ${MIN_PX}px)`,
                  height: `max(${pct(p.h)}, ${MIN_PX}px)`,
                  backgroundColor: look.color ?? "transparent",
                  // The glow is the light itself, not decoration.
                  boxShadow: look.color
                    ? `0 0 ${look.base === "neutral" ? 1 : 3}px ${look.color}`
                    : undefined,
                  animationDelay: look.blink ? phaseDelay : undefined,
                }}
              />
            </TooltipTrigger>
            <TooltipContent variant="panel">
              <span className="font-mono">{label}</span>
              {p.bay ? ` · ${p.bay}` : ""} · {ledStateLabel(state)}
              {p.source ? (
                <span className="block font-mono text-muted-foreground">
                  {p.source}
                </span>
              ) : null}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** `LedOverlay` for one device, its states polled (30 s). */
export function DeviceLedOverlay({
  deviceId,
  positions,
  className,
}: {
  deviceId: string
  positions: readonly LedPosition[]
  className?: string
}) {
  const leds = useDeviceLeds(positions.length ? [deviceId] : [])
  return (
    <LedOverlay
      positions={positions}
      leds={leds[deviceId] ?? null}
      className={className}
    />
  )
}
