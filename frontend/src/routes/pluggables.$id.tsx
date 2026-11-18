import { Suspense, useCallback, useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { accessoryKindLabel, api } from "@/lib/api"
import type {
  AccessoryHandField,
  AccessoryType,
  AccessoryUsageRow,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { lazyChunk } from "@/lib/lazy-chunk"
import { useMe } from "@/lib/use-me"
import { useSaveObject } from "@/lib/save-object"
import { useUrlTab } from "@/lib/use-url-tab"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable } from "@/components/data-table"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { EditButton, DeleteButton } from "@/components/action-ribbon"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { PluggableModelCard } from "@/components/pluggable-model"
import { packLabel } from "@/components/columns/pluggable-columns"
import { buildPluggableUsageColumns } from "@/components/columns/pluggable-usage-columns"
import { PluggableDeleteDialog } from "@/routes/pluggables.index"

// three.js stays in the 3D chunk: the converter loads when the dialog opens.
const ModelUpload = lazyChunk(
  () => import("@/components/floorplan3d/model-upload")
)

export const Route = createFileRoute("/pluggables/$id")({
  component: PluggableDetail,
})

const HAND_LABEL: Record<AccessoryHandField, string> = {
  fits: "Fits",
  parts: "Part numbers",
  standard: "Standard",
  wavelength_nm: "Wavelength",
  reach_m: "Reach",
  cable: "Cable",
  model: "3D model",
}

function PluggableDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["pluggable", id],
    queryFn: () => api<AccessoryType>(`/api/accessory-types/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body part={q.data} />
}

const mm = (v: number | null | undefined) =>
  v != null ? <span className="num">{v} mm</span> : dash

function Body({ part: p }: { part: AccessoryType }) {
  const [tab, setTab] = useUrlTab<"overview" | "usage" | "journal" | "history">(
    "overview"
  )
  const { canDo } = useMe()
  const canEdit = canDo("accessorytype", "change")
  const nav = useNavigate()
  const qc = useQueryClient()
  const [deleting, setDeleting] = useState<AccessoryType | null>(null)
  const [uploading, setUploading] = useState(false)
  const goBack = useCallback(() => nav({ to: "/pluggables" }), [nav])

  const saveObject = useSaveObject()
  const handBack = useMutation({
    mutationFn: () =>
      saveObject<AccessoryType>({
        objectType: "api.accessorytype",
        endpoint: "/api/accessory-types/",
        id: p.id,
        payload: { hand_edited: [] },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluggable", p.id] })
      toast.success("The next pack import sets these again")
    },
    onError: (err) => apiErrorToast(err),
  })

  const partRows: KvRow[] = [
    { label: "Kind", value: accessoryKindLabel(p.kind) },
    { label: "Vendor", value: p.vendor || dash },
    { label: "Connector", value: mono(p.connector) },
    {
      label: "Fits",
      value: (
        <span className="flex flex-wrap gap-1">
          {p.fits.map((f) => (
            <Badge key={f} variant="outline" className="font-mono">
              {f}
            </Badge>
          ))}
        </span>
      ),
    },
    { label: "Standard", value: p.standard || dash },
    {
      label: "Wavelength",
      value:
        p.wavelength_nm != null ? (
          <span className="num">{p.wavelength_nm} nm</span>
        ) : (
          dash
        ),
    },
    {
      label: "Reach",
      value:
        p.reach_m != null ? <span className="num">{p.reach_m} m</span> : dash,
    },
    { label: "In use", value: <span className="num">{p.in_use ?? 0}</span> },
  ]
  const records = p.part_records ?? {}
  const partNumberRows: KvRow[] = p.parts.length
    ? p.parts.map((n) => ({
        label: n,
        value: (
          <span className="num text-muted-foreground">
            {records[n] ?? 0} record{(records[n] ?? 0) === 1 ? "" : "s"}
          </span>
        ),
      }))
    : [{ label: "Part numbers", value: dash }]
  const cableRows: KvRow[] = p.cable
    ? [
        {
          label: "Profile",
          value:
            p.cable.profile === "zipcord"
              ? "Zip cord"
              : p.cable.profile === "ribbon"
                ? `Ribbon of ${p.cable.count ?? 2}`
                : "Round",
        },
        { label: "Jacket", value: mm(p.cable.jacket_mm) },
        { label: "Pitch", value: mm(p.cable.pitch_mm) },
        { label: "Minimum bend", value: mm(p.cable.min_bend_mm) },
        ...Object.entries(p.cable.min_bend_by_part ?? {}).map(([part, v]) => ({
          label: `Bend ${part}`,
          value: mm(v),
        })),
      ]
    : [{ label: "Cable", value: dash }]
  const pack = p.pack_import
  const packRows: KvRow[] = [
    { label: "Pack", value: packLabel(pack) || dash },
    { label: "File", value: mono(pack?.file) },
    {
      label: "Triangles",
      value:
        pack?.triangles != null ? (
          <span className="num">{pack.triangles.toLocaleString()}</span>
        ) : (
          dash
        ),
    },
    {
      label: "Changed by hand",
      value: p.hand_edited.length ? (
        <span className="flex flex-wrap items-center gap-1">
          {p.hand_edited.map((f) => (
            <Badge key={f} variant="secondary">
              {HAND_LABEL[f]}
            </Badge>
          ))}
          {canEdit && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={handBack.isPending}
              onClick={() => handBack.mutate()}
            >
              {handBack.isPending ? "Saving…" : "Give back to pack"}
            </Button>
          )}
        </span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <DetailShell
      backTo="/pluggables"
      backLabel="Pluggables"
      title={p.name}
      edit={
        canEdit && (
          <EditButton to="/pluggables/$id/edit" params={{ id: p.id }} />
        )
      }
      remove={
        canDo("accessorytype", "delete") && (
          <DeleteButton onClick={() => setDeleting(p)} />
        )
      }
      hero={<DetailHero title={p.name} />}
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "usage", label: "Usage", count: p.in_use ?? undefined },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="grid content-start gap-6">
            <KvCard title="Part" rows={partRows} />
            <KvCard title="Part numbers" rows={partNumberRows} />
            {p.kind !== "transceiver" && (
              <KvCard title="Cable" rows={cableRows} />
            )}
            <KvCard title="Pack" rows={packRows} />
          </div>
          <div className="grid content-start gap-3">
            <PluggableModelCard part={p} />
            {canEdit && (
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setUploading(true)}
                >
                  {p.model_url ? "Replace model" : "Upload model"}
                </Button>
              </div>
            )}
          </div>
        </div>
      </DetailTab>
      <DetailTab value="usage">
        <UsagePane id={p.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.accessorytype" objectId={p.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.accessorytype" objectId={p.id} />
      </DetailTab>

      <Dialog open={uploading} onOpenChange={setUploading}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              {p.model_url ? "Replace 3D model" : "Upload 3D model"}
            </DialogTitle>
          </DialogHeader>
          {uploading && (
            <Suspense fallback={<Loading />}>
              <ModelUpload
                kind="accessory-types"
                id={p.id}
                onCancel={() => setUploading(false)}
                onSaved={(data) => {
                  setUploading(false)
                  const notes = (data as AccessoryType).model_notes ?? []
                  toast.success("Model replaced", {
                    description: notes.join(" "),
                  })
                  void qc.invalidateQueries({ queryKey: ["pluggable", p.id] })
                  void qc.invalidateQueries({ queryKey: ["pluggables"] })
                }}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
      <PluggableDeleteDialog
        part={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function UsagePane({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["pluggable-usage", id],
    queryFn: () =>
      apiAll<AccessoryUsageRow>(`/api/accessory-types/${id}/usage/`),
  })
  const rows = q.data?.results ?? []
  const columns = useMemo(() => buildPluggableUsageColumns(), [])
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0) return <EmptyState title="No port shows this part." />
  return (
    <DataTable
      data={rows}
      columns={columns}
      tableId="pluggable-usage"
      flexColumn="device"
    />
  )
}
