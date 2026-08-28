import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Pencil, Trash2 } from "lucide-react"

import { api, type Antenna, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Section } from "@/components/ui/section"
import { QueryError } from "@/components/query-error"
import {
  Field,
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { useDcimChoices } from "@/lib/use-dcim-choices"
import { useMe } from "@/lib/use-me"
import { useRegisterAddActions } from "@/components/device-add-actions"
import { apiErrorToast } from "@/lib/api-toast"
import { PlanStaged, useSaveObject } from "@/lib/save-object"

/** A device's radiating elements (#111) - pure L1 inventory.
 *
 * An AP's integrated omnis live here as components; an external sector is its
 * own small device whose antenna describes the element and whose RF aux port
 * takes the coax. Nothing here is cable-able - the aux port is the cable end. */
export function DeviceAntennasPane({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canWrite = canDo("antenna", "change") || canDo("antenna", "add")
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Antenna | null | "new">(null)

  const q = useQuery({
    queryKey: ["device-antennas", deviceId],
    queryFn: () =>
      api<Paginated<Antenna>>(`/api/antennas/?device=${deviceId}`),
  })
  const rows = q.data?.results ?? []

  useRegisterAddActions(
    "antennas",
    canDo("antenna", "add")
      ? [{ label: "Antenna", onClick: () => setEditing("new") }]
      : []
  )

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/antennas/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device-antennas", deviceId] })
      toast.success("Antenna removed")
    },
    onError: (err) => apiErrorToast(err),
  })

  if (!q.isLoading && !q.isError && rows.length === 0) {
    return (
      <Section title="Antennas" count={0}>
        <p className="p-4 text-sm text-muted-foreground">
          No antennas. Integrated elements document here; an external antenna
          is its own device, cabled to an RF aux port.
        </p>
        {editing && (
          <AntennaDialog
            deviceId={deviceId}
            antenna={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
          />
        )}
      </Section>
    )
  }

  return (
    <Section title="Antennas" count={rows.length}>
      {q.isError ? (
        <QueryError error={q.error} />
      ) : q.isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Gain</TableHead>
                <TableHead>Bands</TableHead>
                <TableHead>Polarization</TableHead>
                <TableHead>Connector</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <AntennaRow
                  key={a.id}
                  antenna={a}
                  canWrite={canWrite}
                  onEdit={() => setEditing(a)}
                  onDelete={() => remove.mutate(a.id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editing && (
        <AntennaDialog
          deviceId={deviceId}
          antenna={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Section>
  )
}

function AntennaRow({
  antenna: a,
  canWrite,
  onEdit,
  onDelete,
}: {
  antenna: Antenna
  canWrite: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const choices = useDcimChoices()
  const label = (list: { value: string; label: string }[] | undefined, v: string) =>
    list?.find((o) => o.value === v)?.label ?? v
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{a.name}</TableCell>
      <TableCell className="text-xs">
        {a.antenna_type
          ? label(choices.antenna_types, a.antenna_type)
          : "-"}
      </TableCell>
      <TableCell className="num text-xs">
        {a.gain_dbi != null ? `${a.gain_dbi} dBi` : "-"}
      </TableCell>
      <TableCell>
        {a.bands.length ? (
          <span className="flex flex-wrap gap-1">
            {a.bands.map((b) => (
              <Badge key={b} variant="outline" className="text-[10px]">
                {label(choices.antenna_bands, b)}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {a.polarization
          ? label(choices.antenna_polarizations, a.polarization)
          : "-"}
      </TableCell>
      <TableCell className="text-xs">
        {a.direct_mount ? (
          <span className="flex items-center gap-1.5">
            {a.connector
              ? label(choices.rf_connector_types, a.connector)
              : "-"}
            <Badge variant="secondary" className="text-[10px]">
              direct mount
            </Badge>
          </span>
        ) : a.connector ? (
          label(choices.rf_connector_types, a.connector)
        ) : (
          "-"
        )}
      </TableCell>
      <TableCell className="text-right">
        {canWrite && (
          <span className="flex justify-end gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Edit antenna"
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              title="Delete antenna"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </span>
        )}
      </TableCell>
    </TableRow>
  )
}

/** Create/edit one antenna. Gain is numeric and bands are picked, never typed:
 * the point of structured fields is that a coverage calculator can read them. */
export function AntennaDialog({
  deviceId,
  antenna,
  onClose,
}: {
  deviceId: string
  antenna: Antenna | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const choices = useDcimChoices()
  const saveObject = useSaveObject()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const isEdit = !!antenna
  const [name, setName] = useState(antenna?.name ?? "")
  const [type, setType] = useState(antenna?.antenna_type ?? "")
  const [gain, setGain] = useState(
    antenna?.gain_dbi != null ? String(antenna.gain_dbi) : ""
  )
  const [bands, setBands] = useState<string[]>(antenna?.bands ?? [])
  const [polarization, setPolarization] = useState(antenna?.polarization ?? "")
  const [connector, setConnector] = useState(antenna?.connector ?? "")
  const [directMount, setDirectMount] = useState(antenna?.direct_mount ?? false)
  const [description, setDescription] = useState(antenna?.description ?? "")

  const save = useMutation({
    mutationFn: () => {
      reset()
      const payload = {
        device_id: deviceId,
        name: name.trim(),
        antenna_type: type,
        gain_dbi: gain.trim() === "" ? null : gain.trim(),
        bands,
        polarization,
        connector,
        direct_mount: directMount,
        description: description.trim(),
      }
      return saveObject<Antenna>({
        objectType: "api.antenna",
        endpoint: "/api/antennas/",
        id: isEdit ? antenna.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["device-antennas", deviceId] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Added ${saved.name}`)
      onClose()
    },
    onError: (err) => {
      if (err instanceof PlanStaged) return
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const toggleBand = (b: string) =>
    setBands((prev) =>
      prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]
    )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit antenna" : "Add antenna"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
          className="grid gap-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={setName}
              placeholder="ant0"
              error={fieldErrors.name}
            />
            <FormSelect
              label="Type"
              value={type || null}
              onChange={(v) => setType(v ?? "")}
              noneLabel="-"
              options={choices.antenna_types}
              error={fieldErrors.antenna_type}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormText
              label="Gain"
              hint="dBi"
              type="number"
              inputMode="decimal"
              value={gain}
              onChange={setGain}
              placeholder="5"
              error={fieldErrors.gain_dbi}
            />
            <FormSelect
              label="Polarization"
              value={polarization || null}
              onChange={(v) => setPolarization(v ?? "")}
              noneLabel="-"
              options={choices.antenna_polarizations}
              error={fieldErrors.polarization}
            />
          </div>
          <Field label="Bands" error={fieldErrors.bands}>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {choices.antenna_bands.map((b) => (
                <FormCheckbox
                  key={b.value}
                  label={b.label}
                  checked={bands.includes(b.value)}
                  onChange={() => toggleBand(b.value)}
                />
              ))}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormSelect
              label="Connector"
              hint="external elements"
              value={connector || null}
              onChange={(v) => setConnector(v ?? "")}
              noneLabel="None (internal)"
              options={choices.rf_connector_types}
              error={fieldErrors.connector}
            />
            <FormText
              label="Description"
              value={description}
              onChange={setDescription}
              error={fieldErrors.description}
            />
          </div>
          <FormCheckbox
            label="Direct mount"
            hint="screwed straight onto the device connector - no cable run"
            checked={directMount}
            onChange={setDirectMount}
          />
          <FormFooter
            onCancel={onClose}
            submitting={save.isPending}
            submitLabel={isEdit ? "Save changes" : "Add antenna"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
