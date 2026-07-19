import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound, Plus, RotateCcw, Server, Trash2, Radio } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { MonitoringEngine, MonitoringSettings, Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { timeAgo } from "@/components/cells/time-ago"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { QueryError } from "@/components/query-error"
import { EngineDetailDialog } from "@/components/engine-detail-dialog"
import { OutpostVersions } from "@/components/outpost-versions"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/monitoring-engines")({
  component: MonitoringEnginesPage,
})

function seenLabel(e: MonitoringEngine): { text: string; ok: boolean } {
  if (e.is_local) return { text: "built-in", ok: true }
  if (!e.last_seen_at) return { text: "never seen", ok: false }
  const secs = (Date.now() - new Date(e.last_seen_at).getTime()) / 1000
  const ok = secs < e.poll_interval_seconds * 3
  return { text: `seen ${timeAgo(e.last_seen_at)}`, ok }
}

function MonitoringEnginesPage() {
  const qc = useQueryClient()
  const [name, setName] = useState("")
  const [transport, setTransport] = useState<"pull" | "ssh">("pull")
  const [enrollFor, setEnrollFor] = useState<MonitoringEngine | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [detail, setDetail] = useState<MonitoringEngine | null>(null)

  const q = useQuery({
    queryKey: ["monitoring-engines"],
    queryFn: () => api<Paginated<MonitoringEngine>>("/api/monitoring/engines/"),
  })
  const engines = q.data?.results ?? []
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["monitoring-engines"] })

  const settings = useQuery({
    queryKey: ["monitoring-settings"],
    queryFn: () => api<MonitoringSettings>("/api/monitoring/settings/"),
  })
  const setDefault = useMutation({
    mutationFn: (engineId: string | null) =>
      api<MonitoringSettings>("/api/monitoring/settings/", {
        method: "PATCH",
        body: JSON.stringify({ default_engine: engineId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["monitoring-settings"] })
      toast.success("Default engine updated")
    },
    onError: (e: unknown) => apiErrorToast(e, "Update failed"),
  })

  const [repoUrl, setRepoUrl] = useState("")
  const [repoToken, setRepoToken] = useState("")
  useEffect(() => {
    if (settings.data) setRepoUrl(settings.data.outpost_repo_url)
  }, [settings.data])
  const saveRepo = useMutation({
    mutationFn: () =>
      api<MonitoringSettings>("/api/monitoring/settings/", {
        method: "PATCH",
        body: JSON.stringify({
          outpost_repo_url: repoUrl.trim(),
          ...(repoToken.trim()
            ? { outpost_repo_token: { token: repoToken.trim() } }
            : {}),
        }),
      }),
    onSuccess: () => {
      setRepoToken("")
      void qc.invalidateQueries({ queryKey: ["monitoring-settings"] })
      void qc.invalidateQueries({ queryKey: ["outpost-available"] })
      toast.success("Outpost repo saved")
    },
    onError: (e: unknown) => apiErrorToast(e, "Save failed"),
  })

  const create = useMutation({
    mutationFn: () =>
      api<MonitoringEngine>("/api/monitoring/engines/", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), transport }),
      }),
    onSuccess: (e) => {
      setName("")
      invalidate()
      // Pull engines need an install token; SSH engines are driven by Danbyte.
      if (e.transport === "pull") enroll.mutate(e)
    },
    onError: (e: unknown) => apiErrorToast(e, "Create failed"),
  })

  const enroll = useMutation({
    mutationFn: (e: MonitoringEngine) =>
      api<{ token: string }>(`/api/monitoring/engines/${e.id}/enroll/`, {
        method: "POST",
      }),
    onSuccess: (res, e) => {
      setEnrollFor(e)
      setToken(res.token)
      invalidate()
    },
    onError: (e: unknown) => apiErrorToast(e, "Enroll failed"),
  })

  const toggle = useMutation({
    mutationFn: (e: MonitoringEngine) =>
      api<MonitoringEngine>(`/api/monitoring/engines/${e.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !e.enabled }),
      }),
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: (e: MonitoringEngine) =>
      api(`/api/monitoring/engines/${e.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Outpost removed")
      invalidate()
    },
    onError: (e: unknown) => apiErrorToast(e, "Delete failed"),
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
        <h1 className="text-base font-semibold">Monitoring engines</h1>
        {q.data && <Badge variant="secondary">{engines.length}</Badge>}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <p className="max-w-3xl text-[13px] text-muted-foreground">
            Where checks run. <b>Local</b> is the core server's workers; an{" "}
            <b>Outpost</b> is a remote agent at a site with no path to the core.
            Assign Outposts to a site/location on their form — the default
            engine catches everything else.
          </p>

          {q.isError ? (
            <QueryError error={q.error} />
          ) : (
            <>
              {/* Primary: the engines table, full width. */}
              <section className="space-y-2">
                <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                  Engines
                </h2>
                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full text-left text-[13px]">
                    <thead className="bg-muted/40 text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
                      <tr>
                        <th className="px-3 py-2 font-medium">Engine</th>
                        <th className="px-3 py-2 font-medium">Health</th>
                        <th className="px-3 py-2 font-medium">Scope</th>
                        <th className="px-3 py-2 font-medium">Version</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {engines.map((e) => {
                        const seen = seenLabel(e)
                        return (
                          <tr key={e.id}>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                {e.is_local ? (
                                  <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                ) : (
                                  <Radio className="h-3.5 w-3.5 shrink-0 text-primary" />
                                )}
                                {e.is_local ? (
                                  <span className="font-medium">{e.name}</span>
                                ) : (
                                  <button
                                    type="button"
                                    className="font-medium hover:underline"
                                    onClick={() => setDetail(e)}
                                  >
                                    {e.name}
                                  </button>
                                )}
                                {!e.is_local && (
                                  <span className="text-[10px] text-muted-foreground">
                                    {e.transport === "ssh" ? "SSH" : "HTTPS"}
                                  </span>
                                )}
                                {!e.enabled && (
                                  <Badge
                                    variant="secondary"
                                    className="text-[10px]"
                                  >
                                    disabled
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              {e.is_local ? (
                                <span className="text-muted-foreground">
                                  built-in
                                </span>
                              ) : !e.token_set ? (
                                <Badge
                                  variant="warning"
                                  className="text-[10px]"
                                >
                                  not enrolled
                                </Badge>
                              ) : (
                                <Badge
                                  variant={seen.ok ? "success" : "secondary"}
                                  className="text-[10px]"
                                >
                                  {seen.text}
                                </Badge>
                              )}
                            </td>
                            <td className="num px-3 py-2 text-muted-foreground tabular-nums">
                              {e.binding_count} site/loc · {e.check_count}{" "}
                              checks
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                              {e.agent_version || "—"}
                            </td>
                            <td className="px-3 py-2">
                              {!e.is_local && (
                                <div className="flex justify-end gap-1">
                                  {e.transport === "pull" && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 gap-1 text-xs"
                                      onClick={() => enroll.mutate(e)}
                                      title="Regenerate the install token"
                                    >
                                      <KeyRound className="h-3.5 w-3.5" />
                                      {e.token_set ? "Rotate" : "Enroll"}
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 text-xs"
                                    onClick={() => toggle.mutate(e)}
                                  >
                                    {e.enabled ? "Disable" : "Enable"}
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 text-destructive hover:text-destructive"
                                    onClick={() => remove.mutate(e)}
                                    title="Remove Outpost"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Secondary config — two columns so it stops stacking. */}
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <div className="space-y-3 rounded-lg border border-border bg-card p-4">
                  <div>
                    <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                      Add an Outpost
                    </h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      A remote agent for a site the core can't reach.
                    </p>
                  </div>
                  <form
                    className="space-y-3"
                    onSubmit={(ev) => {
                      ev.preventDefault()
                      if (name.trim()) create.mutate()
                    }}
                  >
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Outpost AMS-02"
                      className="h-9 text-sm"
                    />
                    <select
                      className="h-9 w-full rounded-md border border-border bg-background px-2 text-[13px]"
                      value={transport}
                      onChange={(e) =>
                        setTransport(e.target.value as "pull" | "ssh")
                      }
                    >
                      <option value="pull">Outpost dials out (HTTPS)</option>
                      <option value="ssh">Danbyte dials in (SSH)</option>
                    </select>
                    <Button
                      type="submit"
                      size="sm"
                      className="h-9 w-full"
                      disabled={!name.trim() || create.isPending}
                    >
                      <Plus className="h-3.5 w-3.5" /> Add Outpost
                    </Button>
                  </form>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2 rounded-lg border border-border bg-card p-4">
                    <div>
                      <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                        Default engine
                      </h3>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Runs everything not pinned to a site or location.
                      </p>
                    </div>
                    <select
                      className="h-9 w-full rounded-md border border-border bg-background px-2 text-[13px]"
                      value={settings.data?.default_engine ?? ""}
                      onChange={(e) =>
                        setDefault.mutate(e.target.value || null)
                      }
                      disabled={!settings.data}
                    >
                      <option value="">Local (built-in)</option>
                      {engines
                        .filter((e) => !e.is_local && e.enabled)
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                    </select>
                  </div>

                  <form
                    className="space-y-2 rounded-lg border border-border bg-card p-4"
                    onSubmit={(e) => {
                      e.preventDefault()
                      saveRepo.mutate()
                    }}
                  >
                    <div>
                      <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                        Outpost repo
                      </h3>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Source for the versions in the package store.
                      </p>
                    </div>
                    <input
                      className="h-9 w-full rounded-md border border-border bg-background px-2 font-mono text-xs"
                      placeholder="https://github.com/danbyte-net/danbyte-outpost"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <input
                        className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs"
                        type="password"
                        placeholder={
                          settings.data?.outpost_repo_token_set
                            ? "token set — leave blank"
                            : "token (private repo)"
                        }
                        value={repoToken}
                        onChange={(e) => setRepoToken(e.target.value)}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        className="h-9 shrink-0 text-xs"
                        disabled={saveRepo.isPending}
                      >
                        Save
                      </Button>
                    </div>
                  </form>
                </div>
              </div>

              <div className="border-t border-border pt-6">
                <OutpostVersions />
              </div>
            </>
          )}
        </div>
      </div>

      <EnrollDialog
        engine={enrollFor}
        token={token}
        onClose={() => {
          setEnrollFor(null)
          setToken(null)
        }}
      />
      <EngineDetailDialog engine={detail} onClose={() => setDetail(null)} />
    </div>
  )
}

function EnrollDialog({
  engine,
  token,
  onClose,
}: {
  engine: MonitoringEngine | null
  token: string | null
  onClose: () => void
}) {
  const open = !!engine && !!token
  const url = window.location.origin
  // Default the self-signed toggle on when Danbyte is served from a bare IP.
  const looksSelfSigned = /^https?:\/\/(\d{1,3}\.){3}\d{1,3}(:|\/|$)/.test(url)
  const [insecure, setInsecure] = useState(looksSelfSigned)
  const installer = `curl -${insecure ? "k" : ""}fsSL ${url}/api/outpost/install.sh | sudo sh -s -- --token=${token}${insecure ? " --insecure" : ""}`
  const oneLiner = `danbyte-outpost run --url=${url} --token=${token}${insecure ? " --insecure" : ""}`
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
    toast.success("Copied")
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4" /> {engine?.name} — install
          </DialogTitle>
          <DialogDescription>
            Shown <b>once</b>. Install the Outpost on a host at the site, then
            run this one command. Rotating issues a new token and revokes this
            one.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">
                Install (downloads the pinned build from Danbyte)
              </span>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  className="ck ck-sm"
                  checked={insecure}
                  onChange={(e) => setInsecure(e.target.checked)}
                />
                Self-signed cert (-k / --insecure)
              </label>
            </div>
            <div className="flex items-start gap-2">
              <code className="flex-1 rounded-md border border-border bg-muted/40 p-3 font-mono text-xs break-all">
                {installer}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 text-xs"
                onClick={() => copy(installer)}
              >
                Copy
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Needs a build in <b>Outpost versions</b> below. Already installed?
              Run{" "}
              <button
                type="button"
                className="font-mono underline"
                onClick={() => copy(oneLiner)}
              >
                danbyte-outpost run …
              </button>
            </p>
          </div>
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">
              …or set as environment variables
            </summary>
            <div className="mt-1 flex items-start gap-2">
              <code className="flex-1 rounded-md border border-border bg-muted/40 p-2 font-mono break-all">
                OUTPOST_URL={url}
                <br />
                OUTPOST_TOKEN={token}
              </code>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 text-xs"
                onClick={() =>
                  copy(`OUTPOST_URL=${url}\nOUTPOST_TOKEN=${token}`)
                }
              >
                Copy
              </Button>
            </div>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  )
}
