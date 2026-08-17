import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { KeyRound, RotateCcw, Server, Radio } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { MonitoringEngine, MonitoringSettings, Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FormSelect, FormText, FormFooter } from "@/components/forms"
import { DataTable, SortHeader } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import { ListPageShell } from "@/components/list-page-shell"
import { timeAgo } from "@/components/cells/time-ago"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { EngineDetailDialog } from "@/components/engine-detail-dialog"
import { OutpostVersions } from "@/components/outpost-versions"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/monitoring-engines")({
  component: MonitoringEnginesPage,
})

// Sentinel for "no engine pinned" — the Select primitive disallows an empty
// SelectItem value, so it maps back to null on change.
const LOCAL_ENGINE = "__local__"

function seenLabel(e: MonitoringEngine): { text: string; ok: boolean } {
  if (e.is_local) return { text: "built-in", ok: true }
  if (!e.last_seen_at) return { text: "never seen", ok: false }
  const secs = (Date.now() - new Date(e.last_seen_at).getTime()) / 1000
  const ok = secs < e.poll_interval_seconds * 3
  return { text: `seen ${timeAgo(e.last_seen_at)}`, ok }
}

function MonitoringEnginesPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState("")
  const [adding, setAdding] = useState(false)
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

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return engines
    return engines.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.agent_version.toLowerCase().includes(needle)
    )
  }, [engines, search])

  // Built inline (not memoized) so the row buttons always close over the live
  // mutation handles — the table is small and has no facet rail to churn.
  const columns: ColumnDef<MonitoringEngine>[] = [
    {
      id: "engine",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Engine" />,
      cell: ({ row }) => {
        const e = row.original
        return (
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
                className="link font-medium"
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
              <Badge variant="secondary" className="text-[10px]">
                disabled
              </Badge>
            )}
          </div>
        )
      },
    },
    {
      id: "health",
      accessorFn: (e) => seenLabel(e).text,
      header: "Health",
      cell: ({ row }) => {
        const e = row.original
        const seen = seenLabel(e)
        if (e.is_local)
          return <span className="text-muted-foreground">built-in</span>
        if (!e.token_set)
          return (
            <Badge variant="warning" className="text-[10px]">
              not enrolled
            </Badge>
          )
        return (
          <Badge
            variant={seen.ok ? "success" : "secondary"}
            className="text-[10px]"
          >
            {seen.text}
          </Badge>
        )
      },
    },
    {
      id: "scope",
      accessorFn: (e) => e.binding_count,
      header: ({ column }) => <SortHeader column={column} label="Scope" />,
      cell: ({ row }) => (
        <span className="num text-muted-foreground tabular-nums">
          {row.original.binding_count} site/loc · {row.original.check_count}{" "}
          checks
        </span>
      ),
    },
    {
      id: "version",
      accessorKey: "agent_version",
      header: ({ column }) => <SortHeader column={column} label="Version" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.agent_version || "—"}
        </span>
      ),
    },
    // Outpost-only row actions: (re)enroll, enable/disable, remove. The local
    // engine is built in, so it has none.
    actionsColumn<MonitoringEngine>({
      canDelete: (e) => !e.is_local,
      onDelete: (e) => remove.mutate(e),
      deleteLabel: "Remove Outpost",
      extra: (e) =>
        e.is_local ? null : (
          <>
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
          </>
        ),
    }),
  ]

  return (
    <ListPageShell
      title="Monitoring engines"
      count={q.data ? rows.length : undefined}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Filter by name, version…",
      }}
      actions={
        <Button size="sm" onClick={() => setAdding(true)}>
          Add Outpost
        </Button>
      }
      query={q}
    >
      <div className="space-y-6">
        <p className="max-w-3xl text-[13px] text-muted-foreground">
          Where checks run. <b>Local</b> is the core server's workers; an{" "}
          <b>Outpost</b> is a remote agent at a site with no path to the core.
          Assign Outposts to a site/location on their form — the default engine
          catches everything else.
        </p>

        <DataTable
          data={rows}
          columns={columns}
          flexColumn="engine"
          tableId="monitoring-engines"
          exportName="monitoring-engines"
          exportTitle="Monitoring engines"
        />

        {/* Secondary config — two columns so it stops stacking. */}
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="space-y-2 rounded-lg border border-border bg-card p-4">
            <div>
              <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                Default engine
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Runs everything not pinned to a site or location.
              </p>
            </div>
            <Select
              value={settings.data?.default_engine || LOCAL_ENGINE}
              onValueChange={(v) =>
                setDefault.mutate(v === LOCAL_ENGINE ? null : v)
              }
              disabled={!settings.data}
            >
              <SelectTrigger className="h-9 w-full text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LOCAL_ENGINE}>Local (built-in)</SelectItem>
                {engines
                  .filter((e) => !e.is_local && e.enabled)
                  .map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
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
            <Input
              className="h-9 font-mono text-xs"
              placeholder="https://github.com/danbyte-net/danbyte-outpost"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <div className="flex gap-2">
              <Input
                className="h-9 font-mono text-xs"
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

        <div className="border-t border-border pt-6">
          <OutpostVersions />
        </div>
      </div>

      <AddOutpostDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(e) => {
          invalidate()
          // Pull engines need an install token; SSH engines are driven by Danbyte.
          if (e.transport === "pull") enroll.mutate(e)
        }}
      />
      <EnrollDialog
        engine={enrollFor}
        token={token}
        onClose={() => {
          setEnrollFor(null)
          setToken(null)
        }}
      />
      <EngineDetailDialog engine={detail} onClose={() => setDetail(null)} />
    </ListPageShell>
  )
}

/** "Add Outpost" from the page header — name + how it connects. */
function AddOutpostDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (engine: MonitoringEngine) => void
}) {
  const [name, setName] = useState("")
  const [transport, setTransport] = useState<"pull" | "ssh">("pull")

  const create = useMutation({
    mutationFn: () =>
      api<MonitoringEngine>("/api/monitoring/engines/", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), transport }),
      }),
    onSuccess: (e) => {
      setName("")
      setTransport("pull")
      onOpenChange(false)
      onCreated(e)
    },
    onError: (e: unknown) => apiErrorToast(e, "Create failed"),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an Outpost</DialogTitle>
          <DialogDescription>
            A remote agent for a site the core can't reach.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(ev) => {
            ev.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            placeholder="Outpost AMS-02"
            required
            autoFocus
          />
          <FormSelect
            label="Connection"
            value={transport}
            onChange={(v) => setTransport(v === "ssh" ? "ssh" : "pull")}
            options={[
              { value: "pull", label: "Outpost dials out (HTTPS)" },
              { value: "ssh", label: "Danbyte dials in (SSH)" },
            ]}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={create.isPending}
            submitLabel="Add Outpost"
          />
        </form>
      </DialogContent>
    </Dialog>
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
      <DialogContent size="lg">
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
                <Checkbox
                  checked={insecure}
                  onCheckedChange={(v) => setInsecure(!!v)}
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
