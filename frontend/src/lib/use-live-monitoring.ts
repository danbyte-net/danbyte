import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import type { EffectiveCheckState, IpChecksResponse } from "@/lib/api"

/**
 * Live updates for one address's checks (`/ws/monitoring/?ip=`).
 *
 * The server pushes a check's state the moment a result is written - the
 * fast lane every second for a watched address, the workers on every run.
 * The page patches its cached checks in place, so the pill, latency and
 * "last checked" move without a refetch; a status change also re-reads the
 * history, strips and latency chart, which do change on a transition.
 *
 * Degrades to polling: with no socket (an install without the WebSocket
 * process, a proxy that drops it), the checks query refetches every 15 s
 * instead. `live` says which of the two is in effect.
 */
const PING_MS = 30_000
export const POLL_MS = 15_000

export interface LiveUpdate extends Partial<EffectiveCheckState> {
  type: "update"
  state_id: string
  template_id: string
  transition?: { from_status: string; to_status: string; at: string }
  sample?: { status: string; latency_ms: number | null; at: string }
}

export function useLiveMonitoring(ipId: string): { live: boolean } {
  const qc = useQueryClient()
  const [live, setLive] = useState(false)
  const stoppedRef = useRef(false)

  useEffect(() => {
    if (typeof window === "undefined") return
    stoppedRef.current = false
    let ws: WebSocket | null = null
    let pingTimer: number | undefined
    let retryTimer: number | undefined
    let attempt = 0

    const apply = (u: LiveUpdate) => {
      qc.setQueryData<IpChecksResponse>(["ip-checks", ipId], (cur) => {
        if (!cur) return cur
        return {
          ...cur,
          checks: cur.checks.map((c) => {
            if (c.template_id !== u.template_id) return c
            const state: EffectiveCheckState = {
              ...(c.state ?? {
                status: "unknown",
                since: null,
                last_checked: null,
                last_latency_ms: null,
                consecutive_success: 0,
                consecutive_fail: 0,
                next_run: null,
                flapping_since: null,
                flap_count: 0,
                flap_cleared_at: null,
              }),
              ...(u.status !== undefined ? { status: u.status } : {}),
              ...(u.since !== undefined ? { since: u.since } : {}),
              ...(u.flapping_since !== undefined
                ? { flapping_since: u.flapping_since }
                : {}),
              ...(u.last_detail !== undefined
                ? { last_detail: u.last_detail }
                : {}),
              // A probe that became no row still moves the row's figures.
              last_checked:
                u.sample?.at ?? u.last_checked ?? c.state?.last_checked ?? null,
              last_latency_ms:
                u.sample?.latency_ms ??
                u.last_latency_ms ??
                c.state?.last_latency_ms ??
                null,
              consecutive_success:
                u.consecutive_success ?? c.state?.consecutive_success ?? 0,
              consecutive_fail:
                u.consecutive_fail ?? c.state?.consecutive_fail ?? 0,
            }
            return { ...c, state }
          }),
        }
      })
      if (u.transition) {
        // The picture changed: strips, daily bars, the changes table and
        // the roll-ups elsewhere all read the log this transition joined.
        void qc.invalidateQueries({
          queryKey: ["monitoring-timeline", `ips/${ipId}`],
        })
        void qc.invalidateQueries({
          queryKey: ["monitoring-transitions", `ips/${ipId}`],
        })
        void qc.invalidateQueries({ queryKey: ["ip-latency", ipId] })
        void qc.invalidateQueries({ queryKey: ["ip-history", ipId] })
        void qc.invalidateQueries({ queryKey: ["ip-checks", ipId] })
        void qc.invalidateQueries({ queryKey: ["monitoring-flapping"] })
      }
    }

    const open = () => {
      if (stoppedRef.current) return
      try {
        const proto = window.location.protocol === "https:" ? "wss" : "ws"
        ws = new WebSocket(
          `${proto}://${window.location.host}/ws/monitoring/?ip=${ipId}`
        )
      } catch {
        setLive(false)
        return
      }
      ws.onopen = () => {
        attempt = 0
        setLive(true)
        pingTimer = window.setInterval(() => {
          try {
            ws?.send(JSON.stringify({ type: "ping" }))
          } catch {
            /* ignore */
          }
        }, PING_MS)
      }
      ws.onmessage = (e) => {
        if (stoppedRef.current) return
        try {
          const msg = JSON.parse(e.data) as LiveUpdate | { type: string }
          if (msg.type === "update") apply(msg as LiveUpdate)
        } catch {
          /* ignore a malformed frame */
        }
      }
      ws.onclose = (e) => {
        window.clearInterval(pingTimer)
        setLive(false)
        ws = null
        if (stoppedRef.current) return
        // 44xx is the server saying no (not signed in, not allowed): stay
        // on polling. Anything else is a dropped socket: come back, slowly.
        if (e.code >= 4400 && e.code < 4500) return
        attempt += 1
        retryTimer = window.setTimeout(
          open,
          Math.min(30_000, 1_000 * 2 ** attempt)
        )
      }
    }
    open()

    return () => {
      stoppedRef.current = true
      window.clearInterval(pingTimer)
      window.clearTimeout(retryTimer)
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close()
      ws = null
    }
  }, [ipId, qc])

  return { live }
}
