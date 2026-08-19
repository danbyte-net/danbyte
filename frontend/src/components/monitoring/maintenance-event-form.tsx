import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  MaintenanceEvent,
  MaintenanceEventKind,
  Paginated,
  ProviderOption,
  Status,
} from "@/lib/api"
import {
  Field,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { Input } from "@/components/ui/input"
import { useSaveObject } from "@/lib/save-object"

// ISO ↔ <input type="datetime-local"> - same helpers the silence form uses.
function toLocalInput(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  const off = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - off).toISOString().slice(0, 16)
}
function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null
}

export function MaintenanceEventForm({
  event,
  onSaved,
  onCancel,
}: {
  event?: MaintenanceEvent
  onSaved: () => void
  onCancel: () => void
}) {
  const isEdit = !!event
  const qc = useQueryClient()
  const saveObject = useSaveObject()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [kind, setKind] = useState<MaintenanceEventKind>(
    event?.kind ?? "maintenance"
  )
  const [statusId, setStatusId] = useState<string | null>(
    event?.status?.id ?? null
  )
  const [name, setName] = useState(event?.name ?? "")
  const [description, setDescription] = useState(event?.description ?? "")
  const [provider, setProvider] = useState<string | null>(
    event?.provider ?? null
  )
  const [externalRef, setExternalRef] = useState(event?.external_ref ?? "")
  const [startsAt, setStartsAt] = useState(
    toLocalInput(event?.starts_at ?? new Date().toISOString())
  )
  const [endsAt, setEndsAt] = useState(toLocalInput(event?.ends_at ?? null))
  const [etr, setEtr] = useState(toLocalInput(event?.etr ?? null))

  const providers = useQuery({
    queryKey: ["providers", "picker"],
    queryFn: () =>
      api<Paginated<ProviderOption>>("/api/providers/?page_size=200"),
  })

  // The user-editable /statuses catalog: both workflows (tentative → completed,
  // reported → resolved) are seeded rows, and anything the tenant added shows
  // up here too - Settings → Statuses, available to Maintenance & outage events.
  const statuses = useQuery({
    queryKey: ["statuses", "maintenanceevent"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=maintenanceevent&picker=1"
      ),
    staleTime: 5 * 60_000,
  })
  const statusRows = statuses.data?.results ?? []

  // Create: preselect the catalog default ("Tentative" on a stock install).
  useEffect(() => {
    if (isEdit || statusId || statusRows.length === 0) return
    const fallback =
      statusRows.find((s) => s.default_for.includes("maintenanceevent")) ??
      statusRows[0]
    setStatusId(fallback.id)
  }, [isEdit, statusId, statusRows])

  const save = useMutation({
    mutationFn: () => {
      reset()
      return saveObject<MaintenanceEvent>({
        objectType: "monitoring.maintenanceevent",
        endpoint: "/api/monitoring/maintenance-events/",
        id: event?.id,
        payload: {
          kind,
          status_id: statusId,
          name: name.trim(),
          description,
          provider,
          external_ref: externalRef.trim(),
          starts_at: fromLocalInput(startsAt),
          ends_at: fromLocalInput(endsAt),
          etr: kind === "outage" ? fromLocalInput(etr) : null,
        },
      })
    },
    onSuccess: () => {
      toast.success(isEdit ? `Updated ${name}` : `Created ${name}`)
      qc.invalidateQueries({ queryKey: ["maintenance-events"] })
      qc.invalidateQueries({ queryKey: ["planning-calendar"] })
      onSaved()
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormSelect
          label="Kind"
          value={kind}
          onChange={(v) => setKind(v as MaintenanceEventKind)}
          options={[
            { value: "maintenance", label: "Maintenance" },
            { value: "outage", label: "Outage" },
          ]}
          error={fieldErrors.kind}
        />
        <FormSelect
          label="Status"
          value={statusId}
          onChange={(v) => v && setStatusId(v)}
          options={statusRows.map((s) => ({ value: s.id, label: s.name }))}
          info="Rows from Settings → Statuses that are available to maintenance events - add your own there."
          error={fieldErrors.status_id}
        />
      </div>

      <FormText
        label="Name"
        value={name}
        onChange={setName}
        required
        placeholder="Fiber splice, span DK-31"
        error={fieldErrors.name}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormSelect
          label="Provider"
          value={provider}
          onChange={setProvider}
          noneLabel="None (internal work)"
          options={(providers.data?.results ?? []).map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          error={fieldErrors.provider}
        />
        <FormText
          label="Provider reference"
          value={externalRef}
          onChange={setExternalRef}
          placeholder="MAINT-77031"
          info="The provider's own ticket id - automated ingestion uses it to update instead of duplicate."
          error={fieldErrors.external_ref}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Starts" error={fieldErrors.starts_at}>
          <Input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            required
          />
        </Field>
        {kind === "maintenance" ? (
          <Field label="Ends" error={fieldErrors.ends_at}>
            <Input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              required
            />
          </Field>
        ) : (
          <Field
            label="ETR"
            error={fieldErrors.etr}
            info="Estimated time to restore. Leave empty while unknown; set Ends when the outage actually closes."
          >
            <Input
              type="datetime-local"
              value={etr}
              onChange={(e) => setEtr(e.target.value)}
            />
          </Field>
        )}
      </div>

      {kind === "outage" && (
        <Field label="Ended" error={fieldErrors.ends_at}>
          <Input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </Field>
      )}

      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        rows={3}
        error={fieldErrors.description}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save changes" : "Create event"}
      />
    </form>
  )
}
