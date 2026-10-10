import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, Download, RefreshCw, Search } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  OxidizedConfig,
  OxidizedDeviceLink,
  OxidizedDiff,
  OxidizedVersion,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { copyWithToast } from "@/lib/clipboard"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Section } from "@/components/ui/section"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { FormSelect } from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TimeCell } from "@/components/cells/time-ago"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { DiffLine } from "@/components/device-drift-panel"

type View = "current" | "history" | "diff"

/** Gate: the Oxidized switch is on for the tenant and the user holds
 * view_config on devices. The server enforces both; this only keeps the
 * panel out of the way of everyone else. */
export function DeviceConfigBackups({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const enabled = useQuery({
    queryKey: ["integrations-enabled"],
    queryFn: () => api<Record<string, boolean>>("/api/integrations/enabled/"),
    staleTime: 60_000,
  })
  if (!enabled.data?.oxidized || !canDo("device", "view_config")) return null
  return <Backups deviceId={deviceId} />
}

function Backups({ deviceId }: { deviceId: string }) {
  const base = `/api/oxidized/devices/${deviceId}`
  const nodes = useQuery({
    queryKey: ["oxidized-device", deviceId],
    queryFn: () => api<{ links: OxidizedDeviceLink[] }>(`${base}/`),
  })
  const [linkId, setLinkId] = useState<string | null>(null)
  const [view, setView] = useState<View>("current")
  const links = nodes.data?.links ?? []
  const link = links.find((l) => l.id === linkId) ?? links.at(0)

  return (
    <Section title="Config backup" badge={link && <NodeBadge link={link} />}>
      {nodes.isLoading ? (
        <Loading />
      ) : nodes.isError ? (
        <QueryError error={nodes.error} />
      ) : !link ? (
        <EmptyState title="Not in Oxidized">
          No Oxidized node is linked to this device.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {links.length > 1 && (
            <SegmentedTabs
              value={link.id}
              onValueChange={setLinkId}
              items={links.map((l) => ({
                value: l.id,
                label: l.connection_name,
              }))}
            />
          )}
          <SegmentedTabs<View>
            value={view}
            onValueChange={setView}
            items={[
              { value: "current", label: "Current" },
              { value: "history", label: "History" },
              { value: "diff", label: "Diff" },
            ]}
          />
          <BackupView key={link.id} base={base} link={link} view={view} />
        </div>
      )}
    </Section>
  )
}

function NodeBadge({ link }: { link: OxidizedDeviceLink }) {
  return (
    <Badge variant="secondary" className="font-mono">
      {link.full_name}
    </Badge>
  )
}

function BackupView({
  base,
  link,
  view,
}: {
  base: string
  link: OxidizedDeviceLink
  view: View
}) {
  const qs = `?link=${link.id}`
  const versions = useQuery({
    queryKey: ["oxidized-versions", link.id],
    queryFn: () =>
      api<{ results: OxidizedVersion[]; history: boolean }>(
        `${base}/versions/${qs}`
      ),
  })
  const changed = useChangedSinceSeen(link.id, versions.data?.results[0]?.oid)
  const [viewing, setViewing] = useState<OxidizedVersion | null>(null)
  const [pair, setPair] = useState<{ from: string | null; to: string | null }>({
    from: null,
    to: null,
  })

  return (
    <div className="space-y-3">
      {changed && (
        <Badge variant="warning">Changed since you last looked</Badge>
      )}
      {view === "current" && <CurrentConfig base={base} qs={qs} link={link} />}
      {view === "history" &&
        (viewing ? (
          <VersionText
            base={base}
            qs={qs}
            version={viewing}
            onBack={() => setViewing(null)}
          />
        ) : (
          <History
            query={versions}
            onView={setViewing}
            onDiff={(oid) => setPair({ from: oid, to: "current" })}
          />
        ))}
      {view === "diff" && (
        <DiffPane
          base={base}
          qs={qs}
          versions={versions.data?.results ?? []}
          pair={pair}
          onPair={setPair}
        />
      )}
    </div>
  )
}

/** Remembers, per browser, the newest version this viewer has seen for a
 * node, and says when Oxidized has a newer one. A convenience only. */
function useChangedSinceSeen(linkId: string, latest: string | undefined) {
  const [changed, setChanged] = useState(false)
  useEffect(() => {
    if (!latest) return
    const key = `oxidized-seen:${linkId}`
    try {
      const seen = window.localStorage.getItem(key)
      setChanged(!!seen && seen !== latest)
      window.localStorage.setItem(key, latest)
    } catch {
      // storage blocked: no note, nothing else lost
    }
  }, [linkId, latest])
  return changed
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function fileName(link: OxidizedDeviceLink, suffix = "") {
  return `${link.full_name.replace(/[^\w.-]+/g, "_")}${suffix}.cfg`
}

function CurrentConfig({
  base,
  qs,
  link,
}: {
  base: string
  qs: string
  link: OxidizedDeviceLink
}) {
  const qc = useQueryClient()
  const [refresh, setRefresh] = useState(0)
  const q = useQuery({
    queryKey: ["oxidized-config", link.id, refresh],
    queryFn: () =>
      api<OxidizedConfig>(`${base}/config/${qs}${refresh ? "&refresh=1" : ""}`),
  })
  const fetchNow = useMutation({
    mutationFn: () =>
      api(`${base}/fetch-now/`, {
        method: "POST",
        body: JSON.stringify({ link: link.id }),
      }),
    onSuccess: () => {
      toast.success("Queued in Oxidized")
      void qc.invalidateQueries({ queryKey: ["oxidized-versions", link.id] })
    },
    onError: (e) => apiErrorToast(e),
  })

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (!q.data) return null
  const text = q.data.config
  return (
    <ConfigText
      text={text}
      meta={
        <span className="text-[12px] text-muted-foreground tabular-nums">
          {q.data.lines.toLocaleString()} lines
        </span>
      }
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={q.isFetching}
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {q.isFetching ? "Reloading…" : "Reload"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={fetchNow.isPending}
            onClick={() => fetchNow.mutate()}
          >
            {fetchNow.isPending ? "Queueing…" : "Fetch now"}
          </Button>
        </>
      }
      fileName={fileName(link)}
    />
  )
}

/** Monospace config with a line filter, copy and download. The text is
 * rendered as React text, never as markup. */
export function ConfigText({
  text,
  meta,
  actions,
  fileName: name,
}: {
  text: string
  meta?: React.ReactNode
  actions?: React.ReactNode
  fileName: string
}) {
  const [needle, setNeedle] = useState("")
  const lines = useMemo(() => text.split("\n"), [text])
  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase()
    if (!n) return null
    const out: { no: number; line: string }[] = []
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(n)) out.push({ no: i + 1, line })
    })
    return out
  }, [lines, needle])

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            placeholder="Find in config…"
            className="h-8 pl-7"
            aria-label="Find in config"
          />
        </div>
        {shown && (
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {shown.length.toLocaleString()} matching
          </span>
        )}
        {meta}
        <div className="ml-auto flex items-center gap-2">
          {actions}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copyWithToast(text, "Config copied")}
          >
            <Copy className="h-3.5 w-3.5" /> Copy
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => download(name, text)}
          >
            <Download className="h-3.5 w-3.5" /> Download
          </Button>
        </div>
      </div>
      <pre
        data-testid="config-text"
        className="max-h-[32rem] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-relaxed"
      >
        {shown
          ? shown.map((r) => (
              <div key={r.no}>
                <span className="mr-3 inline-block w-12 text-right text-muted-foreground select-none">
                  {r.no}
                </span>
                {r.line}
              </div>
            ))
          : text || "(empty)"}
      </pre>
    </div>
  )
}

