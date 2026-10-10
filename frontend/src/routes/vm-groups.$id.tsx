import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { VirtualMachineGroup } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { CustomFieldValues } from "@/components/custom-field-display"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { EmbeddedVmTable } from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { VmGroupDeleteDialog } from "@/components/vm-group-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/vm-groups/$id")({
  component: VmGroupDetail,
})

function VmGroupDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["vm-group", id],
    queryFn: () => api<VirtualMachineGroup>(`/api/vm-groups/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body group={q.data} />
}

function Body({ group: g }: { group: VirtualMachineGroup }) {
  const { canDo } = useMe()
  const canEdit = canDo("virtualmachinegroup", "change")
  const canDelete = canDo("virtualmachinegroup", "delete")
  const [tab, setTab] = useUrlTab<"overview" | "vms" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<VirtualMachineGroup | null>(null)
  const goBack = useCallback(() => nav({ to: "/vm-groups" }), [nav])

  return (
    <DetailShell
      backTo="/vm-groups"
      backLabel="VM groups"
      title={g.name}
      presence={{ type: "virtualmachinegroup", id: g.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/vm-groups/$id/edit" params={{ id: g.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(g)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={g.name}
          tags={g.tags.length > 0 && <TagList tags={g.tags} />}
          description={g.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "vms", label: "Virtual machines", count: g.vm_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <Overview group={g} />
      </DetailTab>
      <DetailTab value="vms">
        <EmbeddedVmTable
          filter={{ group: g.id }}
          emptyText="No virtual machines in this group."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.virtualmachinegroup" objectId={g.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.virtualmachinegroup" objectId={g.id} />
      </DetailTab>

      <VmGroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function Overview({ group: g }: { group: VirtualMachineGroup }) {
  const { humanIds } = useMe()
  const rows: KvRow[] = [
    ...(humanIds && g.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{g.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Kind", value: g.kind_display },
    {
      label: "Cluster",
      value: (
        <Link to="/clusters/$id" params={{ id: g.cluster.id }} className="link">
          {g.cluster.name}
        </Link>
      ),
    },
    {
      label: "Site",
      value: g.site ? (
        <Link to="/sites/$id" params={{ id: g.site.id }} className="link">
          {g.site.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Virtual machines",
      value: <span className="num">{g.vm_count}</span>,
    },
    { label: "Created", value: <TimeCell iso={g.created_at} /> },
    { label: "Updated", value: <TimeCell iso={g.updated_at} /> },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="VM group" rows={rows} />
      <CustomFieldValues
        model="virtualmachinegroup"
        values={g.custom_fields}
        layout="cards"
      />
    </div>
  )
}
