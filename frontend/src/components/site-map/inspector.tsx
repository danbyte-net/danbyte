import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQueries } from "@tanstack/react-query"
import {
  Building2,
  ExternalLink,
  MapPinOff,
  Plus,
  Trash2,
  X,
} from "lucide-react"

import {
  api,
  type FrontPort,
  type Interface,
  type Paginated,
  type RearPort,
  type SiteMapConnection,
  type SiteMapDevice,
  type SiteMapMarker,
  type SiteMapSite,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ColorBadge } from "@/components/cells/color-badge"
import { CheckDot } from "@/components/foldable-group"
import { TileBadge } from "@/components/floorplan/tile-badge"
import { Field } from "@/components/forms"
import { CableForm } from "@/components/cable-form"
import { DevicePathsList } from "@/components/device-paths-list"
import { cn } from "@/lib/utils"
import { KIND_COLOR } from "@/components/site-map/connections-layer"

// The site map's right inspector — a direct clone of the floor planner's
// TileInspector: w-72, uppercase header with coordinates, identity row with
// the type badge, fields, and the destructive action pinned to the bottom.

function num(v: number | string) {
  return Number(v).toFixed(4)
}

function InspectorShell({
  kind,
  coords,
  onClose,
  children,
}: {
  kind: string
  coords?: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          {kind}
        </span>
        <span className="flex items-center gap-2">
          {coords && (
            <span className="num text-[11px] text-muted-foreground">
              {coords}
            </span>
          )}
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close inspector"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {children}
    </aside>
  )
}