function History({
  query,
  onView,
  onDiff,
}: {
  query: ReturnType<
    typeof useQuery<{ results: OxidizedVersion[]; history: boolean }>
  >
  onView: (v: OxidizedVersion) => void
  onDiff: (oid: string) => void
}) {
  const columns: SimpleColumn<OxidizedVersion>[] = [
    {
      id: "date",
      header: "Date",
      cell: (v) => (v.date ? <TimeCell iso={v.date} /> : "-"),
    },
    { id: "author", header: "Author", cell: (v) => v.author || "-" },
    {
      id: "message",
      header: "Message",
      flex: true,
      cell: (v) => (
        <span className="text-muted-foreground">{v.message || "-"}</span>
      ),
    },
    {
      id: "oid",
      header: "Commit",
      cell: (v) => (
        <span className="font-mono text-xs">{v.oid.slice(0, 10)}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (v) => (
        <span className="inline-flex gap-2">
          <Button size="sm" variant="outline" onClick={() => onView(v)}>
            View
          </Button>
          <Button size="sm" variant="outline" onClick={() => onDiff(v.oid)}>
            Diff to current
          </Button>
        </span>
      ),
    },
  ]
  if (query.isLoading) return <Loading />
  if (query.isError) return <QueryError error={query.error} />
  const rows = query.data?.results ?? []
  if (!query.data?.history || rows.length === 0)
    return (
      <EmptyState title="No history">
        Oxidized keeps history with its git output.
      </EmptyState>
    )
  return <SimpleTable columns={columns} data={rows} getRowKey={(v) => v.oid} />
}

function VersionText({
  base,
  qs,
  version,
  onBack,
}: {
  base: string
  qs: string
  version: OxidizedVersion
  onBack: () => void
}) {
  const q = useQuery({
    queryKey: ["oxidized-version", base, version.oid],
    queryFn: () =>
      api<{ config: string }>(`${base}/versions/${version.oid}/${qs}`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  return (
    <ConfigText
      text={q.data?.config ?? ""}
      fileName={`${version.oid.slice(0, 10)}.cfg`}
      meta={
        <span className="inline-flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="font-mono">{version.oid.slice(0, 10)}</span>
          {version.date && <TimeCell iso={version.date} />}
        </span>
      }
      actions={
        <Button size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
      }
    />
  )
}

function DiffPane({
  base,
  qs,
  versions,
  pair,
  onPair,
}: {
  base: string
  qs: string
  versions: OxidizedVersion[]
  pair: { from: string | null; to: string | null }
  onPair: (p: { from: string | null; to: string | null }) => void
}) {
  const options = [
    { value: "current", label: "Current" },
    ...versions.map((v) => ({
      value: v.oid,
      label: `${v.oid.slice(0, 10)}${v.date ? ` · ${v.date.slice(0, 16).replace("T", " ")}` : ""}`,
    })),
  ]
  // Default: the previous version against the newest.
  const from = pair.from ?? versions.at(1)?.oid ?? versions.at(0)?.oid ?? null
  const to = pair.to ?? versions.at(0)?.oid ?? "current"
  const q = useQuery({
    queryKey: ["oxidized-diff", base, qs, from, to],
    queryFn: () =>
      api<OxidizedDiff>(`${base}/diff/${qs}&from=${from}&to=${to}`),
    enabled: !!from && !!to && from !== to,
  })
  if (versions.length === 0)
    return (
      <EmptyState title="Nothing to compare">
        Diffs need Oxidized's git history.
      </EmptyState>
    )
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormSelect
          label="From"
          value={from}
          onChange={(v) => onPair({ from: v, to })}
          options={options}
        />
        <FormSelect
          label="To"
          value={to}
          onChange={(v) => onPair({ from, to: v })}
          options={options}
        />
      </div>
      {from === to ? (
        <p className="text-sm text-muted-foreground">
          Pick two different versions.
        </p>
      ) : q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : q.data?.too_large ? (
        <EmptyState title="Too large to compare">
          Download both versions and diff them locally.
        </EmptyState>
      ) : q.data && !q.data.diff ? (
        <p className="text-sm text-muted-foreground">No differences.</p>
      ) : q.data ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="success">+{q.data.added}</Badge>
            <Badge variant="destructive">-{q.data.removed}</Badge>
          </div>
          <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
            {q.data.diff.split("\n").map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
