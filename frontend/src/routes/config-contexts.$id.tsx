import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"
import type { ReactNode } from "react"

import { useUrlTab } from "@/lib/use-url-tab"
import { api } from "@/lib/api"
import type { ConfigContext } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { ConfigContextDeleteDialog } from "@/components/config-context-delete-dialog"
import { useMe } from "@/lib/use-me"

const OBJECT_TYPE = "api.configcontext"

type Tab = "overview" | "journal" | "history"
const TABS: readonly Tab[] = ["overview", "journal", "history"]

export const Route = createFileRoute("/config-contexts/$id")({
  component: ConfigContextDetail,
})

function ConfigContextDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["config-context", id],
    queryFn: () => api<ConfigContext>(`/api/config-contexts/${id}/`),
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
  return <Body context={q.data} />
}

/** How many assignment dimensions this context actually narrows on. */
function scopeCount(c: ConfigContext): number {
  return (
    c.regions.length +
    c.sites.length +
    c.device_roles.length +
    c.platforms.length
  )
}

function Body({ context: c }: { context: ConfigContext }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<ConfigContext | null>(null)
  const goBack = useCallback(() => nav({ to: "/config-contexts" }), [nav])
  const dataKeys = Object.keys(c.data)

  return (
    <DetailShell
      backTo="/config-contexts"
      backLabel="Config contexts"
      title={c.name}
      presence={{ type: "configcontext", id: c.id }}
      actions={
        <>
          {canDo("configcontext", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/config-contexts/$id/edit" params={{ id: c.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("configcontext", "delete") && (
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
          title={c.name}
          badges={
            <Badge
              variant={c.is_active ? "success" : "secondary"}
              className="text-[10px]"
            >
              {c.is_active ? "active" : "inactive"}
            </Badge>
          }
          subtitle={
            scopeCount(c) === 0
              ? "Applies to every device and virtual machine"
              : undefined
          }
          description={c.description}
          stats={
            <>
              <DetailStat
                label="Weight"
                value={<span className="num">{c.weight}</span>}
              />
              <DetailStat
                label="Data keys"
                value={<span className="num">{dataKeys.length}</span>}
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <ContextOverview context={c} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={c.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={c.id} />
      </DetailTab>

      <ConfigContextDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** One assignment dimension: its members as links, or the "matches everything"
 * reading of an empty dimension (which is what the merge actually does). */
function scopeRow<T extends { id: string; name: string }>(
  label: string,
  items: T[],
  link: (item: T) => ReactNode
): KvRow {
  return {
    label,
    value: items.length ? (
      <span className="flex flex-wrap gap-x-3 gap-y-1">{items.map(link)}</span>
    ) : (
      <span className="text-muted-foreground">Any</span>
    ),
  }
}

function ContextOverview({ context: c }: { context: ConfigContext }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && c.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{c.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Weight",
      value: (
        <span>
          <span className="num">{c.weight}</span>
          <span className="ml-2 text-xs text-muted-foreground">
            higher wins on conflicting keys
          </span>
        </span>
      ),
    },
    {
      label: "Active",
      value: (
        <Badge
          variant={c.is_active ? "success" : "secondary"}
          className="text-[10px]"
        >
          {c.is_active ? "yes" : "no"}
        </Badge>
      ),
    },
    {
      label: "Description",
      value: c.description ? (
        <span className="whitespace-pre-wrap">{c.description}</span>
      ) : (
        dash
      ),
    },
  ]

  const scope: KvRow[] = [
    scopeRow("Regions", c.regions, (r) => (
      <Link
        key={r.id}
        to="/regions/$id"
        params={{ id: r.id }}
        className="text-primary hover:underline"
      >
        {r.name}
      </Link>
    )),
    scopeRow("Sites", c.sites, (s) => (
      <Link
        key={s.id}
        to="/sites/$id"
        params={{ id: s.id }}
        className="text-primary hover:underline"
      >
        {s.name}
      </Link>
    )),
    scopeRow("Device roles", c.device_roles, (r) => (
      <Link
        key={r.id}
        to="/device-roles/$id"
        params={{ id: r.id }}
        className="text-primary hover:underline"
      >
        {r.name}
      </Link>
    )),
    scopeRow("Platforms", c.platforms, (p) => (
      <Link
        key={p.id}
        to="/platforms/$id"
        params={{ id: p.id }}
        className="text-primary hover:underline"
      >
        {p.name}
      </Link>
    )),
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={c.created_at} /> },
    { label: "Updated", value: <TimeCell iso={c.updated_at} /> },
  ]

  const keys = Object.keys(c.data)

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Config context" rows={details} />
        <KvCard title="Assignment criteria" rows={scope} />
        <KvCard title="Record" rows={record} />
      </div>

      <section>
        <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Data
        </h2>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This context contributes no data.
          </p>
        ) : (
          // Scrolls in its own box: a context blob can be long *and* wide, and
          // neither may push the page into a horizontal scroll.
          <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
            {JSON.stringify(c.data, null, 2)}
          </pre>
        )}
      </section>
    </div>
  )
}
