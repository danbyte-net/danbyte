import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"

import { api } from "@/lib/api"
import type {
  Interface,
  Paginated,
  TerminationInput,
  TerminationKind,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DevicePicker } from "@/components/device-picker"
import { FaceplateView, useHasImagePorts } from "@/components/device-faceplate"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Field } from "@/components/forms"
import { cn } from "@/lib/utils"

/** One end of a cable, picked the way people actually patch: look at the
 * panel, click the port. The faceplate is the primary control; the list
 * below is the keyboard/search path and the only way to reach kinds a panel
 * doesn't draw (console, power, aux).
 *
 * Ports already carrying a cable are shown but not selectable - hiding them
 * would make a 48-port panel lie about which slot is which. */

const KIND_ENDPOINT: Record<Exclude<TerminationKind, "power_feed">, string> = {
  interface: "interfaces",
  front_port: "front-ports",
  rear_port: "rear-ports",
  console_port: "console-ports",
  console_server_port: "console-server-ports",
  power_port: "power-ports",
  power_outlet: "power-outlets",
  aux_port: "aux-ports",
}

const LABEL_ENDPOINT: Record<TerminationKind, string> = {
  ...KIND_ENDPOINT,
  power_feed: "power-feeds",
}

const KIND_TABS: { value: string; label: string }[] = [
  { value: "interface", label: "Interfaces" },
  { value: "front_port", label: "Front" },
  { value: "rear_port", label: "Rear" },
  { value: "console_port", label: "Console" },
  { value: "power_port", label: "Power" },
  { value: "aux_port", label: "Aux" },
]

interface PortRow {
  id: string
  name: string
  cable?: { id: string } | null
  mark_connected?: boolean
  device?: { id: string; name: string }
}

const keyOf = (t: { kind: TerminationKind; id: string }) => `${t.kind}:${t.id}`

/** One line of capacity: bar + "12 of 48 free". The full card belongs on a
 * device page; in a form it only has to answer "is there room here?". */
function PortsFreeBar({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["device-port-utilization", deviceId],
    queryFn: () =>
      api<{ combined: { total: number; connected: number; reserved: number } }>(
        `/api/devices/${deviceId}/port-utilization/`
      ),
    staleTime: 60_000,
  })
  const d = q.data?.combined
  if (!d || d.total === 0) return null
  const used = d.connected + d.reserved
  const free = d.total - used
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <div className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary"
          style={{ width: `${(used / d.total) * 100}%` }}
        />
      </div>
      <span className="num">
        <span className="font-medium text-foreground">{free}</span> of {d.total}{" "}
        free
      </span>
    </div>
  )
}

