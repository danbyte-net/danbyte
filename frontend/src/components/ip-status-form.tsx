import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { MONITORING_STATES, STATUSABLE_MODELS } from "@/lib/api"
import type { CheckStatus, Status, StatusWritePayload } from "@/lib/api"
import {
  Field,
  FormCheckbox,
  FormColor,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"
import {
  STATUS_COLOR,
  STATUS_LABEL,
  STATUS_TEXT,
} from "@/components/monitoring/charts"

/** A check state in its shipped colour. Not CheckStatusBadge: this form is
 * what lets a tenant rename a state, and the picker must keep showing the
 * shipped names while that is being decided. */
function ShippedStatePill({ state }: { state: CheckStatus }) {
  return (
    <span
      className="inline-flex h-5 items-center rounded-[5px] px-2 text-xs font-medium ring-1 ring-black/10 ring-inset dark:ring-white/10"
      style={{ backgroundColor: STATUS_COLOR[state], color: STATUS_TEXT[state] }}
    >
      {STATUS_LABEL[state]}
    </span>
  )
}

export interface IpStatusFormProps {
  status?: Status
  onSaved: (s: Status) => void
  onCancel: () => void
}

export function IpStatusForm({ status, onSaved, onCancel }: IpStatusFormProps) {
  const isEdit = !!status
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(status?.name ?? "")
  const [color, setColor] = useState(status?.color ?? "")
  const [description, setDescription] = useState(status?.description ?? "")
  const [weight, setWeight] = useState(status ? String(status.weight) : "100")
  const [availableTo, setAvailableTo] = useState<string[]>(
    status?.available_to ?? []
  )
  const [defaultFor, setDefaultFor] = useState<string[]>(
    status?.default_for ?? []
  )
  const [isAvailable, setIsAvailable] = useState(status?.is_available ?? false)
  const [requiresNote, setRequiresNote] = useState(
    status?.requires_note ?? false
  )
  const [suppressesAlerts, setSuppressesAlerts] = useState(
    status?.suppresses_alerts ?? false
  )
  const [isClosed, setIsClosed] = useState(status?.is_closed ?? false)
  const [monitoringState, setMonitoringState] = useState(
    status?.monitoring_state ?? ""
  )

  useEffect(() => {
    if (!status) return
    setName(status.name)
    setColor(status.color)
    setDescription(status.description)
    setWeight(String(status.weight))
    setAvailableTo(status.available_to)
    setDefaultFor(status.default_for)
    setIsAvailable(status.is_available)
    setRequiresNote(status.requires_note)
    setSuppressesAlerts(status.suppresses_alerts)
    setIsClosed(status.is_closed)
    setMonitoringState(status.monitoring_state)
    reset()
  }, [status, reset])

  const toggleAvailable = (m: string) =>
    setAvailableTo((prev) => {
      if (prev.includes(m)) {
        // Dropping availability also drops it as a default for that type.
        setDefaultFor((d) => d.filter((x) => x !== m))
        return prev.filter((x) => x !== m)
      }
      return [...prev, m]
    })

  const toggleDefault = (m: string) =>
    setDefaultFor((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    )

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: StatusWritePayload = {
        name: name.trim(),
        color: color || "",
        description: description.trim(),
        weight: weight.trim() === "" ? 100 : Number(weight),
        available_to: availableTo,
        default_for: defaultFor,
        is_available: isAvailable,
        requires_note: requiresNote,
        suppresses_alerts: suppressesAlerts,
        is_closed: isClosed,
        monitoring_state: monitoringState,
      }
      return saveObject<Status>({
        objectType: "api.status",
        endpoint: "/api/statuses/",
        id: isEdit ? status!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["statuses"] })
      qc.invalidateQueries({ queryKey: ["statuses-picker"] })
      qc.invalidateQueries({ queryKey: ["ip-status", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Status" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            placeholder="Reserved"
            error={fieldErrors.name}
          />
          <FormColor
            label="Color"
            value={color}
            onChange={setColor}
            error={fieldErrors.color}
          />
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormText
          label="Weight"
          type="number"
          value={weight}
          onChange={setWeight}
          hint="Lower sorts first"
          error={fieldErrors.weight}
        />
      </FormSection>

      <FormSection title="Object types" card>
        <Field
          label="Available to"
          hint="Which object types can carry this status"
          error={fieldErrors.available_to}
        >
          <div className="grid gap-x-4 gap-y-1.5 @md:grid-cols-2">
            {STATUSABLE_MODELS.map((m) => (
              <FormCheckbox
                key={m.value}
                label={m.label}
                checked={availableTo.includes(m.value)}
                onChange={() => toggleAvailable(m.value)}
              />
            ))}
          </div>
        </Field>
        <Field
          label="Default for"
          hint="for new objects with no status picked"
          info="Only types the status is available to can be defaulted. At most one default per type."
          error={fieldErrors.default_for}
        >
          <div className="grid gap-x-4 gap-y-1.5 @md:grid-cols-2">
            {STATUSABLE_MODELS.map((m) => {
              const allowed = availableTo.includes(m.value)
              return (
                <FormCheckbox
                  key={m.value}
                  label={m.label}
                  disabled={!allowed}
                  checked={allowed && defaultFor.includes(m.value)}
                  onChange={() => allowed && toggleDefault(m.value)}
                />
              )
            })}
          </div>
        </Field>
      </FormSection>

      <FormSection title="Monitoring" card>
        <FormCheckbox
          label="Speaks for a check state"
          hint="renames and recolours it"
          checked={!!monitoringState}
          // Ticking lands on Down: the state an estate most often wants in its
          // own words is the bad one.
          onChange={(on) => setMonitoringState(on ? "down" : "")}
        />
        {!!monitoringState && (
          <FormSelect
            label="Check state"
            info="One status per state. It replaces the state's shipped name and colour everywhere monitoring is shown."
            value={monitoringState}
            onChange={(v) => setMonitoringState(v ?? "")}
            options={MONITORING_STATES.map((m) => ({
              value: m.value,
              label: <ShippedStatePill state={m.value} />,
            }))}
            error={fieldErrors.monitoring_state}
          />
        )}
      </FormSection>

      <FormSection title="Behaviour" card>
        <FormCheckbox
          label="Counts as available"
          hint="Treated as 'free' in utilisation maths"
          checked={isAvailable}
          onChange={setIsAvailable}
        />
        <FormCheckbox
          label="Requires a note"
          hint="Forces a reservation note on the IP form"
          checked={requiresNote}
          onChange={setRequiresNote}
        />
        <FormCheckbox
          label="Suppresses alerts"
          hint="for maintenance and outage events"
          checked={suppressesAlerts}
          onChange={setSuppressesAlerts}
        />
        <FormCheckbox
          label="Closes the event"
          hint="ends the event and its silence"
          checked={isClosed}
          onChange={setIsClosed}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create status"}
      />
    </form>
  )
}
