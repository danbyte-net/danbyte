import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Plus, Radar } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  PrtgAddSensorResult,
  PrtgAddableKind,
  PrtgDeviceTemplates,
  PrtgScanRow,
  PrtgSchemaField,
  PrtgSensorSchema,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCheckbox,
  FormCombobox,
  FormSelect,
  FormText,
} from "@/components/forms"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  INTERVAL_LABEL,
  KindParamFields,
  kindDefaults,
  usePrtgSensorKinds,
} from "./profiles"
import { SensorKindBrowser } from "./sensor-kind-picker"

// Adding a sensor to a linked PRTG device by hand (prtg/manual.py): pick one
// of the kinds PRTG offers, fill in its settings - Danbyte's own form for
// the kinds it knows, PRTG's schema for the rest - and, for a scanned kind
// (SNMP traffic), pick the rows PRTG's scan found. The server creates the
// sensor, re-reads the device and answers with the new rows.

/** The tag every sensor added by hand carries. */
export const MANUAL_TAG = "danbyte-manual"

/** The link a sensor is added to, as both surfaces know it. */
export interface AddTarget {
  linkId: string
  connectionId: string
  /** The PRTG device's name, for the dialog's title. */
  name: string
  writeMode?: "" | "v2" | "seed" | "none"
}

/** Whether this viewer can add sensors to the target. */
export function useCanAddSensors(target: AddTarget | null): boolean {
  const { canDo } = useMe()
  return (
    !!target &&
    canDo("prtgsensor", "change") &&
    (target.writeMode === "v2" || target.writeMode === "seed")
  )
}

function useRefreshSensors() {
  const qc = useQueryClient()
  return () => {
    for (const key of [
      "prtg-sensors",
      "prtg-sensor-summary",
      "prtg-links",
      "monitoring-bar",
    ])
      void qc.invalidateQueries({ queryKey: [key] })
  }
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Add sensor and Discover, side by side: on a device's or VM's Sensors tab,
 * and on the /prtg Sensors tab while one device is filtered. Hidden without
 * `change` on PRTG sensors or a connection that can create objects.
 */
export function AddSensorButtons({
  target,
  onAdded,
}: {
  target: AddTarget
  /** The PRTG object ids of the new sensors, to highlight their cards. */
  onAdded?: (objids: string[]) => void
}) {
  const can = useCanAddSensors(target)
  const [adding, setAdding] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  if (!can) return null
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        onClick={() => setAdding(true)}
      >
        <Plus className="h-3.5 w-3.5" />
        Add sensor
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        onClick={() => setDiscovering(true)}
      >
        <Radar className="h-3.5 w-3.5" />
        Discover
      </Button>
      {adding && (
        <AddSensorDialog
          target={target}
          onOpenChange={setAdding}
          onAdded={onAdded}
        />
      )}
      {discovering && (
        <DiscoverDialog target={target} onOpenChange={setDiscovering} />
      )}
    </>
  )
}

// ── the kinds ──────────────────────────────────────────────────────────

// ── PRTG's form ────────────────────────────────────────────────────────

function useSensorSchema(target: AddTarget, kind: PrtgAddableKind | null) {
  return useQuery({
    enabled: !!kind && kind.form === "generic",
    queryKey: ["prtg-sensor-schema", target.linkId, kind?.id],
    queryFn: () =>
      api<PrtgSensorSchema>(
        `/api/prtg/links/${target.linkId}/sensor-schema/?kind=${encodeURIComponent(kind!.id)}`
      ),
    staleTime: 10 * 60_000,
  })
}

function schemaDefaults(fields: PrtgSchemaField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) if (f.default != null) out[f.key] = f.default
  return out
}

/** PRTG's create form for a kind, as fields keyed `section.field`: the Add
 * sensor dialog and a profile's PRTG-only definitions share it. */
