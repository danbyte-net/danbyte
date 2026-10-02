import type { QueryClient } from "@tanstack/react-query"

/** Interface types with no physical port (`api.dcim_choices`): the server
 * always flags them virtual, and port utilization counts them as virtual. */
export const VIRTUAL_INTERFACE_TYPES: ReadonlySet<string> = new Set([
  "virtual",
  "bridge",
  "lag",
])

/**
 * Every query that shows a port count: the device and stack Port utilization
 * cards, the cable picker's free-ports bar, and the roll-up behind the Port
 * utilization page and the Devices list Ports column. All of them read the
 * one server rule (`api/port_utilization.py`), so they go stale together.
 */
export const PORT_COUNT_QUERY_KEYS = [
  ["device-port-utilization"],
  ["vc-port-utilization"],
  ["port-utilization-rollup"],
] as const

/** Refresh every port count. Call after anything that can move one: a
 * port, a cable, a reservation, or the Count virtual interfaces setting. */
export function invalidatePortCounts(qc: QueryClient): void {
  for (const queryKey of PORT_COUNT_QUERY_KEYS) {
    void qc.invalidateQueries({ queryKey })
  }
}
