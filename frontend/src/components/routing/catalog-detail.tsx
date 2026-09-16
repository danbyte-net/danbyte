import { Link, useNavigate } from "@tanstack/react-router"
import type { LinkProps } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"
import type { ReactNode } from "react"

import { api } from "@/lib/api"
import type { Tag } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { TagList } from "@/components/cells/tag-list"
import { DataTable } from "@/components/data-table"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { CustomFieldValues } from "@/components/custom-field-display"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"

import { RoutingDeleteDialog } from "./catalog-page"

// One detail page for the routing catalogs: overview (identity + record +
// custom fields), the rules the object carries, Journal, Change log.

interface CatalogRow {
  id: string
  numid: number | null
  name: string
  description: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface RoutingDetailSpec<T extends CatalogRow, TRule = never> {
  /** RBAC slug ("prefixlist"); the custom-field model slug is the same. */
  objectType: string
  /** Audit label ("routing.prefixlist"). */
  appLabel: string
  endpoint: string
  queryKey: string
  backTo: LinkProps["to"]
  backLabel: string
  editTo: LinkProps["to"]
  title: (row: T) => string
  subtitle?: (row: T) => ReactNode
  /** Rows for the first KvCard, after Number / Name. */
  overview: (row: T) => KvRow[]
  /** The rules tab - what the object carries. */
  rules?: {
    label: string
    columns: () => ColumnDef<TRule, unknown>[]
    get: (row: T) => TRule[]
    tableId: string
    emptyText: string
  }
  /** Tabs for what uses the object - a peer group's sessions, say. */
  related?: {
    value: string
    label: string
    count?: (row: T) => number
    render: (row: T) => ReactNode
  }[]
}

export function RoutingCatalogDetail<T extends CatalogRow, TRule = never>({
  id,
  spec,
}: {
  id: string
  spec: RoutingDetailSpec<T, TRule>
}) {
  const q = useQuery({
    queryKey: [spec.queryKey, id],
    queryFn: () => api<T>(`${spec.endpoint}${id}/`),
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
  return <Body row={q.data} spec={spec} />
}

function Body<T extends CatalogRow, TRule>({
  row,
  spec,
}: {
  row: T
  spec: RoutingDetailSpec<T, TRule>
}) {
  const [tab, setTab] = useUrlTab<string>("overview")
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const [deleting, setDeleting] = useState<T | null>(null)
  const goBack = useCallback(() => nav({ to: spec.backTo }), [nav, spec.backTo])
  const rules = spec.rules ? spec.rules.get(row) : []

  const details: KvRow[] = [
    ...(humanIds && row.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{row.numid}</span>,
          },
        ]
      : []),
    {
      label: "Name",
      value: <span className="font-mono">{row.name}</span>,
      copy: row.name,
    },
    ...spec.overview(row),
    { label: "Description", value: row.description || dash },
  ]
  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={row.created_at} /> },
    { label: "Updated", value: <TimeCell iso={row.updated_at} /> },
  ]

  return (
    <DetailShell
      backTo={spec.backTo}
      backLabel={spec.backLabel}
      title={spec.title(row)}
      presence={{ type: spec.objectType, id: row.id }}
      actions={
        <>
          {canDo(spec.objectType, "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link
                to={spec.editTo}
                params={{ id: row.id } as LinkProps["params"]}
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo(spec.objectType, "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(row)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={spec.title(row)}
          mono
          subtitle={spec.subtitle?.(row)}
          description={row.description}
          tags={row.tags.length ? <TagList tags={row.tags} /> : undefined}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        ...(spec.rules
          ? [
              {
                value: "rules",
                label: spec.rules.label,
                count: rules.length || undefined,
              },
            ]
          : []),
        ...(spec.related ?? []).map((t) => ({
          value: t.value,
          label: t.label,
          count: t.count ? t.count(row) || undefined : undefined,
        })),
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Details" rows={details} />
          <KvCard title="Record" rows={record} />
          <CustomFieldValues
            model={spec.objectType}
            values={row.custom_fields}
            layout="cards"
          />
        </div>
      </DetailTab>
      {spec.rules && (
        <DetailTab value="rules">
          {canDo(spec.objectType, "change") && (
            <div className="mb-3 flex items-center justify-end">
              <Button size="sm" variant="outline" className="h-7" asChild>
                <Link
                  to={spec.editTo}
                  params={{ id: row.id } as LinkProps["params"]}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {rules.length === 0 ? "Add rules" : "Edit rules"}
                </Link>
              </Button>
            </div>
          )}
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {spec.rules.emptyText}
            </p>
          ) : (
            <DataTable
              data={rules}
              columns={spec.rules.columns()}
              flexColumn="description"
              tableId={spec.rules.tableId}
            />
          )}
        </DetailTab>
      )}
      {(spec.related ?? []).map((t) => (
        <DetailTab key={t.value} value={t.value}>
          {t.render(row)}
        </DetailTab>
      ))}
      <DetailTab value="journal">
        <JournalPanel objectType={spec.appLabel} objectId={row.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={spec.appLabel} objectId={row.id} />
      </DetailTab>

      <RoutingDeleteDialog
        item={deleting}
        endpoint={spec.endpoint}
        queryKey={spec.queryKey}
        label={spec.title}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}
