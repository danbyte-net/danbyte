import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { ConfigBundle, ConfigBundleTemplate } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { ColorBadge } from "@/components/cells/color-badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { ConfigBundleDeleteDialog } from "@/components/config-bundle-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

const OBJECT_TYPE = "api.configbundle"

// A bundle is a named set of device templates plus the roles it serves. The
// files are the content, so they get their own table on the Overview rather
// than a tab; Journal and History follow as on every detail page.
type Tab = "overview" | "journal" | "history"
const TABS: readonly Tab[] = ["overview", "journal", "history"]

export const Route = createFileRoute("/config-bundles/$id")({
  component: ConfigBundleDetail,
})

function ConfigBundleDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["config-bundle", id],
    queryFn: () => api<ConfigBundle>(`/api/config-bundles/${id}/`),
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
  return <Body bundle={q.data} />
}

function Body({ bundle: b }: { bundle: ConfigBundle }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<ConfigBundle | null>(null)
  const goBack = useCallback(() => nav({ to: "/config-bundles" }), [nav])

  return (
    <DetailShell
      backTo="/config-bundles"
      backLabel="Config bundles"
      title={b.name}
      presence={{ type: "configbundle", id: b.id }}
      actions={
        <>
          {canDo("configbundle", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/config-bundles/$id/edit" params={{ id: b.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("configbundle", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(b)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={b.name}
          description={b.description}
          stats={
            <>
              <DetailStat
                label="Files"
                value={<span className="num">{b.templates.length}</span>}
              />
              <DetailStat
                label="Roles"
                value={<span className="num">{b.roles.length}</span>}
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <BundleOverview bundle={b} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={b.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={b.id} />
      </DetailTab>

      <ConfigBundleDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function BundleOverview({ bundle: b }: { bundle: ConfigBundle }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && b.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{b.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: b.name, copy: b.name },
    {
      label: "Description",
      value: b.description ? (
        <span className="whitespace-pre-wrap">{b.description}</span>
      ) : (
        dash
      ),
    },
    {
      label: "Roles",
      value: b.roles.length ? (
        <span className="flex flex-wrap gap-1">
          {b.roles.map((role) => (
            <Link
              key={role.id}
              to="/device-roles/$id"
              params={{ id: role.id }}
              className="hover:opacity-90"
            >
              <ColorBadge name={role.name} color={role.color} />
            </Link>
          ))}
        </span>
      ) : (
        dash
      ),
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={b.created_at} /> },
    { label: "Updated", value: <TimeCell iso={b.updated_at} /> },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Config bundle" rows={details} />
        <KvCard title="Record" rows={record} />
      </div>

      <section>
        <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Files
        </h2>
        <BundleFiles templates={b.templates} />
      </section>
    </div>
  )
}

function BundleFiles({ templates }: { templates: ConfigBundleTemplate[] }) {
  const columns = useMemo<ColumnDef<ConfigBundleTemplate, unknown>[]>(
    () => [
      {
        id: "path",
        accessorKey: "bundle_path",
        header: ({ column }) => <SortHeader column={column} label="Path" />,
        cell: ({ row }) => (
          <span className="font-mono text-[12px]">
            {row.original.bundle_path}
          </span>
        ),
      },
      {
        id: "template",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Template" />,
        cell: ({ row }) => (
          <Link
            to="/export-templates/$id"
            params={{ id: row.original.id }}
            className="link"
          >
            {row.original.name}
          </Link>
        ),
      },
    ],
    []
  )
  if (templates.length === 0)
    return (
      <EmptyState title="No files">
        Add device export templates to this bundle to render them together.
      </EmptyState>
    )
  return (
    <DataTable
      data={templates}
      columns={columns}
      flexColumn="template"
      embedded
    />
  )
}
