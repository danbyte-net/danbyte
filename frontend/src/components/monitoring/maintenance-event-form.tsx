import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { X } from "lucide-react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  MaintenanceEvent,
  MaintenanceEventKind,
  Paginated,
  ProviderOption,
  Status,
} from "@/lib/api"
import {
  Field,
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useSaveObject } from "@/lib/save-object"
import { LEVELS, levelTone } from "@/components/monitoring/impact-levels"

/** An impact a new event brings along on create - the derived list from a
 *  power or cooling source's Affected tab (#434). */
export interface InitialImpact {
  object_type: string
  object_id: string
  level: string
}

// Singular / plural per impacted object type, for the one-line summary. Feeds
// of either kind share a noun, so they add up.
const IMPACT_NOUNS: Record<string, [string, string]> = {
  coolingsource: ["cooling source", "cooling sources"],
  coolingfeed: ["feed", "feeds"],
  powerpanel: ["power panel", "power panels"],
  powerfeed: ["feed", "feeds"],
  rack: ["rack", "racks"],
  device: ["device", "devices"],
}

function countBy(items: string[]): [string, number][] {
  const out = new Map<string, number>()
  for (const k of items) out.set(k, (out.get(k) ?? 0) + 1)
  return [...out]
}

function nouns(objectType: string): [string, string] {
  const slug = objectType.split(".").pop() ?? objectType
  return IMPACT_NOUNS[slug] ?? [slug, slug]
}

/** "1 cooling source, 2 feeds, 2 racks, 14 devices". */
export function impactSummary(impacts: InitialImpact[]): string {
  return countBy(impacts.map((i) => nouns(i.object_type).join("|")))
    .map(([key, n]) => {
      const [one, many] = key.split("|")
      return `${n} ${n === 1 ? one : many}`
    })
    .join(", ")
}

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
  initialImpacts,
  initialName,
}: {
  event?: MaintenanceEvent
  onSaved: () => void
  onCancel: () => void
  /** Create only: impacts to add with the event, and a starting name. */
  initialImpacts?: InitialImpact[]
  initialName?: string
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
  const [name, setName] = useState(event?.name ?? initialName ?? "")
  // Edits never carry impacts - the event's own impact panel owns them then.
  const [impacts, setImpacts] = useState<InitialImpact[]>(
    isEdit ? [] : (initialImpacts ?? [])
  )
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
      apiAll<Status>("/api/statuses/?available_to=maintenanceevent&picker=1"),
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
          ...(!isEdit && impacts.length ? { impacts } : {}),
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
      className="@container grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="Event" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormSelect
                label="Kind"
                required
                value={kind}
                onChange={(v) => setKind(v as MaintenanceEventKind)}
                options={[
                  { value: "maintenance", label: "Maintenance" },
                  { value: "outage", label: "Outage" },
                ]}
                error={fieldErrors.kind}
              />
              {/* Statuses are catalog rows with a colour - the picker renders
                  each one as its ColorBadge, exactly as tables do. */}
              <FormCombobox
                label="Status"
                required
                value={statusId}
                onChange={(v) => v && setStatusId(v)}
                options={statusRows.map((s) => ({
                  value: s.id,
                  label: s.name,
                  color: s.color,
                }))}
                placeholder="Pick status"
                searchPlaceholder="Search statuses…"
                emptyText="No statuses."
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

            <FormTextarea
              label="Description"
              value={description}
              onChange={setDescription}
              rows={3}
              error={fieldErrors.description}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Schedule" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <Field label="Starts" required error={fieldErrors.starts_at}>
                <Input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  required
                />
              </Field>
              {kind === "maintenance" ? (
                <Field label="Ends" required error={fieldErrors.ends_at}>
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
          </FormSection>

          <FormSection title="Provider" card>
            <FormCombobox
              label="Provider"
              value={provider}
              onChange={setProvider}
              noneLabel="None (internal work)"
              options={(providers.data?.results ?? []).map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              error={fieldErrors.provider}
              searchPlaceholder="Search providers…"
              emptyText="No providers."
            />
            <FormText
              label="Provider reference"
              value={externalRef}
              onChange={setExternalRef}
              placeholder="MAINT-77031"
              info="The provider's own ticket id - automated ingestion uses it to update instead of duplicate."
              error={fieldErrors.external_ref}
            />
          </FormSection>

          {impacts.length > 0 && (
            <FormSection title="Impacts" card>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-[13px]" data-testid="impact-summary">
                    {impactSummary(impacts)}
                  </p>
                  <p className="text-[11px]">
                    {countBy(impacts.map((i) => i.level)).map(
                      ([level, n], idx) => (
                        <span key={level}>
                          {idx > 0 && (
                            <span className="text-muted-foreground"> · </span>
                          )}
                          <span className={levelTone[level] ?? ""}>
                            {n}{" "}
                            {(
                              LEVELS.find((l) => l.value === level)?.label ??
                              level
                            ).toLowerCase()}
                          </span>
                        </span>
                      )
                    )}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setImpacts([])}
                >
                  <X className="h-3.5 w-3.5" /> Drop
                </Button>
              </div>
            </FormSection>
          )}
        </FormColumn>
      </FormColumns>

      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save changes" : "Create event"}
      />
    </form>
  )
}
