import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { MonitoringEngine, MonitoringEngineStats } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { apiErrorToast } from "@/lib/api-toast"

const STATUS_TONE: Record<string, string> = {
  up: "text-emerald-600 dark:text-emerald-400",
  degraded: "text-amber-600 dark:text-amber-400",
  down: "text-red-600 dark:text-red-400",
  unknown: "text-muted-foreground",
  skipped: "text-muted-foreground",
}

/** Detail + edit for one Outpost: connection settings and live stats. */
export function EngineDetailDialog({
  engine,
  onClose,
}: {
  engine: MonitoringEngine | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const open = !!engine
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [poll, setPoll] = useState("15")
  const [sshHost, setSshHost] = useState("")
  const [sshPort, setSshPort] = useState("22")
  const [sshUser, setSshUser] = useState("")
  const [sshKey, setSshKey] = useState("")
  const [sshHostKey, setSshHostKey] = useState("")
  const [autoUpdate, setAutoUpdate] = useState(false)
  const isSsh = engine?.transport === "ssh"

  useEffect(() => {
    if (engine) {
      setName(engine.name)
      setDescription(engine.description)
      setPoll(String(engine.poll_interval_seconds))
      setSshHost(engine.ssh_host)
      setSshPort(String(engine.ssh_port))
      setSshUser(engine.ssh_user)
      setSshKey("")
      setSshHostKey(engine.ssh_host_key)
      setAutoUpdate(engine.auto_update)
    }
  }, [engine])

  const stats = useQuery({
    queryKey: ["engine-stats", engine?.id],
    queryFn: () =>
      api<MonitoringEngineStats>(
        `/api/monitoring/engines/${engine!.id}/stats/`
      ),
    enabled: open,
  })

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim(),
        poll_interval_seconds: Number(poll) || 15,
        auto_update: autoUpdate,
      }
      if (isSsh) {
        body.ssh_host = sshHost.trim()
        body.ssh_port = Number(sshPort) || 22
        body.ssh_user = sshUser.trim()
        body.ssh_host_key = sshHostKey.trim()
        // Only send the key if the user entered one (blank = keep existing).
        if (sshKey.trim()) body.ssh_credential = { private_key: sshKey }
      }
      return api<MonitoringEngine>(`/api/monitoring/engines/${engine!.id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["monitoring-engines"] })
      toast.success("Outpost updated")
    },
    onError: (e: unknown) => apiErrorToast(e, "Save failed"),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {engine?.name}
            <Badge variant="outline" className="text-[10px]">
              {engine?.transport === "ssh" ? "SSH" : "HTTPS"}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        {/* Live facts */}
        <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
          <Fact label="Checks" value={stats.data?.total_checks ?? "—"} />
          <Fact
            label="Last seen"
            value={
              engine?.last_seen_at
                ? new Date(engine.last_seen_at).toLocaleString()
                : "never"
            }
          />
          <Fact label="Version" value={engine?.agent_version || "—"} mono />
          <Fact
            label="Host"
            value={engine?.agent_hostname || engine?.agent_ip || "—"}
            mono
          />
        </div>

        {/* Never-connected warning: checks are assigned but nothing runs them. */}
        {!engine?.is_local &&
          !engine?.last_seen_at &&
          (stats.data?.total_checks ?? 0) > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <b>{stats.data?.total_checks} checks are assigned</b> to this
              Outpost, but it has <b>never connected</b> — so they aren&apos;t
              running (they go stale). Install the agent on a host at the site,
              or set the default engine back to <b>Local</b>.
            </div>
          )}

        {/* Status breakdown */}
        {stats.data && Object.keys(stats.data.by_status).length > 0 && (
          <div className="flex flex-wrap gap-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-[13px]">
            {Object.entries(stats.data.by_status).map(([s, n]) => (
              <span key={s} className={STATUS_TONE[s] ?? ""}>
                <span className="num font-medium tabular-nums">{n}</span> {s}
              </span>
            ))}
          </div>
        )}

        {/* Assigned scope */}
        <div className="text-[13px]">
          <span className="text-muted-foreground">Monitors: </span>
          {stats.data?.is_default ? (
            <span>
              <Badge variant="secondary" className="text-[10px]">
                tenant default
              </Badge>{" "}
              <span className="text-muted-foreground">
                every target without a more specific engine
                {stats.data.total_checks > 0 &&
                  ` (${stats.data.total_checks} checks)`}
              </span>
            </span>
          ) : (stats.data?.sites.length ?? 0) +
              (stats.data?.locations.length ?? 0) ===
            0 ? (
            <span className="text-muted-foreground">
              nothing yet — assign it on a site or location form
            </span>
          ) : (
            <span className="inline-flex flex-wrap gap-1">
              {stats.data?.sites.map((s) => (
                <Badge key={s.id} variant="secondary" className="text-[10px]">
                  site · {s.name}
                </Badge>
              ))}
              {stats.data?.locations.map((l) => (
                <Badge key={l.id} variant="secondary" className="text-[10px]">
                  location · {l.name}
                </Badge>
              ))}
            </span>
          )}
        </div>

        {/* Recent activity */}
        {stats.data && stats.data.recent.length > 0 && (
          <div className="max-h-40 overflow-auto rounded-md border border-border">
            <table className="w-full text-left text-[12px]">
              <tbody className="divide-y divide-border">
                {stats.data.recent.map((r, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1 font-mono">{r.ip}</td>
                    <td className="px-2 py-1">
                      <span className="text-muted-foreground">
                        {r.from_status}
                      </span>{" "}
                      →{" "}
                      <span className={STATUS_TONE[r.to_status] ?? ""}>
                        {r.to_status}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right text-muted-foreground">
                      {new Date(r.at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Edit connection */}
        <div className="grid gap-2 border-t border-border pt-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-[11px] text-muted-foreground">
              Name
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-sm"
              />
            </label>
            <label className="space-y-1 text-[11px] text-muted-foreground">
              Poll interval (s)
              <Input
                type="number"
                min={5}
                value={poll}
                onChange={(e) => setPoll(e.target.value)}
                className="h-8 text-sm"
              />
            </label>
          </div>
          <label className="space-y-1 text-[11px] text-muted-foreground">
            Description
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-8 text-sm"
            />
          </label>

          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="ck ck-sm"
              checked={autoUpdate}
              onChange={(e) => setAutoUpdate(e.target.checked)}
            />
            Auto-update to the golden release
            <span className="text-[11px] text-muted-foreground">
              — the agent self-updates to the default version in Outpost
              versions
            </span>
          </label>

          {isSsh && (
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-medium">SSH connection</span>
                <span className="text-muted-foreground">
                  Danbyte dials in to run the checks
                </span>
                {engine.ssh_configured ? (
                  <Badge variant="secondary" className="ml-auto text-[10px]">
                    configured
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="ml-auto text-[10px]">
                    not configured
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="col-span-2 space-y-1 text-[11px] text-muted-foreground">
                  Host
                  <Input
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder="10.9.0.5"
                    className="h-8 font-mono text-sm"
                  />
                </label>
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  Port
                  <Input
                    type="number"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                    className="h-8 text-sm"
                  />
                </label>
              </div>
              <label className="space-y-1 text-[11px] text-muted-foreground">
                User
                <Input
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  placeholder="danbyte"
                  className="h-8 font-mono text-sm"
                />
              </label>
              <label className="space-y-1 text-[11px] text-muted-foreground">
                Private key {engine.ssh_configured && "(blank = keep current)"}
                <textarea
                  value={sshKey}
                  onChange={(e) => setSshKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  rows={3}
                  className="w-full rounded-md border border-border bg-background p-2 font-mono text-[11px]"
                />
              </label>
              <label className="space-y-1 text-[11px] text-muted-foreground">
                Host key — pins the server (blank = trust on first use)
                <textarea
                  value={sshHostKey}
                  onChange={(e) => setSshHostKey(e.target.value)}
                  placeholder="ssh-ed25519 AAAAC3Nz…  (from: ssh-keyscan -t ed25519 host)"
                  rows={2}
                  className="w-full rounded-md border border-border bg-background p-2 font-mono text-[11px]"
                />
              </label>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              Save changes
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Fact({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="rounded-md border border-border bg-card px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground uppercase">{label}</div>
      <div className={"truncate text-[13px] " + (mono ? "font-mono" : "")}>
        {value}
      </div>
    </div>
  )
}
