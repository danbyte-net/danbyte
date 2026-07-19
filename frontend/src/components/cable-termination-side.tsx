import { useEffect, useMemo, useState } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"

import {
  api,
  type Paginated,
  type Termination,
  type TerminationInput,
  type TerminationKind,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { Field } from "@/components/forms/field"
import { FormSelect } from "@/components/forms/select"
import { DevicePicker } from "@/components/device-picker"

// Cable terminations Danbyte can pick device-side. (power_feed lives on a power
// panel, not a device, so it isn't offered by this device-first picker.)
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

const KIND_LABEL: Record<string, string> = {
  interface: "Interface",
  front_port: "Front port",
  rear_port: "Rear port",
  console_port: "Console port",
  console_server_port: "Console server port",
  power_port: "Power port",
  power_outlet: "Power outlet",
  aux_port: "Aux port",
}

const KIND_OPTIONS = Object.keys(KIND_ENDPOINT).map((k) => ({
  value: k,
  label: KIND_LABEL[k],
}))

const keyOf = (t: { kind: TerminationKind; id: string }) => `${t.kind}:${t.id}`

/** One port row from any of the device-port endpoints — they all serialise a
 * name plus the owning device. */
interface PortRow {
  id: string
  name: string
  device: { id: string; name: string }
}

export interface CableTerminationSideProps {
  label: string
  hint?: string
  error?: string
  value: TerminationInput[]
  onChange: (next: TerminationInput[]) => void
  /** Existing terminations (edit mode) — used to label the chips and to
   * pre-focus the picker on the first termination's device. */
  initialTerminations?: Termination[]
}

/**
 * One end (A or B) of a cable, NetBox-style: pick a **type**, pick a **device**
 * (via the shared DevicePicker + its advanced search), then tick one or more of
 * that device's **ports**. Selections accumulate as chips, so you can switch
 * device/type and keep adding — a side may span several devices (breakout).
 */
export function CableTerminationSide({
  label,
  hint,
  error,
  value,
  onChange,
  initialTerminations,
}: CableTerminationSideProps) {
  const [type, setType] = useState<TerminationKind>(
    initialTerminations?.[0]?.kind ?? "interface"
  )
  const [deviceId, setDeviceId] = useState<string | null>(
    initialTerminations?.[0]?.device.id ?? null
  )

  // key → human label ("device:port"). Grown as ports are ticked and seeded
  // from existing terminations, so chips read as names, never raw ids.
  const [labels, setLabels] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!initialTerminations?.length) return
    setLabels((prev) => {
      const next = { ...prev }
      for (const t of initialTerminations)
        next[keyOf(t)] = `${t.device.name}:${t.name}`
      return next
    })
  }, [initialTerminations])

  // Any selected termination we don't yet have a label for (e.g. an A-side port
  // pre-seeded by "Connect cable" from a device page) — fetch its detail so the
  // chip shows "device:port" instead of the raw uuid.
  const unlabeled = value.filter(
    (v) => !labels[keyOf(v)] && v.kind in KIND_ENDPOINT
  )
  const fetched = useQueries({
    queries: unlabeled.map((v) => ({
      queryKey: ["termination-label", v.kind, v.id],
      queryFn: () =>
        api<PortRow>(
          `/api/${KIND_ENDPOINT[v.kind as keyof typeof KIND_ENDPOINT]}/${v.id}/`
        ),
      staleTime: 5 * 60_000,
    })),
  })
  const labelFor = (v: TerminationInput): string => {
    const k = keyOf(v)
    if (labels[k]) return labels[k]
    const i = unlabeled.findIndex((u) => keyOf(u) === k)
    const d = i >= 0 ? fetched[i]?.data : undefined
    return d ? `${d.device.name}:${d.name}` : k
  }

  const ports = useQuery({
    queryKey: ["cable-ports", type, deviceId],
    queryFn: () =>
      api<Paginated<PortRow>>(
        `/api/${KIND_ENDPOINT[type as keyof typeof KIND_ENDPOINT]}/?device=${deviceId}&page_size=500`
      ),
    enabled: !!deviceId,
    staleTime: 60_000,
  })

  const selectedKeys = useMemo(() => new Set(value.map(keyOf)), [value])

  const toggle = (row: PortRow) => {
    const t: TerminationInput = { kind: type, id: row.id }
    const k = keyOf(t)
    if (selectedKeys.has(k)) {
      onChange(value.filter((v) => keyOf(v) !== k))
    } else {
      setLabels((prev) => ({
        ...prev,
        [k]: `${row.device.name}:${row.name}`,
      }))
      onChange([...value, t])
    }
  }

  const rows = ports.data?.results ?? []

  return (
    <Field label={label} hint={hint} error={error}>
      <div className="space-y-3 rounded-lg border border-border p-3">
        {/* Selected terminations — chips persist across device/type switches. */}
        {value.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {value.map((v) => {
              const k = keyOf(v)
              return (
                <span
                  key={k}
                  className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px]"
                >
                  <span className="font-mono">{labelFor(v)}</span>
                  <button
                    type="button"
                    onClick={() =>
                      onChange(value.filter((x) => keyOf(x) !== k))
                    }
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )
            })}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            No ports selected yet.
          </p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <FormSelect
            label="Type"
            value={type}
            onChange={(v) => v && setType(v as TerminationKind)}
            options={KIND_OPTIONS}
          />
          <DevicePicker
            label="Device"
            value={deviceId}
            onChange={setDeviceId}
            noneLabel="No device"
            placeholder="Pick a device"
          />
        </div>

        {/* Ports on the chosen device, of the chosen type. */}
        <Field
          label="Ports"
          hint="tick one or more · switch device above to add from another"
        >
          {!deviceId ? (
            <p className="text-[11px] text-muted-foreground">
              Pick a device to list its ports.
            </p>
          ) : ports.isLoading ? (
            <p className="text-[11px] text-muted-foreground">Loading ports…</p>
          ) : rows.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              This device has no {KIND_LABEL[type].toLowerCase()}s.
            </p>
          ) : (
            <div className="max-h-48 divide-y divide-border overflow-auto rounded-md border border-border">
              {rows.map((p) => {
                const checked = selectedKeys.has(
                  keyOf({ kind: type, id: p.id })
                )
                return (
                  <label
                    key={p.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[13px] hover:bg-muted/60",
                      checked && "bg-muted/40"
                    )}
                  >
                    <input
                      type="checkbox"
                      className="ck"
                      checked={checked}
                      onChange={() => toggle(p)}
                    />
                    <span className="font-mono">{p.name}</span>
                  </label>
                )
              })}
            </div>
          )}
        </Field>
      </div>
    </Field>
  )
}
