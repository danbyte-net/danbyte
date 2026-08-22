import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { CopyPlus, Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type DeviceType } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { QueryError } from "@/components/query-error"
import { DeviceTypeDeleteDialog } from "@/components/device-type-delete-dialog"
import { DeviceTypeImages } from "@/components/device-type-images"
import {
  DEVICE_TYPE_COMPONENT_SUBS,
  DeviceTypeComponentsPane,
} from "@/components/device-type-components-pane"
import type { SectionKind } from "@/components/device-type-components-pane"
import { DeviceTypeFaceplatePane } from "@/components/device-type-faceplate-pane"
import { DeviceSensorsCard } from "@/components/device-sensors-card"
import { ExportBundleButton } from "@/components/device-bundle"
import { DeviceTypeImagePortsPane } from "@/components/device-type-image-ports-pane"
import {
  DetailHero,
  DetailShell,
  DetailTab,
} from "@/components/detail-shell"
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

const DEVICE_TYPE_TABS = [
  "overview",
  "components",
  "faceplate",
  "photo-ports",
  "sensors",
  "devices",
  "journal",
  "history",
] as const
type DeviceTypeTab = (typeof DEVICE_TYPE_TABS)[number]

export const Route = createFileRoute("/device-types/$id")({
  // `?tab=components&sub=power-port` deep-links a component section. Both are
  // allow-listed here, so an unknown value never becomes part of the route's
  // search and the page falls back to its default instead of an empty pane.
  // Declaring them also puts both in the route's typed contract, so a `Link`
  // elsewhere can deep-link a section.
  validateSearch: (
    s: Record<string, unknown>
  ): { tab?: DeviceTypeTab; sub?: SectionKind } => ({
    ...(typeof s.tab === "string" &&
    DEVICE_TYPE_TABS.includes(s.tab as DeviceTypeTab)
      ? { tab: s.tab as DeviceTypeTab }
      : {}),
    ...(typeof s.sub === "string" &&
    DEVICE_TYPE_COMPONENT_SUBS.includes(s.sub as SectionKind)
      ? { sub: s.sub as SectionKind }
      : {}),
  }),
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
  const [tab, setTab] = useUrlTab<DeviceTypeTab>(
    "overview",
    "tab",
    DEVICE_TYPE_TABS
  )
  const { canDo, editableSites } = useMe()
  const nav = useNavigate()
  const canPromote =
    !!d.owning_site && editableSites === "all" && canDo("devicetype", "change")
  const canAddDevice = canDo("device", "add")
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
          {/* Everything that makes this model work, as one shareable file. */}
          <ExportBundleButton deviceTypeId={d.id} name={d.name} />
          {canDo("devicetype", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/device-types/$id/edit" params={{ id: d.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("devicetype", "add") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/device-types/new" search={{ clone: d.id }}>
                <CopyPlus className="h-3.5 w-3.5" /> Clone
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
          <DetailHero
            title={d.name}
            badges={
              <>
                <LifecycleBadge state={d.lifecycle_state} />
                <LocalityBadge owningSite={d.owning_site} />
                {canPromote && (
                  <PromoteToGlobalButton
                    url={`/api/device-types/${d.id}/promote/`}
                    name={d.name}
                    invalidate={[["device-types"], ["device-type", d.id]]}
                  />
                )}
              </>
            }
            tags={d.tags.length > 0 && <TagList tags={d.tags} />}
            description={d.description}
          />

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
              Default SNMP profile for devices of this type - overridden by a
              device's role or the device itself.
            </p>
          </section>

          <CustomFieldValues model="devicetype" values={d.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "components", label: "Components", count: d.component_count },
        { value: "faceplate", label: "Faceplate" },
        ...(d.front_image || d.rear_image
          ? [{ value: "photo-ports", label: "Photo ports" }]
          : []),
        { value: "sensors", label: "Sensors" },
        { value: "devices", label: "Devices", count: d.device_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
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
      <DetailTab value="photo-ports">
        <DeviceTypeImagePortsPane deviceType={d} />
      </DetailTab>
      {/* Not `bare`: that mode is for panes that fill the tab edge-to-edge and
          bring their own scroll region (Components). A Section-based card needs
          the shell's standard p-4/lg:p-6 like every other tab, or its heading
          sits flush against the tab strip. */}
      <DetailTab value="sensors">
        {/* Sensors belong to the MODEL, not one box: an OID that reads drive
            health on this chassis reads it on every one you own. Defined here,
            every device of this type inherits them. */}
        <DeviceSensorsCard deviceTypeId={d.id} typeScoped />
      </DetailTab>
      <DetailTab value="devices">
        <div className="grid gap-3">
          {canAddDevice && (
            <div className="flex justify-end">
              <Button size="sm" asChild>
                <Link to="/devices/new" search={{ device_type: d.id }}>
                  Add device
                </Link>
              </Button>
            </div>
          )}
          <EmbeddedDeviceTable
            filter={{ device_type: d.id }}
            emptyText="No devices of this type yet."
          />
        </div>
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
    {
      label: "Manufacturer",
      value: d.manufacturer ? (
        <Link
          to="/manufacturers/$id"
          params={{ id: d.manufacturer.id }}
          className="link"
        >
          {d.manufacturer.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Model",
      value: d.model ? (
        <span className="font-mono text-[13px]">{d.model}</span>
      ) : (
        dash
      ),
    },
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
          <Link to="/devices" search={{ type: d.id }} className="num link">
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
