import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Activity, Pencil, Plus, Search, Trash2, X } from "lucide-react"

import {
  api,
  INVENTORY_KIND_OPTIONS,
  type InventoryItemKind,
  type Paginated,
  type SnmpSensor,
  type Status,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Section } from "@/components/ui/section"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FormCheckbox, FormSelect } from "@/components/forms"
import { OidExplorer } from "@/components/oid-explorer"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

interface SensorReading {
  sensor: string
  name: string
  raw: string
  status: string
}

/**
 * Custom SNMP sensors for a device — define an OID + value map once, poll it
 * with the device's SNMP profile, and watch inventory-item statuses flip.
 * The escape hatch for BMCs / gear that expose health only over vendor OIDs.
 */
export function DeviceSensorsCard({
  deviceId,
  deviceTypeId,
}: {
  deviceId: string
  deviceTypeId?: string | null
}) {
  const { canDo } = useMe()
  const canWrite = canDo("device", "change")
  const qc = useQueryClient()
  const [editing, setEditing] = useState<SnmpSensor | null>(null)
  const [adding, setAdding] = useState(false)
  const [exploring, setExploring] = useState(false)
  // A column picked in the explorer opens the form already carrying its OID
  // and the values it returned, so the value map is a few dropdowns rather
  // than transcription.
  const [prefill, setPrefill] = useState<SensorPrefill | null>(null)

  const sensors = useQuery({
    queryKey: ["snmp-sensors", deviceTypeId],
    queryFn: () =>
      api<Paginated<SnmpSensor>>(
        `/api/monitoring/snmp-sensors/${
          deviceTypeId ? `?device_type=${deviceTypeId}` : ""
        }`
      ),
  })
  // Last readings live on the device's SNMP state (shared cache).
  const snmp = useQuery({
    queryKey: ["device-snmp", deviceId],
    queryFn: () =>
      api<{ sensors: SensorReading[] }>(
        `/api/monitoring/devices/${deviceId}/snmp/`
      ),
  })
  const readings = snmp.data?.sensors ?? []

  const poll = useMutation({
    mutationFn: () =>
      api<{ readings: SensorReading[]; flipped: number; error: string }>(
        `/api/monitoring/devices/${deviceId}/sensor-poll/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      if (r.error) toast.error(r.error)
      else
        toast.success(
          `${r.readings.length} reading${r.readings.length === 1 ? "" : "s"}` +
            (r.flipped ? ` · ${r.flipped} status change` : "")
        )
      qc.invalidateQueries({ queryKey: ["device-snmp", deviceId] })
      qc.invalidateQueries({ queryKey: ["device-inventory", deviceId] })
      qc.invalidateQueries({ queryKey: ["device-face-ports", deviceId] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const rows = sensors.data?.results ?? []

  return (
    <Section
      title="Custom SNMP sensors"
      actions={
        canWrite ? (
          // Three buttons in a half-width card: wrap instead of overflowing.
          <div className="flex flex-wrap justify-end gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setExploring(true)}
            >
              <Search className="h-3.5 w-3.5" /> Explore OIDs
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Sensor
            </Button>
            {rows.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => poll.mutate()}
                disabled={poll.isPending}
              >
                <Activity className="h-3.5 w-3.5" />
                {poll.isPending ? "Polling…" : "Poll sensors"}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="grid gap-3 p-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sensors apply to this device. Define one — an OID plus a
            value→status map — to read hardware health over vendor SNMP.
          </p>
        ) : (
          <div className="grid gap-1">
            {rows.map((s) => (
              <div
                key={s.id}
                // Wraps rather than overflows: a vendor OID is one unbreakable
                // token, and this card sits half-width on the Monitoring tab.
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-[13px]"
              >
                <span className="font-medium">{s.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {s.oid}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground capitalize">
                  {s.item_kind}
                </span>
                {!s.device_type && (
                  <span className="text-[10px] text-muted-foreground">
                    all types
                  </span>
                )}
                {canWrite && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto h-6 w-6"
                    onClick={() => setEditing(s)}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {readings.length > 0 && (
          <div className="grid gap-1">
            <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
              Last readings
            </span>
            {readings.map((r, i) => (
              <div
                key={`${r.name}-${i}`}
                className="flex flex-wrap items-center gap-2 text-[12px]"
              >
                <span className="font-mono">{r.name}</span>
                <span className="text-muted-foreground">raw {r.raw}</span>
                {r.status && (
                  <span className="ml-auto text-muted-foreground capitalize">
                    → {r.status}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <OidExplorer
        deviceId={deviceId}
        open={exploring}
        onOpenChange={setExploring}
        onPickColumn={(oid, values) => {
          setPrefill({ oid, values })
          setExploring(false)
          setAdding(true)
        }}
      />

      <SensorDialog
        deviceTypeId={deviceTypeId}
        sensor={editing}
        prefill={editing ? null : prefill}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
            setPrefill(null)
          }
        }}
        onSaved={() => {
          setAdding(false)
          setEditing(null)
          setPrefill(null)
          qc.invalidateQueries({ queryKey: ["snmp-sensors"] })
        }}
      />
    </Section>
  )
}

/** A column chosen in the OID explorer: its OID, and the distinct values it
 * actually returned — the raw side of the value map, already filled in. */
export interface SensorPrefill {
  oid: string
  values: string[]
}

function SensorDialog({
  deviceTypeId,
  sensor,
  prefill,
  open,
  onOpenChange,
  onSaved,
}: {
  deviceTypeId?: string | null
  sensor: SnmpSensor | null
  /** Seed a new sensor from an explored column (ignored when editing). */
  prefill?: SensorPrefill | null
  open: boolean
  onOpenChange: (o: boolean) => void
  onSaved: () => void
}) {
  const editing = !!sensor
  const [name, setName] = useState("")
  const [oid, setOid] = useState("")
  const [walk, setWalk] = useState(true)
  const [kind, setKind] = useState<InventoryItemKind>("disk")
  const [nameTemplate, setNameTemplate] = useState("{kind} {index}")
  const [scopeThisType, setScopeThisType] = useState(true)
  const [rows, setRows] = useState<{ raw: string; slug: string }[]>([
    { raw: "", slug: "" },
  ])

  useEffect(() => {
    if (!open) return
    setName(sensor?.name ?? "")
    setOid(sensor?.oid ?? prefill?.oid ?? "")
    setWalk(sensor?.walk ?? true)
    setKind(sensor?.item_kind ?? "disk")
    setNameTemplate(sensor?.name_template ?? "{kind} {index}")
    setScopeThisType(sensor ? !!sensor.device_type : true)
    const vm = sensor?.value_map ?? {}
    const entries = Object.entries(vm).map(([raw, slug]) => ({ raw, slug }))
    if (entries.length) setRows(entries)
    else if (prefill?.values.length)
      // Every value the column returned, awaiting a status each.
      setRows(prefill.values.map((raw) => ({ raw, slug: "" })))
    else setRows([{ raw: "", slug: "" }])
  }, [open, sensor, prefill])

  const statuses = useQuery({
    queryKey: ["statuses", "inventoryitem"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=inventoryitem&picker=1"
      ),
    enabled: open,
    staleTime: 5 * 60_000,
  })
  const statusOptions = useMemo(
    () =>
      (statuses.data?.results ?? []).map((s) => ({
        value: s.slug,
        label: s.name,
      })),
    [statuses.data]
  )

  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => {
      const value_map: Record<string, string> = {}
      for (const r of rows)
        if (r.raw.trim() && r.slug) value_map[r.raw.trim()] = r.slug
      const payload = {
        name: name.trim(),
        oid: oid.trim(),
        walk,
        item_kind: kind,
        name_template: nameTemplate.trim() || "{kind} {index}",
        value_map,
        device_type: scopeThisType ? (deviceTypeId ?? null) : null,
      }
      const base = "/api/monitoring/snmp-sensors/"
      return editing
        ? api(`${base}${sensor!.id}/`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : api(base, { method: "POST", body: JSON.stringify(payload) })
    },
    onSuccess: () => {
      toast.success(editing ? "Sensor saved" : "Sensor created")
      onSaved()
    },
    onError: (e) => apiErrorToast(e),
  })

  const del = useMutation({
    mutationFn: () =>
      api<void>(`/api/monitoring/snmp-sensors/${sensor!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Sensor deleted")
      qc.invalidateQueries({ queryKey: ["snmp-sensors"] })
      onSaved()
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit sensor" : "Add SNMP sensor"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
          className="grid gap-4"
        >
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Disk health"
              autoFocus
              className="h-8 text-sm"
            />
          </Field>
          <Field
            label="OID"
            hint="numeric — a table column to walk, or a scalar"
          >
            <Input
              value={oid}
              onChange={(e) => setOid(e.target.value)}
              placeholder="1.3.6.1.4.1.…"
              className="h-8 font-mono text-[13px]"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <FormSelect
              label="Reading is"
              value={kind}
              onChange={(v) => v && setKind(v as InventoryItemKind)}
              options={INVENTORY_KIND_OPTIONS}
            />
            <FormSelect
              label="Mode"
              value={walk ? "walk" : "scalar"}
              onChange={(v) => setWalk(v === "walk")}
              options={[
                { value: "walk", label: "Walk (one per component)" },
                { value: "scalar", label: "Scalar (single value)" },
              ]}
            />
          </div>
          <Field
            label="Item name template"
            hint="{index} = walk index · {kind} = kind"
          >
            <Input
              value={nameTemplate}
              onChange={(e) => setNameTemplate(e.target.value)}
              placeholder="Disk {index}"
              className="h-8 font-mono text-[13px]"
            />
          </Field>

          <Field label="Value → status" hint="raw SNMP value maps to a status">
            <div className="grid gap-1.5">
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={r.raw}
                    onChange={(e) =>
                      setRows((cur) =>
                        cur.map((x, k) =>
                          k === i ? { ...x, raw: e.target.value } : x
                        )
                      )
                    }
                    placeholder="raw (e.g. 3)"
                    className="h-8 w-28 font-mono text-[13px]"
                  />
                  <span className="text-muted-foreground">→</span>
                  <div className="flex-1">
                    <FormSelect
                      label=""
                      value={r.slug || null}
                      onChange={(v) =>
                        setRows((cur) =>
                          cur.map((x, k) =>
                            k === i ? { ...x, slug: v ?? "" } : x
                          )
                        )
                      }
                      options={statusOptions}
                      placeholder="status…"
                    />
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() =>
                      setRows((cur) =>
                        cur.length === 1
                          ? [{ raw: "", slug: "" }]
                          : cur.filter((_, k) => k !== i)
                      )
                    }
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="justify-start"
                onClick={() =>
                  setRows((cur) => [...cur, { raw: "", slug: "" }])
                }
              >
                <Plus className="h-3 w-3" /> Add mapping
              </Button>
            </div>
          </Field>

          {deviceTypeId && (
            <FormCheckbox
              label="Only this device type"
              checked={scopeThisType}
              onChange={setScopeThisType}
              hint="uncheck to apply to all types"
            />
          )}

          <div className="flex items-center justify-between">
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => del.mutate()}
                disabled={del.isPending}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!name.trim() || !oid.trim() || save.isPending}
              >
                {save.isPending ? "Saving…" : editing ? "Save" : "Add sensor"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
