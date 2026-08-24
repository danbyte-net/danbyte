import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { CustomFieldValues } from "@/components/custom-field-display"
import { useUrlTab } from "@/lib/use-url-tab"
import {
  AutoRouteButton,
  TraceOnMapButton,
  TraceOnSiteMapButton,
} from "@/components/trace-on-map-button"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeftRight, Network, Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { Cable, Termination, TraceGraph } from "@/lib/api"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { CableDeleteDialog } from "@/components/cable-delete-dialog"
import { PrintLabelButton } from "@/components/print-label-button"
import { CableRoutingCard } from "@/components/cable-routing-card"
import { CableTracePath } from "@/components/cable-trace-path"
import { TraceSection } from "@/components/topology/trace-section"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"
import { Input } from "@/components/ui/input"
import { FiberMap } from "@/components/fiber/fiber-map"
import type { StrandAnno } from "@/components/fiber/fiber-map"
import {
  useFiberPalette,
  useStrandModelling,
} from "@/components/fiber/use-fiber-palette"
import { StrandTraceDialog } from "@/components/fiber/strand-trace-dialog"

export const Route = createFileRoute("/cables/$id")({ component: CableDetail })

const summary = (terms: Termination[]) =>
  terms.length ? terms.map((t) => `${t.device.name}:${t.name}`).join(", ") : "-"

function CableDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["cable", id],
    queryFn: () => api<Cable>(`/api/cables/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body cable={q.data} />
}

function TerminationBox({ t }: { t: Termination }) {
  // A power feed hangs off a power panel, not a device - the API surfaces the
  // panel under the same `device` key, so both halves of the box point at the
  // power pages instead of a device that doesn't exist.
  const feed = t.kind === "power_feed"
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <Link
        to={feed ? "/power-panels/$id" : "/devices/$id"}
        params={{ id: t.device.id }}
        className="link font-mono text-xs text-muted-foreground"
      >
        {t.device.name}
      </Link>
      <div className="mt-1 flex items-center gap-2 font-mono font-medium">
        {t.kind === "interface" || feed ? (
          <Link
            to={feed ? "/power-feeds/$id" : "/interfaces/$id"}
            params={{ id: t.id }}
            className="link"
          >
            {t.name}
          </Link>
        ) : (
          <span>{t.name}</span>
        )}
        <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
          {t.kind.replace("_", " ")}
        </span>
      </div>
    </div>
  )
}

function Body({ cable: c }: { cable: Cable }) {
  const [tab, setTab] = useUrlTab<"overview" | "trace" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<Cable | null>(null)
  const goBack = useCallback(() => nav({ to: "/cables" }), [nav])

  // "Show me this run in context": the custom-map builder scoped to every
  // device the cable's end-to-end run passes through. The trace (same query
  // the path strip uses, so it's already cached) supplies the run; the bare
  // termination pair is the fallback while it loads. A run through a patch
  // panel also turns panel display ON - the default collapses panels away,
  // which turned this map into one lone node: the panel hidden, and the
  // collapsed run pointing at a device outside the set.
  const runTrace = useQuery({
    queryKey: ["trace", "cable", c.id],
    queryFn: () => api<TraceGraph>(`/api/cables/${c.id}/trace/`),
  })
  const { topoDevices, topoPanels } = (() => {
    const runNodes = runTrace.data?.device_graph?.nodes
    if (runNodes?.length) {
      const ids = runNodes
        .map((n) => n.data.device_id)
        .filter((x): x is string => !!x)
      return {
        topoDevices: ids.length >= 2 ? [...new Set(ids)].join(",") : null,
        topoPanels: runNodes.some((n) => n.data.panel),
      }
    }
    const ids = [...(c.a_terminations ?? []), ...(c.b_terminations ?? [])]
      .map((t) => t.device?.id)
      .filter((x): x is string => !!x)
    const uniq = [...new Set(ids)]
    return {
      topoDevices: uniq.length >= 2 ? uniq.join(",") : null,
      topoPanels: false,
    }
  })()

  return (
    <DetailShell
      backTo="/cables"
      backLabel="Cables"
      title={
        <span className="truncate font-mono">
          {summary(c.a_terminations)} ↔ {summary(c.b_terminations)}
        </span>
      }
      presence={{ type: "cable", id: c.id }}
      actions={
        <>
          <AutoRouteButton cableId={c.id} />
          {topoDevices && (
            <Button variant="outline" size="sm" asChild>
              <Link
                to="/topology"
                search={{
                  devices: topoDevices,
                  ...(topoPanels ? { panels: true } : {}),
                }}
              >
                <Network className="h-3.5 w-3.5" /> Topology
              </Link>
            </Button>
          )}
          <TraceOnMapButton cableId={c.id} />
          <TraceOnSiteMapButton cableId={c.id} />
          <PrintLabelButton objectType="cable" ids={[c.id]} />
          {canDo("cable", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/cables/$id/edit" params={{ id: c.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("cable", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(c)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={
            c.label ||
            `${summary(c.a_terminations)} ↔ ${summary(c.b_terminations)}`
          }
          mono
          badges={<StatusBadge status={c.status} />}
          tags={c.tags.length > 0 && <TagList tags={c.tags} />}
          description={c.description}
        >
          {/* The flat end-to-end run when it can be drawn; the classic A ↔ B
            boxes when it can't (breakouts, loops, dangling ends). */}
          <CableTracePath
            cableId={c.id}
            fallback={
              <div className="flex max-w-4xl items-start gap-4">
                <div className="flex-1 space-y-2">
                  <div className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                    A side
                  </div>
                  {c.a_terminations.map((t) => (
                    <TerminationBox key={`a-${t.id}`} t={t} />
                  ))}
                </div>
                <ArrowLeftRight className="mt-8 h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="flex-1 space-y-2">
                  <div className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                    B side
                  </div>
                  {c.b_terminations.map((t) => (
                    <TerminationBox key={`b-${t.id}`} t={t} />
                  ))}
                </div>
              </div>
            }
          />
        </DetailHero>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "trace", label: "Trace" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <CableOverview cable={c} />
      </DetailTab>
      <DetailTab value="trace">
        <TraceSection
          url={`/api/cables/${c.id}/trace/`}
          queryKey={["trace", "cable", c.id]}
          urlKey="dir"
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.cable" objectId={c.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.cable" objectId={c.id} />
      </DetailTab>

      <CableDeleteDialog
        cable={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Cable attributes that used to crowd the header, grouped into labelled
 * tables. The A ↔ B terminations and status stay up top. */
function CableOverview({ cable: c }: { cable: Cable }) {
  const { humanIds } = useMe()
  const modelling = useStrandModelling()

  const details: KvRow[] = [
    ...(humanIds && c.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{c.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Label", value: c.label || dash },
    { label: "Status", value: <StatusBadge status={c.status} /> },
    { label: "Type", value: c.type_display || dash },
  ]

  const physical: KvRow[] = [
    {
      label: "Length",
      value: c.length ? (
        <span className="num">
          {c.length} {c.length_unit}
        </span>
      ) : (
        dash
      ),
    },
    {
      label: "Color",
      value: c.color ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-border"
            style={{ backgroundColor: c.color }}
          />
          <span className="font-mono">{c.color}</span>
        </span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Cable" rows={details} />
        <KvCard title="Physical" rows={physical} />
        <CustomFieldValues
          model="cable"
          values={c.custom_fields}
          layout="cards"
        />
      </div>
      <CableRoutingCard cableId={c.id} />
      {c.is_fiber && modelling !== "off" && <CableFibers cable={c} />}
    </div>
  )
}

/** The "Fibres" card on a fibre cable: set the strand count, then colour-code,
 * label and status each strand (TIA-598-C, palette-configurable in settings). */
function CableFibers({ cable: c }: { cable: Cable }) {
  const qc = useQueryClient()
  const palette = useFiberPalette()
  const [count, setCount] = useState(c.fiber_count ?? 0)
  const [tracing, setTracing] = useState<number | null>(null)

  const save = useMutation({
    mutationFn: (patch: {
      fiber_count?: number | null
      strands?: Record<string, StrandAnno>
    }) =>
      api<Cable>(`/api/cables/${c.id}/`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cable", c.id] }),
  })

  const setStrand = (position: number, anno: StrandAnno) => {
    const next = { ...c.strands }
    if (anno.label || anno.status) next[String(position)] = anno
    else delete next[String(position)]
    save.mutate({ strands: next })
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">Fibres</h3>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Strands</span>
          <Input
            type="number"
            min={0}
            max={2048}
            value={count || ""}
            onChange={(e) => setCount(Number(e.target.value) || 0)}
            onBlur={() => {
              if (count !== (c.fiber_count ?? 0))
                save.mutate({ fiber_count: count || null })
            }}
            className="h-7 w-20 text-sm"
          />
        </div>
        <span className="text-[11px] text-muted-foreground">
          TIA-598-C · diagonal tracers mark each wrap past 12
        </span>
        {save.isPending && (
          <span className="text-[11px] text-muted-foreground">saving…</span>
        )}
      </div>
      {count > 0 ? (
        <FiberMap
          count={count}
          strands={c.strands}
          palette={palette}
          editable
          onChange={setStrand}
          onTrace={setTracing}
        />
      ) : (
        <p className="text-[13px] text-muted-foreground">
          Set a strand count to colour-code and label the fibres.
        </p>
      )}
      <StrandTraceDialog
        cableId={c.id}
        position={tracing}
        palette={palette}
        onOpenChange={(o) => !o && setTracing(null)}
      />
    </div>
  )
}
