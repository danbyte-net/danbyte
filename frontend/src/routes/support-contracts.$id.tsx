import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ExternalLink, Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Device, Paginated, SupportContract } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { DataTable } from "@/components/data-table"
import { TagList } from "@/components/cells/tag-list"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { ObjectDocuments } from "@/components/object-documents"
import { ContractStateBadge } from "@/components/cells/coverage-cell"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import {
  DateText,
  formatCost,
} from "@/components/columns/support-contract-columns"
import { SupportContractDeleteDialog } from "@/components/support-contract-delete-dialog"
import { SupportCoverageAddDialog } from "@/components/support-coverage-add-dialog"

export const Route = createFileRoute("/support-contracts/$id")({
  component: SupportContractDetail,
})

function SupportContractDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["support-contract", id],
    queryFn: () => api<SupportContract>(`/api/support-contracts/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body contract={q.data} />
}

type Tab = "overview" | "devices" | "documents" | "journal" | "history"

function Body({ contract: c }: { contract: SupportContract }) {
  const [tab, setTab] = useUrlTab<Tab>("overview")
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const [deleting, setDeleting] = useState<SupportContract | null>(null)
  const goBack = useCallback(() => nav({ to: "/support-contracts" }), [nav])
  const canEdit = c.permissions?.change ?? canDo("supportcontract", "change")
  const canDelete = c.permissions?.delete ?? canDo("supportcontract", "delete")

  return (
    <DetailShell
      backTo="/support-contracts"
      backLabel="Support contracts"
      title={<span className="font-mono">{c.contract_number}</span>}
      presence={{ type: "supportcontract", id: c.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/support-contracts/$id/edit" params={{ id: c.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
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
          title={c.contract_number}
          mono
          badges={
            <>
              {humanIds && c.numid != null && (
                <span className="num font-mono text-sm text-muted-foreground">
                  #{c.numid}
                </span>
              )}
              <ContractStateBadge state={c.state} />
            </>
          }
          tags={c.tags.length > 0 && <TagList tags={c.tags} />}
          description={c.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "devices", label: "Devices", count: c.device_count },
        { value: "documents", label: "Documents" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <ContractOverview contract={c} />
      </DetailTab>
      <DetailTab value="devices">
        <CoveredDevices contract={c} humanIds={humanIds} />
      </DetailTab>
      <DetailTab value="documents">
        <ObjectDocuments objectType="api.supportcontract" objectId={c.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.supportcontract" objectId={c.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.supportcontract" objectId={c.id} />
      </DetailTab>

      <SupportContractDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function ContractOverview({ contract: c }: { contract: SupportContract }) {
  const { canDo } = useMe()
  const contractRows: KvRow[] = [
    {
      label: "Manufacturer",
      value: (
        <Link
          to="/manufacturers/$id"
          params={{ id: c.manufacturer.id }}
          className="link"
        >
          {c.manufacturer.name}
        </Link>
      ),
    },
    {
      label: "Contract number",
      value: <span className="font-mono text-[13px]">{c.contract_number}</span>,
      copy: c.contract_number,
    },
    { label: "Service level", value: c.service_level || dash },
    { label: "State", value: <ContractStateBadge state={c.state} /> },
  ]
  const termRows: KvRow[] = [
    { label: "Start", value: <DateText value={c.start_date} /> },
    {
      label: "End",
      value: c.end_date ? (
        <DateText value={c.end_date} />
      ) : (
        <span className="text-muted-foreground">Open-ended</span>
      ),
    },
  ]
  // Cost is commercial data: the API leaves it out without view_cost.
  const cost = formatCost(c.cost, c.currency)
  const commercialRows: KvRow[] = [
    { label: "Reseller", value: c.reseller || dash },
    ...(canDo("supportcontract", "view_cost")
      ? [
          {
            label: "Cost",
            value: cost ? <span className="num">{cost}</span> : dash,
          },
        ]
      : []),
    {
      label: "Vendor portal",
      value: c.portal_url ? (
        <a
          href={c.portal_url}
          target="_blank"
          rel="noopener noreferrer"
          className="link inline-flex items-center gap-1 break-all"
        >
          {c.portal_url}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ) : (
        dash
      ),
    },
    {
      label: "Renewal notes",
      value: c.renewal_notes ? (
        <span className="whitespace-pre-wrap">{c.renewal_notes}</span>
      ) : (
        dash
      ),
    },
  ]
  const notifyRows: KvRow[] = [
    {
      label: "Channels",
      value: c.notify_channels.length
        ? c.notify_channels.map((ch) => ch.name).join(", ")
        : dash,
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="grid content-start gap-6">
        <KvCard title="Contract" rows={contractRows} />
        <KvCard title="Term" rows={termRows} />
      </div>
      <div className="grid content-start gap-6">
        <KvCard title="Commercial" rows={commercialRows} />
        <KvCard title="Notifications" rows={notifyRows} />
        <CustomFieldValues model="supportcontract" values={c.custom_fields} />
      </div>
    </div>
  )
}

function CoveredDevices({
  contract: c,
  humanIds,
}: {
  contract: SupportContract
  humanIds: boolean
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAdd = canDo("supportcoverage", "add")
  const canRemove = canDo("supportcoverage", "delete")
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<Device[]>([])

  const q = useQuery({
    queryKey: ["devices", "support-contract", c.id],
    queryFn: () =>
      api<Paginated<Device>>(
        `/api/devices/?support_contract=${c.id}&page_size=1000`
      ),
  })
  const columns = useMemo<ColumnDef<Device>[]>(
    () =>
      buildDeviceColumns<Device>({
        humanIds,
        selection: canRemove,
        include: [
          "numid",
          "name",
          "status",
          "coverage",
          "type",
          "site",
          "serial",
        ],
      }),
    [humanIds, canRemove]
  )
  const remove = useMutation({
    mutationFn: () =>
      api<{ removed: number }>("/api/support-coverage/bulk-remove/", {
        method: "POST",
        body: JSON.stringify({
          contract_id: c.id,
          device_ids: selected.map((d) => d.id),
        }),
      }),
    onSuccess: (r) => {
      toast.success(
        r.removed === 1 ? "Removed 1 device" : `Removed ${r.removed} devices`
      )
      setSelected([])
      qc.invalidateQueries({ queryKey: ["devices"] })
      qc.invalidateQueries({ queryKey: ["support-contract", c.id] })
      qc.invalidateQueries({ queryKey: ["support-contracts"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  const rows = q.data?.results ?? []
  return (
    <div className="grid gap-3">
      {(canAdd || (canRemove && selected.length > 0)) && (
        <div className="flex items-center justify-end gap-2">
          {canRemove && selected.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {remove.isPending ? "Removing…" : `Remove ${selected.length}`}
            </Button>
          )}
          {canAdd && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Add devices
            </Button>
          )}
        </div>
      )}
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title="No devices covered" />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          onSelectedRowsChange={canRemove ? setSelected : undefined}
          selectedRows={selected}
          flexColumn="name"
          tableId="support-contract-devices"
        />
      )}
      <SupportCoverageAddDialog
        contractId={c.id}
        open={adding}
        onOpenChange={setAdding}
      />
    </div>
  )
}
