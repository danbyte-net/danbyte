import { keepPreviousData, useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DeviceLeds, DeviceLedsPayload } from "@/lib/led-state"
import type { SceneStack } from "@/lib/stacks"

/** How often the lights are asked for again - the floor plan's live state
 * cadence. */
export const LED_POLL_MS = 30_000

/** Devices one request may ask about (the server's limit, api.led_state
 * MAX_DEVICES); a longer list is cut, its tail left unlit. */
export const LED_MAX_DEVICES = 500

const NONE: Record<string, DeviceLeds> = {}
const NO_STACKS: SceneStack[] = []

/** The ids one request asks about: each once, in the caller's order (so
 * the ones it lists first are the ones kept past the limit), then sorted
 * for a stable query key. */
export function ledRequestIds(deviceIds: readonly string[]): string[] {
  return [...new Set(deviceIds)].slice(0, LED_MAX_DEVICES).sort()
}

/**
 * The status LEDs of `deviceIds` (docs/dcim/model-packs.md → Status LEDs),
 * polled every 30 s. One POST for the whole set (a scene's devices can
 * outgrow a request line); the model is never reloaded for it. Empty until
 * the first answer, and while `enabled` is false. When the set changes (a
 * rack's devices come near) the last answer stays up until the new one
 * lands, so the lights that were on don't blink out.
 */
export function useDeviceLeds(
  deviceIds: readonly string[],
  enabled = true
): Record<string, DeviceLeds> {
  return useDeviceLedsPayload(deviceIds, enabled).devices
}

/** `useDeviceLeds` with the switch stacks among the devices (lib/stacks):
 * the same request. */
export function useDeviceLedsPayload(
  deviceIds: readonly string[],
  enabled = true
): { devices: Record<string, DeviceLeds>; stacks: SceneStack[] } {
  const ids = ledRequestIds(deviceIds)
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
    placeholderData: keepPreviousData,
  })
  const on = enabled && ids.length > 0
  return {
    devices: (on ? q.data?.devices : null) ?? NONE,
    stacks: (on ? q.data?.stacks : null) ?? NO_STACKS,
  }
}
