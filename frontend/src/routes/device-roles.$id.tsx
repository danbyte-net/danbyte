import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type DeviceRole } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { DeviceRoleDeleteDialog } from "@/components/device-role-delete-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { EmbeddedDeviceTable } from "@/components/embedded-device-table"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { SnmpBindingControl } from "@/components/snmp-binding-control"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/device-roles/$id")({
  component: DeviceRoleDetail,
})

function DeviceRoleDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["device-role", id],
    queryFn: () => api<DeviceRole>(`/api/device-roles/${id}/`),
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
  return <Body role={q.data} />
}

function Body({ role: r }: { role: DeviceRole }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "devices" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<DeviceRole | null>(null)
  const goBack = useCallback(() => nav({ to: "/device-roles" }), [nav])
  const { canDo } = useMe()

  return (
    <DetailShell
      backTo="/device-roles"
      backLabel="Device roles"
      title={r.name}
      presence={{ type: "devicerole", id: r.id }}
      actions={
        <>
          {canDo("devicerole", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/device-roles/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("devicerole", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(r)}
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
              <ColorBadge name={r.name} color={r.color || undefined} />
              {r.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {r.description}
                </p>
              )}
            </div>
            <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              <DetailStat
                label="Devices"
                value={<span className="num">{r.device_count}</span>}
              />
              <DetailStat
                label="VMs"
                value={<span className="num">{r.vm_count}</span>}
              />
            </dl>
          </section>

          <section className="border-b border-border px-6 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-sm font-semibold">SNMP credentials</h2>
              <SnmpBindingControl
                scope="device_role"
                objectId={r.id}
                canEdit={canDo("devicerole", "change")}
              />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Default SNMP profile for devices with this role — a device or
              device type can override it.
            </p>
          </section>
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "devices", label: "Devices", count: r.device_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <DeviceRoleOverview role={r} />
      </DetailTab>
      <DetailTab value="devices">
        <EmbeddedDeviceTable filter={{ role: r.id }} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.devicerole" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.devicerole" objectId={r.id} />
      </DetailTab>

      <DeviceRoleDeleteDialog
        role={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Device-role attributes that used to crowd the header, grouped into tables.
 * Only the colored name badge, description and counts stay up top. */
function DeviceRoleOverview({ role: r }: { role: DeviceRole }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{r.slug}</span>,
      copy: r.slug,
    },
    {
      label: "Color",
      value: r.color ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-border"
            style={{ backgroundColor: r.color }}
          />
          <span className="font-mono">{r.color}</span>
        </span>
      ) : (
        dash
      ),
    },
    { label: "Created", value: <TimeCell iso={r.created_at} /> },
    { label: "Updated", value: <TimeCell iso={r.updated_at} /> },
  ]

  const behaviour: KvRow[] = [
    { label: "Patch-panel role", value: r.is_patch_panel ? "Yes" : "No" },
    { label: "Camera field of view", value: r.has_fov ? "Yes" : "No" },
    { label: "Config template", value: r.config_template?.name ?? dash },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Device role" rows={details} />
      <KvCard title="Behaviour" rows={behaviour} />
      <CustomFieldValues
        model="devicerole"
        values={r.custom_fields}
        layout="cards"
      />
    </div>
  )
}