export function SchemaFields({
  fields,
  values,
  onChange,
}: {
  fields: PrtgSchemaField[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
}) {
  const sections = useMemo(() => {
    const out = new Map<string, PrtgSchemaField[]>()
    for (const f of fields) {
      const list = out.get(f.section_title) ?? []
      list.push(f)
      out.set(f.section_title, list)
    }
    return [...out.entries()]
  }, [fields])
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v })
  return (
    <div className="grid gap-4">
      {sections.map(([title, list]) => (
        <div key={title} className="grid gap-3">
          <p className="text-xs font-medium text-muted-foreground">{title}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {list.map((f) => {
              const value = values[f.key] ?? f.default
              if (f.type === "checkbox")
                return (
                  <FormCheckbox
                    key={f.key}
                    label={f.label}
                    info={f.help || undefined}
                    checked={!!value}
                    onChange={(v) => set(f.key, v)}
                  />
                )
              if (f.type === "select")
                return (
                  <FormSelect
                    key={f.key}
                    label={f.label}
                    info={f.help || undefined}
                    value={value == null ? null : String(value)}
                    onChange={(v) => set(f.key, v)}
                    options={f.options}
                  />
                )
              if (f.type === "multi") {
                const picked = Array.isArray(value) ? (value as string[]) : []
                return (
                  <div key={f.key} className="grid gap-1.5 sm:col-span-2">
                    <p className="text-sm font-medium">{f.label}</p>
                    {f.options.map((o) => (
                      <FormCheckbox
                        key={o.value}
                        label={o.label}
                        checked={picked.includes(o.value)}
                        onChange={(on) =>
                          set(
                            f.key,
                            on
                              ? [...picked, o.value]
                              : picked.filter((p) => p !== o.value)
                          )
                        }
                      />
                    ))}
                  </div>
                )
              }
              return (
                <FormText
                  key={f.key}
                  label={f.label}
                  info={f.help || undefined}
                  type={
                    f.type === "number"
                      ? "number"
                      : f.type === "password"
                        ? "password"
                        : "text"
                  }
                  min={f.minimum ?? undefined}
                  max={f.maximum ?? undefined}
                  value={value == null ? "" : String(value)}
                  onChange={(v) =>
                    set(
                      f.key,
                      f.type === "number" ? (v === "" ? null : Number(v)) : v
                    )
                  }
                />
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── the scan ───────────────────────────────────────────────────────────

function ScanPicker({
  rows,
  picked,
  onChange,
}: {
  rows: PrtgScanRow[]
  picked: string[]
  onChange: (picked: string[]) => void
}) {
  const connected = rows.filter((r) => r.connected).map((r) => r.value)
  if (rows.length === 0)
    return <EmptyState title="PRTG's scan found nothing to monitor." />
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() =>
            onChange(
              picked.length === rows.length ? [] : rows.map((r) => r.value)
            )
          }
        >
          {picked.length === rows.length ? "Select none" : "Select all"}
        </Button>
        {connected.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => onChange(connected)}
          >
            Connected only
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {picked.length} of {rows.length}
        </span>
      </div>
      <div
        className="max-h-[45vh] overflow-y-auto rounded-md border border-border"
        data-testid="prtg-scan-rows"
      >
        {rows.map((r) => (
          <label
            key={r.value}
            className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-1.5 text-sm last:border-b-0 hover:bg-muted/50"
          >
            <Checkbox
              checked={picked.includes(r.value)}
              onCheckedChange={(on) =>
                onChange(
                  on
                    ? [...picked, r.value]
                    : picked.filter((p) => p !== r.value)
                )
              }
            />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            {r.status && (
              <span className="text-xs whitespace-nowrap text-muted-foreground">
                {r.status}
              </span>
            )}
          </label>
        ))}
      </div>
    </div>
  )
}

// ── the dialog ─────────────────────────────────────────────────────────

type Step = "pick" | "form" | "scan"

export function AddSensorDialog({
  target,
  onOpenChange,
  onAdded,
}: {
  target: AddTarget
  onOpenChange: (open: boolean) => void
  onAdded?: (objids: string[]) => void
}) {
  const refresh = useRefreshSensors()
  const danbyteKinds = usePrtgSensorKinds()
  const [step, setStep] = useState<Step>("pick")
  const [kind, setKind] = useState<PrtgAddableKind | null>(null)
  const [requestId, setRequestId] = useState(newRequestId)
  const [name, setName] = useState("")
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [interval, setIntervalSeconds] = useState<number | null>(null)
  const [tags, setTags] = useState("")
  const [scanRows, setScanRows] = useState<PrtgScanRow[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const schema = useSensorSchema(target, kind)
  const spec = kind?.danbyte_kind
    ? (danbyteKinds.data?.kinds ?? []).find(
        (k) => k.value === kind.danbyte_kind
      )
    : undefined
  const generic = kind?.form === "generic"
  const genericValues =
    generic && schema.data
      ? { ...schemaDefaults(schema.data.fields), ...params }
      : params

  const pick = (k: PrtgAddableKind) => {
    const s = (danbyteKinds.data?.kinds ?? []).find(
      (d) => d.value === k.danbyte_kind
    )
    setKind(k)
    setParams(s ? kindDefaults(s) : {})
    setName("")
    setPicked([])
    setScanRows([])
    // A new kind is a new request: a retry of this one finds what it made.
    setRequestId(newRequestId())
    setStep("form")
  }

  const scan = useMutation({
    mutationFn: () =>
      api<{ kind: string; rows: PrtgScanRow[] }>(
        `/api/prtg/links/${target.linkId}/scan/`,
        {
          method: "POST",
          body: JSON.stringify({ kind: kind?.danbyte_kind ?? kind?.id }),
        }
      ),
    onSuccess: (data) => {
      setScanRows(data.rows)
      setPicked(data.rows.filter((r) => r.connected).map((r) => r.value))
      setStep("scan")
    },
    onError: (e) => apiErrorToast(e, "PRTG's scan failed"),
  })

  const save = useMutation({
    mutationFn: () => {
      const rows = scanRows.filter((r) => picked.includes(r.value))
      return api<PrtgAddSensorResult>(
        `/api/prtg/links/${target.linkId}/sensors/`,
        {
          method: "POST",
          body: JSON.stringify({
            kind: kind?.danbyte_kind ?? kind?.id,
            kind_label: kind?.name,
            name: name.trim(),
            params: generic ? genericValues : params,
            interval_seconds: interval,
            tags: tags.split(/\s+/).filter(Boolean),
            interfaces: rows.map((r) => ({ value: r.value, name: r.name })),
            request_id: requestId,
          }),
        }
      )
    },
    onSuccess: (res) => {
      if (res.failed.length)
        toast.warning(`${res.detail}`, { duration: 10_000 })
      else toast.success(res.detail)
      onAdded?.(res.objids)
      refresh()
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e, "PRTG did not add the sensor"),
  })

  const intervals = danbyteKinds.data?.intervals ?? []
  const needsScan = !!kind?.scan && step === "form"
  const busy = save.isPending || scan.isPending

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="2xl" data-testid="prtg-add-sensor-dialog">
        <DialogHeader>
          <DialogTitle>
            {step === "pick" ? "Add sensor" : (kind?.name ?? "Add sensor")}
          </DialogTitle>
          <DialogDescription>
            {step === "pick"
              ? `On ${target.name} in PRTG.`
              : step === "scan"
                ? "Pick what to monitor; each becomes one sensor."
                : kind?.description || `On ${target.name} in PRTG.`}
          </DialogDescription>
        </DialogHeader>

        {step === "pick" && (
          <SensorKindBrowser
            connectionId={target.connectionId}
            linkId={target.linkId}
            mode="add"
            onPick={(o) => o.prtg && pick(o.prtg)}
          />
        )}

        {step === "form" && kind && (
          <form
            id="prtg-add-sensor-form"
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (needsScan) scan.mutate()
              else save.mutate()
            }}
          >
            <FormText
              label="Name"
              hint={spec?.default_name || kind.name}
              value={name}
              onChange={setName}
            />
            {spec && (
              <KindParamFields
                kind={spec}
                params={params}
                onChange={setParams}
                skip={kind.scan ? ["interface", "connected_only"] : undefined}
              />
            )}
            {generic &&
              (schema.isLoading ? (
                <Loading />
              ) : schema.isError ? (
                <QueryError error={schema.error} />
              ) : (
                <SchemaFields
                  fields={schema.data?.fields ?? []}
                  values={genericValues}
                  onChange={setParams}
                />
              ))}
            <div className="grid gap-3 sm:grid-cols-2">
              <FormSelect
                label="Interval"
                value={interval == null ? null : String(interval)}
                onChange={(v) => setIntervalSeconds(v ? Number(v) : null)}
                options={intervals.map((s) => ({
                  value: String(s),
                  label: INTERVAL_LABEL(s),
                }))}
                noneLabel="Inherit"
              />
              <FormText
                label="Tags"
                info="Added to the PRTG sensor, space-separated. The object's own tags follow when the connection sends tags."
                value={tags}
                onChange={setTags}
              />
            </div>
          </form>
        )}

        {step === "scan" && (
          <ScanPicker rows={scanRows} picked={picked} onChange={setPicked} />
        )}

        {step !== "pick" && (
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              disabled={busy}
              onClick={() => setStep(step === "scan" ? "form" : "pick")}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {step === "form" ? (
              <Button
                type="submit"
                form="prtg-add-sensor-form"
                disabled={busy || (generic && !schema.data)}
              >
                {needsScan
                  ? scan.isPending
                    ? "Scanning…"
                    : "Scan device"
                  : save.isPending
                    ? "Adding…"
                    : "Add sensor"}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={busy || picked.length === 0}
                onClick={() => save.mutate()}
              >
                {save.isPending
                  ? "Adding…"
                  : picked.length === 1
                    ? "Add 1 sensor"
                    : `Add ${picked.length} sensors`}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── discovery ──────────────────────────────────────────────────────────

export function DiscoverDialog({
  target,
  onOpenChange,
}: {
  target: AddTarget
  onOpenChange: (open: boolean) => void
}) {
  const [template, setTemplate] = useState("")
  const templates = useQuery({
    queryKey: ["prtg-device-templates", target.connectionId],
    queryFn: () =>
      api<PrtgDeviceTemplates>(
        `/api/prtg/connections/${target.connectionId}/device-templates/`
      ),
    staleTime: 10 * 60_000,
  })
  const run = useMutation({
    mutationFn: () =>
      api<{ detail: string }>(`/api/prtg/links/${target.linkId}/discover/`, {
        method: "POST",
        body: JSON.stringify({ template: template.trim() }),
      }),
    onSuccess: (res) => {
      toast.success(res.detail)
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e, "PRTG did not start the discovery"),
  })
  const names = (templates.data?.templates ?? []).map((t) => t.file_name)
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="lg" data-testid="prtg-discover-dialog">
        <DialogHeader>
          <DialogTitle>Discover sensors</DialogTitle>
          <DialogDescription>
            PRTG scans {target.name}; what it adds shows here after the next
            status read.
          </DialogDescription>
        </DialogHeader>
        <form
          id="prtg-discover-form"
          onSubmit={(e) => {
            e.preventDefault()
            run.mutate()
          }}
        >
          <FormCombobox
            label="Device template"
            value={template}
            onChange={(v) => setTemplate(v ?? "")}
            options={[...names]
              .sort((a, b) => a.localeCompare(b))
              .map((n) => ({ value: n, label: n }))}
            noneLabel="The device's own"
            searchPlaceholder="Search templates…"
            emptyText="No templates read from PRTG yet."
          />
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="prtg-discover-form"
            disabled={run.isPending}
          >
            {run.isPending ? "Starting…" : "Discover"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
