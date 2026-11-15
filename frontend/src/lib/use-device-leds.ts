import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DeviceLeds, DeviceLedsPayload } from "@/lib/led-state"

/** How often the lights are asked for again - the floor plan's live state
 * cadence. */
export const LED_POLL_MS = 30_000

const NONE: Record<string, DeviceLeds> = {}

/**
 * The status LEDs of `deviceIds` (docs/dcim/model-packs.md → Status LEDs),
 * polled every 30 s. One POST for the whole set (a scene's devices can
 * outgrow a request line); the model is never reloaded for it. Empty until
 * the first answer, and while `enabled` is false.
 */
export function useDeviceLeds(
  deviceIds: readonly string[],
  enabled = true
): Record<string, DeviceLeds> {
  const ids = [...new Set(deviceIds)].sort()
  const q = useQuery({
    queryKey: ["device-leds", ids.join(",")],
    queryFn: () =>
      api<DeviceLedsPayload>("/api/device-leds/", {
        method: "POST",
        body: JSON.stringify({ devices: ids }),
      }),
    enabled: enabled && ids.length > 0,
    refetchInterval: LED_POLL_MS,
    staleTime: LED_POLL_MS / 2,
  })
  return q.data?.devices ?? NONE
}
