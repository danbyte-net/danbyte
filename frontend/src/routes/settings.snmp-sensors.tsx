import { useMemo, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Copy, Download, Pencil, Trash2, Upload } from "lucide-react"

import { api, type Paginated, type SnmpSensor } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCheckbox } from "@/components/forms"
import { SensorDialog } from "@/components/device-sensors-card"
import { ComponentDeleteDialog } from "@/components/component-delete-dialog"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/settings/snmp-sensors")({
  component: SnmpSensorCatalogPage,
})

interface SensorPack {
  danbyte_snmp_sensor_pack: number
  count: number
  sensors: Record<string, unknown>[]
}

interface ImportResult {
  created: number
  updated: number
  skipped: number
  unbound_device_types: string[]
  errors: { index: number; name?: string; error: unknown }[]
}

/**
 * The sensor catalog — every custom SNMP sensor in the tenant, in one place.
 *
 * Sensors are per-vendor OID archaeology: once someone works out that a Lenovo
 * chassis reports drive health at `1.3.6.1.4.1.2.3.51.3.1.12.2.1.3`, that
 * knowledge should be reusable rather than rediscovered. So the catalog exports
 * to a JSON pack and imports one back — between device types, between tenants,
 * between deployments, or pasted from someone else's notes.
 */
function SnmpSensorCatalogPage() {
  const { canManage, isLoading: meLoading } = useMe()
  const qc = useQueryClient()
  const [q, setQ] = useState("")
  const [editing, setEditing] = useState<SnmpSensor | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<SnmpSensor | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const list = useQuery({
    queryKey: ["snmp-sensors", "catalog"],
    queryFn: () =>
      api<Paginated<SnmpSensor>>("/api/monitoring/snmp-sensors/?page_size=200"),
  })
  const sensors = list.data?.results ?? []
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return sensors
    return sensors.filter((s) =>
      [s.name, s.oid, s.item_kind, s.device_type_name ?? "all types"]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    )
  }, [sensors, q])

  const duplicate = useMutation({
    mutationFn: (s: SnmpSensor) =>
      api<SnmpSensor>("/api/monitoring/snmp-sensors/", {
        method: "POST",
        body: JSON.stringify({
          name: `${s.name} copy`,
          description: s.description,
          device_type: s.device_type,
          oid: s.oid,
          walk: s.walk,
          item_kind: s.item_kind,
          name_template: s.name_template,
          value_map: s.value_map,
          absent_status: s.absent_status,
          apply_mode: s.apply_mode,
          enabled: false, // a copy starts off until you've retargeted it
        }),
      }),
    onSuccess: (row) => {
      toast.success("Sensor duplicated — disabled until you review it")
      qc.invalidateQueries({ queryKey: ["snmp-sensors"] })
      setEditing(row)
    },
    onError: (e) => apiErrorToast(e),
  })

  // Download rather than show: a pack is a file you keep, and the browser's
  // save dialog is the right place to name it.
  const exportPack = async () => {
    try {
      const pack = await api<SensorPack>("/api/monitoring/snmp-sensors/export/")
      const blob = new Blob([JSON.stringify(pack, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "danbyte-snmp-sensors.json"
      a.click()
      URL.revokeObjectURL(url)
      toast.success(
        `Exported ${pack.count} sensor${pack.count === 1 ? "" : "s"}`
      )
    } catch (e) {
      apiErrorToast(e)
    }
  }

  if (meLoading) return null
  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">Tenant admin required.</p>
    )

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-sm font-semibold">SNMP sensors</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Every custom health sensor in this tenant. A sensor maps a vendor OID
          to an inventory item's status — SNMP has no standard disk/PSU/fan
          health MIB, so this is the escape hatch. Bind one to a device type and
          every device of that model inherits it. Sensors carry no credentials,
          which is what makes a pack safe to share.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, OID, kind, device type…"
          className="h-8 max-w-xs"
        />
        <span className="text-[11px] text-muted-foreground">
          {filtered.length} of {sensors.length}
        </span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setImportOpen(true)}
          >
            <Upload className="h-3.5 w-3.5" /> Import pack
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={exportPack}
            disabled={sensors.length === 0}
          >
            <Download className="h-3.5 w-3.5" /> Export pack
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Add sensor
          </Button>
        </div>
      </div>

      <section className="rounded-lg border border-border bg-card">
        {list.isError && (
          <div className="p-4">
            <QueryError error={list.error} />
          </div>
        )}
        {list.isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {sensors.length === 0
              ? "No sensors yet. Add one here, or explore a device's OIDs from its Monitoring tab and build the sensor from what you find."
              : "Nothing matches that search."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
              >
                <span className="font-medium">{s.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {s.oid}
                </span>
                <Badge variant="secondary" className="capitalize">
                  {s.item_kind}
                </Badge>
                {s.walk ? (
                  <span className="text-[10px] text-muted-foreground">
                    walk
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground">
                    scalar
                  </span>
                )}
                {/* Which model it applies to is the thing you scan this list
                    for, so it reads as a link, not a footnote. */}
                {s.device_type ? (
                  <Link
                    to="/device-types/$id"
                    params={{ id: s.device_type }}
                    search={{ tab: "sensors" }}
                    className="text-[11px] text-primary hover:underline"
                  >
                    {s.device_type_name}
                  </Link>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    all device types
                  </span>
                )}
                {s.apply_mode === "auto" && (
                  <Badge variant="outline" className="text-[10px]">
                    auto-applies
                  </Badge>
                )}
                {!s.enabled && (
                  <Badge variant="outline" className="text-[10px]">
                    disabled
                  </Badge>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Duplicate — same OID, new name/binding"
                    onClick={() => duplicate.mutate(s)}
                    disabled={duplicate.isPending}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setEditing(s)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setDeleting(s)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Passing the sensor's own binding as `deviceTypeId` means the dialog's
          "this device type only" tick keeps it, and clearing it widens the
          sensor to all types. */}
      <SensorDialog
        deviceTypeId={editing?.device_type ?? null}
        sensor={editing}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
        onSaved={() => {
          setAdding(false)
          setEditing(null)
          qc.invalidateQueries({ queryKey: ["snmp-sensors"] })
        }}
      />

      <ComponentDeleteDialog
        endpoint="monitoring/snmp-sensors"
        queryKeys={[["snmp-sensors"]]}
        // The shared dialog also renders a cabled-port warning; a sensor has no
        // cable, so it's explicitly null rather than absent.
        item={
          deleting
            ? { id: deleting.id, name: deleting.name, cable: null }
            : null
        }
        warning="Devices keep the statuses this sensor last wrote; nothing is re-read until another sensor covers them."
        onOpenChange={(o) => !o && setDeleting(null)}
      />

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onDone={() => qc.invalidateQueries({ queryKey: ["snmp-sensors"] })}
      />
    </div>
  )
}

/** Paste or upload a pack. Skips slugs that already exist unless you ask for a
 * replace — an import shouldn't quietly rewrite a sensor somebody tuned. */
function ImportDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onDone: () => void
}) {
  const [text, setText] = useState("")
  const [replace, setReplace] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const run = useMutation({
    mutationFn: () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error("That isn't valid JSON.")
      }
      return api<ImportResult>(
        `/api/monitoring/snmp-sensors/import/${replace ? "?replace=1" : ""}`,
        { method: "POST", body: JSON.stringify(parsed) }
      )
    },
    onSuccess: (r) => {
      setResult(r)
      const parts = [
        r.created ? `${r.created} added` : "",
        r.updated ? `${r.updated} updated` : "",
        r.skipped ? `${r.skipped} skipped` : "",
      ].filter(Boolean)
      toast.success(parts.join(" · ") || "Nothing to do")
      onDone()
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setText("")
          setResult(null)
          setReplace(false)
        }
        onOpenChange(o)
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Import a sensor pack</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Paste a pack exported from Danbyte, or upload the file. Device types
          are matched by <span className="font-medium">name</span>; a sensor
          naming a type you don't have is still imported, just unbound.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            void f.text().then(setText)
          }}
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" /> Choose file…
          </Button>
          <FormCheckbox
            label="Overwrite sensors that already exist"
            checked={replace}
            onChange={setReplace}
          />
        </div>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder='{"danbyte_snmp_sensor_pack": 1, "sensors": [ … ]}'
          className="font-mono text-[11px]"
        />
        {result && (
          <div className="grid gap-1 rounded-md border border-border bg-muted/30 p-2 text-[11px]">
            <span>
              {result.created} added · {result.updated} updated ·{" "}
              {result.skipped} skipped
            </span>
            {result.unbound_device_types.length > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                No device type here named:{" "}
                {result.unbound_device_types.join(", ")} — those sensors apply
                to all types until you bind them.
              </span>
            )}
            {result.errors.map((e, i) => (
              <span key={i} className="text-destructive">
                {e.name ?? `#${e.index}`}: {JSON.stringify(e.error)}
              </span>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={() => run.mutate()}
            disabled={!text.trim() || run.isPending}
          >
            {run.isPending ? "Importing…" : "Import"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
