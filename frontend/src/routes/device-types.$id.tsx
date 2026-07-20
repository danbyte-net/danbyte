import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type DeviceType } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { QueryError } from "@/components/query-error"
import { DeviceTypeDeleteDialog } from "@/components/device-type-delete-dialog"
import { DeviceTypeImages } from "@/components/device-type-images"
import { DeviceTypeComponentsPane } from "@/components/device-type-components-pane"
import { DeviceTypeFaceplatePane } from "@/components/device-type-faceplate-pane"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import {
  LocalityBadge,
  PromoteToGlobalButton,
} from "@/components/locality-badge"
import { EmbeddedDeviceTable } from "@/components/embedded-device-table"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { LifecycleCard } from "@/components/lifecycle-card"
import { LifecycleBadge } from "@/components/cells/lifecycle-cell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { SnmpBindingControl } from "@/components/snmp-binding-control"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/device-types/$id")({
  component: DeviceTypeDetail,
})

function DeviceTypeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["device-type", id],
    queryFn: () => api<DeviceType>(`/api/device-types/${id}/`),
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
  return <Body deviceType={q.data} />
}

function Body({ deviceType: d }: { deviceType: DeviceType }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "components" | "faceplate" | "devices" | "journal" | "history"
  >("overview")
  const { canDo, editableSites } = useMe()
  const nav = useNavigate()
  const canPromote =
    !!d.owning_site && editableSites === "all" && canDo("devicetype", "change")
  const [deleting, setDeleting] = useState<DeviceType | null>(null)
  const goBack = useCallback(() => nav({ to: "/device-types" }), [nav])

  return (
    <DetailShell
      backTo="/device-types"
      backLabel="Device types"
      title={d.name}
      presence={{ type: "devicetype", id: d.id }}
      actions={
        <>
          {canDo("devicetype", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/device-types/$id/edit" params={{ id: d.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("devicetype", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(d)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xl font-semibold tracking-tight">
                  {d.name}
                </span>
                <LifecycleBadge state={d.lifecycle_state} />
                <LocalityBadge owningSite={d.owning_site} />
                {canPromote && (
                  <PromoteToGlobalButton
                    url={`/api/device-types/${d.id}/promote/`}
                    name={d.name}
                    invalidate={[["device-types"], ["device-type", d.id]]}
                  />
                )}
              </div>
              {d.tags.length > 0 && (
                <div className="mt-2">
                  <TagList tags={d.tags} />
                </div>
              )}
              {d.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {d.description}
                </p>
              )}
            </div>
            <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              <DetailStat
                label="Manufacturer"
                value={
                  d.manufacturer ? (
                    <Link
                      to="/manufacturers/$id"
                      params={{ id: d.manufacturer.id }}
                      className="text-primary hover:underline"
                    >
                      {d.manufacturer.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
              />
              <DetailStat
                label="Model"
                value={
                  d.model ? (
                    <span className="font-mono text-[13px]">{d.model}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
              />
            </dl>
          </section>

          <section className="border-b border-border px-6 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-sm font-semibold">SNMP credentials</h2>
              <SnmpBindingControl
                scope="device_type"
                objectId={d.id}
                canEdit={canDo("devicetype", "change")}
              />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Default SNMP profile for devices of this type — overridden by a
              device's role or the device itself.
            </p>
          </section>

          <CustomFieldValues model="devicetype" values={d.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "components", label: "Components" },
        { value: "faceplate", label: "Faceplate" },
        { value: "devices", label: "Devices", count: d.device_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <DeviceTypeOverview deviceType={d} />

        <div className="mt-6">
          <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
            Rack-face images
          </h2>
          <p className="mb-3 max-w-2xl text-[12px] text-muted-foreground">
            Front and rear images are painted onto this type's devices in rack
            elevations.
          </p>
          <DeviceTypeImages deviceType={d} />
        </div>
      </DetailTab>
      <DetailTab value="components" bare>
        <DeviceTypeComponentsPane deviceTypeId={d.id} />
      </DetailTab>
      <DetailTab value="faceplate">
        <DeviceTypeFaceplatePane deviceType={d} />
      </DetailTab>
      <DetailTab value="devices">
        <EmbeddedDeviceTable
          filter={{ device_type: d.id }}
          emptyText="No devices of this type yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.devicetype" objectId={d.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.devicetype" objectId={d.id} />
      </DetailTab>

      <DeviceTypeDeleteDialog
        deviceType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Device-type attributes that used to crowd the header, grouped into labelled
 * tables. Only the identifying manufacturer/model stay up top. */
function DeviceTypeOverview({ deviceType: d }: { deviceType: DeviceType }) {
  const { humanIds } = useMe()

  const hardware: KvRow[] = [
    ...(humanIds && d.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{d.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Part number", value: d.part_number || dash },
    {
      label: "Rack units",
      value: <span className="num">{d.u_height}U</span>,
    },
  ]

  const usage: KvRow[] = [
    {
      label: "Devices",
      value:
        d.device_count > 0 ? (
          <Link
            to="/devices"
            search={{ type: d.id }}
            className="num text-primary hover:underline"
          >
            {d.device_count}
          </Link>
        ) : (
          <span className="num text-muted-foreground">0</span>
        ),
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Hardware" rows={hardware} />
      <div className="grid gap-6">
        <KvCard title="Usage" rows={usage} />
        <LifecycleCard item={d} />
      </div>
    </div>
  )
}
