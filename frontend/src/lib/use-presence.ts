import { useEffect, useRef, useState } from "react"

import { api, type PresenceMode, type PresentUser } from "@/lib/api"

const HEARTBEAT_MS = 15_000
const WS_PING_MS = 20_000

/**
 * Announce that the current user is viewing/editing an object, and learn who
 * else is here — in real time.
 *
 * Transport is **WebSocket-first** (`/ws/presence/`): the server pushes the
 * present list the instant anyone joins, leaves, or starts editing. If the WS
 * can't be established (proxy not wired, network), it **falls back to polling**
 * the `/api/presence/heartbeat/` endpoint every 15s — so presence still works,
 * just less instantly. Both transports share one Redis store, so WS and polling
 * clients see each other.
 *
 * Best-effort throughout: any failure yields an empty list, never throws into
 * the page. Pass `objectId = undefined` to disable while the object loads.
 */
export function usePresence(
  objectType: string,
  objectId: string | undefined,
  mode: PresenceMode = "viewing"
): PresentUser[] {
  const [present, setPresent] = useState<PresentUser[]>([])
  // Latest mode in a ref so the polling path always sends the current mode
  // without re-creating the connection.
  const modeRef = useRef(mode)
  modeRef.current = mode
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!objectId) {
      setPresent([])
      return
    }
    let stopped = false
    let pollTimer: number | undefined
    let pingTimer: number | undefined

    // ─── polling fallback ────────────────────────────────────────────────
    const beat = async () => {
      try {
        const res = await api<{ present: PresentUser[] }>(
          "/api/presence/heartbeat/",
          {
            method: "POST",
            body: JSON.stringify({
              object_type: objectType,
              object_id: objectId,
              mode: modeRef.current,
            }),
          }
        )
        if (!stopped) setPresent(res.present)
      } catch {
        /* best-effort */
      }
    }
    const startPolling = () => {
      if (pollTimer || stopped) return
      beat()
      pollTimer = window.setInterval(beat, HEARTBEAT_MS)
    }

    // ─── websocket (preferred) ───────────────────────────────────────────
    let ws: WebSocket | null = null
    try {
      const proto = window.location.protocol === "https:" ? "wss" : "ws"
      const q = new URLSearchParams({
        object_type: objectType,
        object_id: objectId,
        mode: modeRef.current,
      })
      ws = new WebSocket(
        `${proto}://${window.location.host}/ws/presence/?${q.toString()}`
      )
      wsRef.current = ws
      ws.onmessage = (e) => {
        if (stopped) return
        try {
          setPresent(JSON.parse(e.data).present ?? [])
        } catch {
          /* ignore malformed frame */
        }
      }
      ws.onopen = () => {
        // Keep the server-side TTL warm.
        pingTimer = window.setInterval(() => {
          try {
            ws?.send(JSON.stringify({ type: "ping" }))
          } catch {
            /* ignore */
          }
        }, WS_PING_MS)
      }
      ws.onclose = () => {
        if (stopped) return
        wsRef.current = null
        window.clearInterval(pingTimer)
        // Lost (or never got) the socket → degrade to polling.
        startPolling()
      }
      // onerror is always followed by onclose, which handles fallback.
    } catch {
      startPolling()
    }

    return () => {
      stopped = true
      window.clearInterval(pollTimer)
      window.clearInterval(pingTimer)
      wsRef.current = null
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close()
      // Best-effort leave for the polling path (WS leave is automatic on close).
      // `keepalive` lets it finish even as the page unloads.
      api("/api/presence/leave/", {
        method: "POST",
        body: JSON.stringify({ object_type: objectType, object_id: objectId }),
        keepalive: true,
      }).catch(() => {})
    }
  }, [objectType, objectId])

  // A viewing→editing switch: tell an open socket immediately (the polling path
  // reads modeRef on its next beat).
  useEffect(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "mode", mode }))
      } catch {
        /* ignore */
      }
    }
  }, [mode])

  return present
}