export function CableEndpointPicker({
  label,
  hint,
  value,
  onChange,
  seedDeviceId,
  error,
}: {
  label: string
  hint?: string
  value: TerminationInput[]
  onChange: (next: TerminationInput[]) => void
  /** Device of a pre-seeded termination, so the panel opens on it. */
  seedDeviceId?: string | null
  error?: string
}) {
  // A side can span several devices - a QSFP breakout lands on four hosts.
  // Each slot is a tab with its own panel; every slot's picks pool into the
  // one termination list this side submits.
  const [slots, setSlots] = useState<(string | null)[]>([seedDeviceId ?? null])
  const [slot, setSlot] = useState(0)
  const deviceId = slots[slot] ?? null
  const setDeviceId = (v: string | null) =>
    setSlots((prev) => prev.map((d, i) => (i === slot ? v : d)))
  const [kind, setKind] = useState<string>("interface")
  const [q, setQ] = useState("")
  const [names, setNames] = useState<Record<string, string>>({})
  const [slotNames, setSlotNames] = useState<Record<number, string>>({})
  // Front or rear panel - servers and many switches have ports on both.
  const [side, setSide] = useState<"front" | "rear">("front")
  // Hovering a row lights that port on the panel - the list and the picture
  // are two views of the same thing, so pointing at one should point at both.
  const [hoverId, setHoverId] = useState<string | null>(null)

  const device = useQuery({
    queryKey: ["device", deviceId],
    queryFn: () =>
      api<{
        id: string
        name: string
        device_type: {
          id: string
          front_image?: string
          rear_image?: string
        } | null
      }>(`/api/devices/${deviceId}/`),
    enabled: !!deviceId,
  })
  const ifaces = useQuery({
    queryKey: ["device-interfaces", deviceId],
    queryFn: () =>
      api<Paginated<Interface>>(`/api/devices/${deviceId}/interfaces/`),
    enabled: !!deviceId,
  })
  const ports = useQuery({
    queryKey: ["cable-ports", kind, deviceId],
    queryFn: () =>
      api<Paginated<PortRow>>(
        `/api/${KIND_ENDPOINT[kind as keyof typeof KIND_ENDPOINT]}/?device=${deviceId}&page_size=500`
      ),
    enabled: !!deviceId,
  })

  // A termination can arrive already chosen ("Connect cable" from a port
  // page, or an edit). Resolve its name so the chip reads as a port, and
  // open the panel on its device.
  const unresolved = value.filter((v) => !names[keyOf(v)])
  useEffect(() => {
    if (unresolved.length === 0) return
    let alive = true
    void Promise.all(
      unresolved.map((v) =>
        api<PortRow>(`/api/${LABEL_ENDPOINT[v.kind]}/${v.id}/`).catch(
          () => null
        )
      )
    ).then((rows) => {
      if (!alive) return
      const add: Record<string, string> = {}
      rows.forEach((r, i) => {
        if (!r) return
        const v = unresolved[i]
        add[keyOf(v)] = r.device ? `${r.device.name}:${r.name}` : r.name
        if (!slots[0] && r.device)
          setSlots((prev) => [r.device!.id, ...prev.slice(1)])
      })
      if (Object.keys(add).length) setNames((prev) => ({ ...prev, ...add }))
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const deviceName = device.data?.name
  useEffect(() => {
    if (!deviceName) return
    setSlotNames((prev) =>
      prev[slot] === deviceName ? prev : { ...prev, [slot]: deviceName }
    )
  }, [deviceName, slot])

  const hasPhoto = useHasImagePorts(device.data?.device_type?.id)
  const dt = device.data?.device_type
  const hasTypeImage = !!(dt?.front_image || dt?.rear_image)
  // What to show without being asked: the photo with its mapped ports if the
  // type has them, else just the picture so it's obvious which box this is.
  // The schematic is a click away when neither exists (or when wanted).
  const [showRendered, setShowRendered] = useState(false)
  const effView: "photo" | "bare" | "rendered" = showRendered
    ? "rendered"
    : hasPhoto
      ? "photo"
      : hasTypeImage
        ? "bare"
        : "rendered"
  const selected = useMemo(() => new Set(value.map(keyOf)), [value])
  const rows = (ports.data?.results ?? []).filter((r) =>
    q ? r.name.toLowerCase().includes(q.toLowerCase()) : true
  )

  const toggle = (
    k: TerminationKind,
    id: string,
    cabled: boolean,
    name?: string
  ) => {
    if (cabled) return
    const key = keyOf({ kind: k, id })
    if (name) setNames((prev) => ({ ...prev, [key]: name }))
    onChange(
      selected.has(key)
        ? value.filter((v) => keyOf(v) !== key)
        : [...value, { kind: k, id }]
    )
  }

  // The panel's ports carry data-port-{name,kind,id}; one delegated handler
  // turns any of them into a selection instead of a navigation, for both the
  // rendered cages and the photo markers.
  const onPanelClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-port-id]")
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    const id = el.dataset.portId
    const portKind = (el.dataset.portKind || "interface") as TerminationKind
    const state = el.dataset.cableState
    if (!id) return
    toggle(
      portKind,
      id,
      state === "connected" || state === "marked",
      el.dataset.portName
    )
  }

  return (
    <Field label={label} hint={hint} error={error}>
      <div className="grid gap-3">
        {(slots.length > 1 || value.length > 0) && (
          <div className="flex items-center gap-1">
            {slots.map((_, i) => (
              <Button
                key={i}
                type="button"
                variant={i === slot ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => setSlot(i)}
              >
                {slotNames[i] ?? `Device ${i + 1}`}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => {
                setSlots((prev) => [...prev, null])
                setSlot(slots.length)
              }}
              title="Another device on this end (breakout)"
            >
              + device
            </Button>
          </div>
        )}

        {deviceId && (ifaces.data?.results?.length ?? 0) > 0 && (
          <div className="grid gap-2">
            {/* Picked ports wear the connected green - they're what this
                cable will land on, so they should read like a state, not a
                selection outline. Hover is the dashed version. */}
            <style>
              {value
                .map(
                  (v) =>
                    `[data-cable-pick="${label}"] [data-port-id="${v.id}"]{outline:2px solid #10b981;outline-offset:1px;background:#10b98159;--port-color:#10b981}`
                )
                .join("") +
                (hoverId
                  ? `[data-cable-pick="${label}"] [data-port-id="${hoverId}"]{outline:2px dashed #10b981;outline-offset:2px}`
                  : "")}
            </style>
            <div
              data-cable-pick={label}
              className="overflow-x-auto [&_a]:cursor-pointer"
              onClickCapture={onPanelClick}
            >
              <FaceplateView
                interfaces={ifaces.data?.results ?? []}
                deviceId={deviceId}
                deviceTypeId={device.data?.device_type?.id ?? null}
                mode={effView === "rendered" ? "rendered" : "image"}
                side={side}
                fit="container"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                {effView === "bare"
                  ? "Open the port view to pick by clicking"
                  : "Click a port to select it"}
              </span>
              <span className="flex items-center gap-1">
                {(dt?.rear_image || showRendered) && (
                  <span className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
                    {(["front", "rear"] as const).map((sd) => (
                      <Button
                        key={sd}
                        type="button"
                        variant={side === sd ? "secondary" : "ghost"}
                        size="sm"
                        className="h-5 px-1.5 text-[10px] capitalize"
                        onClick={() => setSide(sd)}
                      >
                        {sd}
                      </Button>
                    ))}
                  </span>
                )}
                {(hasPhoto || hasTypeImage) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setShowRendered((v) => !v)}
                  >
                    {showRendered ? "Show photo" : "Show device ports"}
                  </Button>
                )}
              </span>
            </div>
          </div>
        )}

        <div className="grid gap-1.5">
          <DevicePicker
            label="Device"
            value={deviceId}
            onChange={(v) => {
              setDeviceId(v)
              setQ("")
            }}
          />
          {deviceId && <PortsFreeBar deviceId={deviceId} />}
        </div>

        {deviceId && (
          <div className="grid gap-2">
            <SegmentedTabs
              value={kind}
              onValueChange={(v) => {
                setKind(v)
                setQ("")
              }}
              items={KIND_TABS}
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter ports…"
              className="h-8 text-xs"
            />
            <div className="max-h-56 overflow-y-auto rounded-md border border-border">
              {rows.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  {ports.isLoading ? "Loading…" : "No ports of this kind."}
                </p>
              ) : (
                rows.map((r) => {
                  const cabled = !!r.cable || !!r.mark_connected
                  const key = keyOf({ kind: kind as TerminationKind, id: r.id })
                  const on = selected.has(key)
                  return (
                    <button
                      key={r.id}
                      type="button"
                      disabled={cabled}
                      onClick={() =>
                        toggle(kind as TerminationKind, r.id, cabled, r.name)
                      }
                      onMouseEnter={() => setHoverId(r.id)}
                      onMouseLeave={() =>
                        setHoverId((cur) => (cur === r.id ? null : cur))
                      }
                      onFocus={() => setHoverId(r.id)}
                      onBlur={() =>
                        setHoverId((cur) => (cur === r.id ? null : cur))
                      }
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs",
                        on && "bg-accent text-accent-foreground",
                        cabled
                          ? "cursor-not-allowed text-muted-foreground/60"
                          : "hover:bg-accent/60"
                      )}
                    >
                      <span className="truncate font-mono">{r.name}</span>
                      {cabled && (
                        <span className="text-[10px]">already cabled</span>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        )}

        {value.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {value.length > 1 && (
              <span className="text-[11px] text-muted-foreground">
                {value.length} ports on this end
              </span>
            )}
            {value.map((v) => (
              <Badge
                key={keyOf(v)}
                variant="secondary"
                className="gap-1"
                onMouseEnter={() => setHoverId(v.id)}
                onMouseLeave={() =>
                  setHoverId((cur) => (cur === v.id ? null : cur))
                }
              >
                <span className="font-mono">
                  {names[keyOf(v)] ?? v.id.slice(0, 8)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-4 w-4"
                  onClick={() =>
                    onChange(value.filter((x) => keyOf(x) !== keyOf(v)))
                  }
                >
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </Field>
  )
}
