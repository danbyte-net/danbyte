import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2, TerminalSquare, TriangleAlert } from "lucide-react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"

import { api } from "@/lib/api"
import type { Device, Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// The credentials endpoint never returns the secret — only enough to pick one.
interface SshCredentialRow {
  id: string
  name: string
  username: string
  kind: string
}

type Phase = "picking" | "connecting" | "open" | "error" | "closed"

/**
 * The in-browser SSH terminal. Opens a WebSocket to the device shell consumer,
 * which authorizes the session, verifies the host key, and bridges asyncssh; we
 * only render the PTY here via xterm.js. The credential's secret never reaches
 * the browser — we pass its id and the server fetches it. An unknown host key
 * surfaces an explicit "accept new host" retry (trust-on-first-use).
 */
export function DeviceTerminalDialog({
  device,
  open,
  onOpenChange,
}: {
  device: Device
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const credsQ = useQuery({
    queryKey: ["device-credentials", device.id, "ssh"],
    queryFn: () =>
      api<Paginated<SshCredentialRow>>(
        `/api/monitoring/device-credentials/?device=${device.id}`
      ),
    enabled: open,
  })
  const sshCreds = useMemo(
    () =>
      (credsQ.data?.results ?? []).filter(
        (c) => c.kind === "ssh_password" || c.kind === "ssh_key"
      ),
    [credsQ.data]
  )

  const { me } = useMe()
  const [authMode, setAuthMode] = useState<"stored" | "mine">("stored")
  const [credentialId, setCredentialId] = useState("")
  const [myUsername, setMyUsername] = useState("")
  const [myPassword, setMyPassword] = useState("")
  const [phase, setPhase] = useState<Phase>("picking")
  const [message, setMessage] = useState("")
  const [canAcceptHost, setCanAcceptHost] = useState(false)

  // Default the "my login" username to the operator's own account, once.
  useEffect(() => {
    if (open && !myUsername && me.username) setMyUsername(me.username)
  }, [open, me.username, myUsername])

  const termHostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const teardown = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
  }, [])

  // Tear down whenever the dialog closes, and on unmount.
  useEffect(() => {
    if (!open) {
      teardown()
      setPhase("picking")
      setMessage("")
      setCanAcceptHost(false)
    }
    return () => teardown()
  }, [open, teardown])

  const connect = useCallback(
    (acceptNew: boolean) => {
      const interactive = authMode === "mine"
      if (interactive ? !myUsername.trim() : !credentialId) return
      teardown()
      setPhase("connecting")
      setMessage("")
      setCanAcceptHost(false)

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        theme: { background: "#09090b" },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      // The host div only exists once we render the terminal panel below; defer
      // to the next frame so the ref is attached.
      requestAnimationFrame(() => {
        if (!termHostRef.current) return
        term.open(termHostRef.current)
        fit.fit()
      })
      termRef.current = term
      fitRef.current = fit

      const proto = window.location.protocol === "https:" ? "wss" : "ws"
      const cols = 80
      const rows = 24
      const params = new URLSearchParams({
        cols: String(cols),
        rows: String(rows),
      })
      if (interactive) params.set("mode", "interactive")
      else params.set("credential", credentialId)
      if (acceptNew) params.set("accept_new", "1")
      const ws = new WebSocket(
        `${proto}://${window.location.host}/ws/ssh/${device.id}/?${params}`
      )
      wsRef.current = ws

      ws.onmessage = (ev) => {
        let msg: { t?: string; d?: string; m?: string; code?: string }
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        if (msg.t === "need_auth") {
          // Interactive mode: the server is waiting for the operator's login.
          ws.send(
            JSON.stringify({
              t: "auth",
              username: myUsername.trim(),
              password: myPassword,
            })
          )
        } else if (msg.t === "o" && msg.d != null) {
          term.write(msg.d)
        } else if (msg.t === "ready") {
          setPhase("open")
          fit.fit()
          const { cols: c, rows: r } = term
          ws.send(JSON.stringify({ t: "r", cols: c, rows: r }))
          term.focus()
        } else if (msg.t === "error") {
          setPhase("error")
          setMessage(msg.m || "Connection failed.")
          setCanAcceptHost(msg.code === "hostkey_unknown")
        } else if (msg.t === "exit") {
          setPhase("closed")
        }
      }
      ws.onclose = () => {
        // A close before we ever went "open" with no explicit error frame.
        setPhase((p) => (p === "connecting" ? "error" : p === "open" ? "closed" : p))
      }
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "i", d: data }))
        }
      })
      term.onResize(({ cols: c, rows: r }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "r", cols: c, rows: r }))
        }
      })
    },
    [authMode, credentialId, myUsername, myPassword, device.id, teardown]
  )

  // Keep the terminal fitted to the dialog while a session is live.
  useEffect(() => {
    if (phase !== "open") return
    const onResize = () => fitRef.current?.fit()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [phase])

  const showTerminal = phase === "connecting" || phase === "open" || phase === "closed"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4" /> Terminal — {device.name}
          </DialogTitle>
          <DialogDescription>
            An SSH session to this device, brokered by Danbyte. The credential's
            secret stays on the server.
          </DialogDescription>
        </DialogHeader>

        {phase === "picking" || phase === "error" ? (
          <div className="space-y-4">
            {phase === "error" && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <span>{message}</span>
              </div>
            )}
            {/* How to authenticate: a shared stored credential, or the
                operator's own login typed here (never stored). */}
            <div className="inline-flex rounded-md border border-border p-0.5 text-sm">
              <button
                type="button"
                onClick={() => setAuthMode("stored")}
                className={
                  "rounded px-3 py-1 " +
                  (authMode === "stored"
                    ? "bg-accent font-medium"
                    : "text-muted-foreground")
                }
              >
                Stored credential
              </button>
              <button
                type="button"
                onClick={() => setAuthMode("mine")}
                className={
                  "rounded px-3 py-1 " +
                  (authMode === "mine"
                    ? "bg-accent font-medium"
                    : "text-muted-foreground")
                }
              >
                My login
              </button>
            </div>

            {authMode === "stored" ? (
              <div className="space-y-2">
                <label className="text-sm font-medium">SSH credential</label>
                {credsQ.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : sshCreds.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This device has no stored SSH credential — add one in the
                    device's <span className="font-medium">Credentials</span>{" "}
                    section, or use <span className="font-medium">My login</span>.
                  </p>
                ) : (
                  <Select value={credentialId} onValueChange={setCredentialId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a credential" />
                    </SelectTrigger>
                    <SelectContent>
                      {sshCreds.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                          {c.username ? ` (${c.username})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Username</label>
                  <Input
                    value={myUsername}
                    onChange={(e) => setMyUsername(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Password</label>
                  <Input
                    type="password"
                    value={myPassword}
                    onChange={(e) => setMyPassword(e.target.value)}
                    autoComplete="off"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && myUsername.trim()) connect(false)
                    }}
                  />
                </div>
                <p className="col-span-2 text-xs text-muted-foreground">
                  Your login is used only for this session and is never stored.
                </p>
              </div>
            )}
            {(() => {
              const ready =
                authMode === "mine" ? !!myUsername.trim() : !!credentialId
              return (
                <div className="flex justify-end gap-2">
                  {canAcceptHost && (
                    <Button
                      variant="outline"
                      onClick={() => connect(true)}
                      disabled={!ready}
                    >
                      Accept new host & retry
                    </Button>
                  )}
                  <Button onClick={() => connect(false)} disabled={!ready}>
                    Connect
                  </Button>
                </div>
              )
            })()}
          </div>
        ) : null}

        {showTerminal && (
          <div className="space-y-2">
            <div
              ref={termHostRef}
              className="h-[60vh] w-full overflow-hidden rounded-md border border-border bg-[#09090b] p-2"
            />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {phase === "connecting" && (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…
                </>
              )}
              {phase === "open" && <span>Connected.</span>}
              {phase === "closed" && (
                <>
                  <span>Session closed.</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => connect(false)}
                  >
                    Reconnect
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