export function SiteInspector({
  site: s,
  onClose,
}: {
  site: SiteMapSite
  onClose: () => void
}) {
  return (
    <InspectorShell
      kind="Site"
      coords={
        s.latitude !== null ? `${num(s.latitude)}, ${num(s.longitude!)}` : ""
      }
      onClose={onClose}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-muted text-muted-foreground">
          <Building2 className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 truncate font-medium">{s.name}</span>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <CheckDot check={s.check} />
        {s.device_count} device{s.device_count === 1 ? "" : "s"}
        {s.floor_plan_count > 0 &&
          ` · ${s.floor_plan_count} floor plan${s.floor_plan_count === 1 ? "" : "s"}`}
      </div>
      {s.floor_plans.length > 0 && (
        <div className="grid gap-2">
          <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            Floor plans
          </span>
          <div className="grid gap-0.5">
            {s.floor_plans.map((fp) => (
              <Link
                key={fp.id}
                to="/floorplans/$id"
                params={{ id: fp.id }}
                className="truncate rounded px-1.5 py-1 text-[12px] hover:bg-muted"
              >
                ⌗ {fp.name}
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="mt-auto grid gap-2 border-t border-border pt-3">
        <Button variant="outline" size="sm" asChild className="w-full">
          <Link to="/sites/$id" params={{ id: s.id }}>
            <ExternalLink className="h-3.5 w-3.5" /> Open site
          </Link>
        </Button>
      </div>
    </InspectorShell>
  )
}

export function DeviceInspector({
  device: d,
  editing,
  fovEditor,
  onTraceCables,
  onConnected,
  onRemove,
  onClose,
}: {
  device: SiteMapDevice
  editing: boolean
  /** FOV editor slot — rendered when the device's role has FOV. */
  fovEditor?: React.ReactNode
  /** Highlight a run's cables on the map. */
  onTraceCables?: (cableIds: string[]) => void
  /** Called after a cable is connected from the Ports section. */
  onConnected?: () => void
  onRemove: () => void
  onClose: () => void
}) {
  return (
    <InspectorShell
      kind="Device"
      coords={`${num(d.latitude)}, ${num(d.longitude)}`}
      onClose={onClose}
    >
      <div className="flex items-center gap-2 text-sm">
        <TileBadge color={d.role?.color ?? ""} />
        <span className="min-w-0 truncate font-mono font-medium">{d.name}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {d.status && (
          <ColorBadge
            name={d.status.name}
            color={d.status.color || undefined}
          />
        )}
        {d.role && (
          <ColorBadge name={d.role.name} color={d.role.color || undefined} />
        )}
        {d.device_type && <Badge variant="outline">{d.device_type}</Badge>}
      </div>
      {d.front_image && (
        <img
          src={d.front_image}
          alt={d.device_type ?? "device"}
          className="max-h-16 w-full rounded-md border border-border object-contain"
        />
      )}
      {d.site && (
        <div className="text-[12px] text-muted-foreground">
          Site:{" "}
          <Link
            to="/sites/$id"
            params={{ id: d.site.id }}
            className="hover:underline"
          >
            {d.site.name}
          </Link>
        </div>
      )}
      {fovEditor}

      <div className="grid gap-1.5">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Cabling
        </span>
        <DevicePathsList
          deviceId={d.id}
          onTraceCables={onTraceCables}
          max={4}
          emptyText="Nothing cabled yet — connect a port below."
        />
      </div>

      <DevicePortsSection device={d} onConnected={onConnected} />

      <div className="mt-auto grid gap-2 border-t border-border pt-3">
        <Button variant="outline" size="sm" asChild className="w-full">
          <Link to="/devices/$id" params={{ id: d.id }}>
            <ExternalLink className="h-3.5 w-3.5" /> Open device
          </Link>
        </Button>
        {editing && d.can_edit && (
          <Button
            variant="outline"
            size="sm"
            className="w-full text-destructive hover:text-destructive"
            onClick={onRemove}
          >
            <MapPinOff className="h-3.5 w-3.5" /> Remove from map
          </Button>
        )}
      </div>
    </InspectorShell>
  )
}

export function MarkerInspector({
  marker: m,
  canEdit,
  editing,
  deviceLink,
  fovEditor,
  onTraceCables,
  onUpdate,
  onDelete,
  onClose,
}: {
  marker: SiteMapMarker
  canEdit: boolean
  editing: boolean
  /** Linked-device picker slot. */
  deviceLink?: React.ReactNode
  /** FOV editor slot — rendered when the marker's type has FOV. */
  fovEditor?: React.ReactNode
  /** Highlight the linked device's cables on the map. */
  onTraceCables?: (cableIds: string[]) => void
  onUpdate: (patch: { label?: string; description?: string }) => void
  onDelete: () => void
  onClose: () => void
}) {
  return (
    <InspectorShell
      kind="Marker"
      coords={`${num(m.latitude)}, ${num(m.longitude)}`}
      onClose={onClose}
    >
      <div className="flex items-center gap-2 text-sm">
        <TileBadge color={m.type?.color ?? ""} icon={m.type?.icon} />
        <span className="min-w-0 truncate font-medium">
          {m.label || m.device?.name || m.type?.name || "Marker"}
        </span>
      </div>
      {canEdit ? (
        <MarkerFields key={m.id} marker={m} onUpdate={onUpdate} />
      ) : (
        m.description && (
          <p className="text-[12px] text-muted-foreground">{m.description}</p>
        )
      )}
      {deviceLink}
      {fovEditor}
      {m.device && (
        <div className="grid gap-1.5">
          <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            Cabling
          </span>
          <DevicePathsList
            deviceId={m.device.id}
            onTraceCables={onTraceCables}
            max={4}
            emptyText="The linked device has nothing cabled yet."
          />
        </div>
      )}
      <div className="mt-auto grid gap-2 border-t border-border pt-3">
        {m.device && (
          <Button variant="outline" size="sm" asChild className="w-full">
            <Link to="/devices/$id" params={{ id: m.device.id }}>
              <ExternalLink className="h-3.5 w-3.5" /> Open {m.device.name}
            </Link>
          </Button>
        )}
        {canEdit && editing && (
          <Button
            variant="outline"
            size="sm"
            className="w-full text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove marker
          </Button>
        )}
      </div>
    </InspectorShell>
  )
}

/** Label + description — saved on blur or Enter, like tray fields. */
function MarkerFields({
  marker: m,
  onUpdate,
}: {
  marker: SiteMapMarker
  onUpdate: (patch: { label?: string; description?: string }) => void
}) {
  const [label, setLabel] = useState(m.label)
  const [description, setDescription] = useState(m.description)
  return (
    <>
      <Field label="Label" hint="Overrides the type name">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== m.label && onUpdate({ label })}
          onKeyDown={(e) =>
            e.key === "Enter" && (e.target as HTMLElement).blur()
          }
          placeholder={m.type?.name || "Optional"}
          className="h-8 text-sm"
        />
      </Field>
      <Field label="Description">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() =>
            description !== m.description && onUpdate({ description })
          }
          onKeyDown={(e) =>
            e.key === "Enter" && (e.target as HTMLElement).blur()
          }
          placeholder="Optional"
          className="h-8 text-sm"
        />
      </Field>
    </>
  )
}

export function ConnectionInspector({
  edge: e,
  onClose,
}: {
  edge: SiteMapConnection
  onClose: () => void
}) {
  const rawId = e.id.split(":")[1]
  const detail =
    e.kind === "circuit"
      ? `/circuits/${rawId}`
      : e.kind === "tunnel"
        ? `/tunnels/${rawId}`
        : null
  const meta = e.meta as Record<string, unknown>
  return (
    <InspectorShell kind="Link" onClose={onClose}>
      <div className="flex items-center gap-2 text-sm">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: e.color || KIND_COLOR[e.kind] }}
        />
        <span
          className={
            "min-w-0 truncate font-medium " +
            (e.kind === "circuit" ? "font-mono" : "")
          }
        >
          {e.name}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="uppercase">
          {e.kind}
        </Badge>
        {e.status && (
          <ColorBadge
            name={e.status.name}
            color={e.status.color || undefined}
          />
        )}
      </div>
      <div className="text-[12px] text-muted-foreground">
        <Link
          to="/sites/$id"
          params={{ id: e.site_a.id }}
          className="hover:underline"
        >
          {e.site_a.name}
        </Link>
        {" ↔ "}
        <Link
          to="/sites/$id"
          params={{ id: e.site_z.id }}
          className="hover:underline"
        >
          {e.site_z.name}
        </Link>
      </div>
      {e.kind === "circuit" && (
        <div className="grid gap-0.5 text-[12px] text-muted-foreground">
          {meta.provider ? (
            <span>Provider: {String(meta.provider)}</span>
          ) : null}
          {meta.type ? <span>Type: {String(meta.type)}</span> : null}
          {meta.commit_rate_kbps ? (
            <span className="num">
              Commit: {Number(meta.commit_rate_kbps) / 1000} Mbps
            </span>
          ) : null}
        </div>
      )}
      {e.kind === "tunnel" && (
        <div className="grid gap-0.5 text-[12px] text-muted-foreground">
          {meta.encapsulation ? (
            <span className="font-mono">{String(meta.encapsulation)}</span>
          ) : null}
          {meta.group ? <span>Group: {String(meta.group)}</span> : null}
        </div>
      )}
      {e.kind === "cable" && (
        <div className="text-[12px] text-muted-foreground">
          {String(meta.count)} cable{Number(meta.count) === 1 ? "" : "s"}
        </div>
      )}
      {detail && (
        <div className="mt-auto grid gap-2 border-t border-border pt-3">
          <Button variant="outline" size="sm" asChild className="w-full">
            <Link to={detail}>
              <ExternalLink className="h-3.5 w-3.5" /> Open{" "}
              {e.kind === "circuit" ? "circuit" : "tunnel"}
            </Link>
          </Button>
        </div>
      )}
    </InspectorShell>
  )
}

/** The device's cable-able ports, each cabled (● click to trace) or empty
 * (＋ Connect → seeds a cable form with that port as the A-side). The fast
 * way to wire fiber straight from the map. */
function DevicePortsSection({
  device: d,
  onConnected,
}: {
  device: SiteMapDevice
  onConnected?: () => void
}) {
  const [connect, setConnect] = useState<{
    kind: "interface" | "front_port" | "rear_port"
    id: string
    name: string
  } | null>(null)

  const [ifs, fps, rps] = useQueries({
    queries: [
      {
        queryKey: ["ports", "interface", d.id],
        queryFn: () =>
          api<Paginated<Interface>>(
            `/api/interfaces/?device=${d.id}&page_size=500`
          ),
      },
      {
        queryKey: ["ports", "front", d.id],
        queryFn: () =>
          api<Paginated<FrontPort>>(
            `/api/front-ports/?device=${d.id}&page_size=500`
          ),
      },
      {
        queryKey: ["ports", "rear", d.id],
        queryFn: () =>
          api<Paginated<RearPort>>(
            `/api/rear-ports/?device=${d.id}&page_size=500`
          ),
      },
    ],
  })

  type Row = {
    kind: "interface" | "front_port" | "rear_port"
    id: string
    name: string
    label: string
    cable: { color: string } | null
  }
  const rows: Row[] = [
    ...(ifs.data?.results ?? []).map((p) => ({
      kind: "interface" as const,
      id: p.id,
      name: p.name,
      label: "if",
      cable: p.cable,
    })),
    ...(rps.data?.results ?? []).map((p) => ({
      kind: "rear_port" as const,
      id: p.id,
      name: p.name,
      label: p.is_splitter ? "splitter" : "rear",
      cable: p.cable,
    })),
    ...(fps.data?.results ?? []).map((p) => ({
      kind: "front_port" as const,
      id: p.id,
      name: p.name,
      label: "front",
      cable: p.cable,
    })),
  ]

  if (ifs.isLoading || fps.isLoading || rps.isLoading)
    return <div className="h-10 w-full animate-pulse rounded bg-muted/30" />
  if (rows.length === 0) return null

  return (
    <div className="grid gap-1.5">
      <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        Ports
      </span>
      <ul className="grid gap-0.5">
        {rows.map((r) => (
          <li
            key={`${r.kind}:${r.id}`}
            className="flex items-center gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-muted/40"
          >
            <span className="w-12 shrink-0 text-[10px] text-muted-foreground/70">
              {r.label}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono">{r.name}</span>
            {r.cable ? (
              <span
                className="size-2.5 shrink-0 rounded-full"
                title="Cabled"
                style={{ backgroundColor: r.cable.color || "#0ea5e9" }}
              />
            ) : (
              <button
                type="button"
                className={cn(
                  "inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5",
                  "text-[11px] text-primary hover:bg-primary/10"
                )}
                onClick={() =>
                  setConnect({ kind: r.kind, id: r.id, name: r.name })
                }
              >
                <Plus className="size-3" /> Connect
              </button>
            )}
          </li>
        ))}
      </ul>

      <Dialog
        open={connect !== null}
        onOpenChange={(o) => !o && setConnect(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Connect a cable from {d.name}:{connect?.name}
            </DialogTitle>
          </DialogHeader>
          {connect && (
            <CableForm
              initialA={[{ kind: connect.kind, id: connect.id }]}
              onSaved={() => {
                setConnect(null)
                onConnected?.()
              }}
              onCancel={() => setConnect(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
