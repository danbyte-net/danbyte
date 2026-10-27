import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { Undo2 } from "lucide-react"
import { toast } from "sonner"

import { api, ApiError } from "@/lib/api"
import type {
  Cable,
  CableWritePayload,
  Status,
  TagOption,
  Termination,
  TerminationInput,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import {
  Field,
  FormColor,
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
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { CableEndpointPicker } from "@/components/cable-endpoint-picker"
import { CableBulkPairs } from "@/components/cable-bulk-pairs"
import type { BulkPair } from "@/components/cable-bulk-pairs"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import { SimpleTable } from "@/components/ui/simple-table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useDcimChoices } from "@/lib/use-dcim-choices"
import { useSaveObject } from "@/lib/save-object"
import { invalidatePortCounts } from "@/lib/port-utilization"
import { apiErrorToast } from "@/lib/api-toast"
import { advanceEnd } from "@/lib/cable-runs"

const LENGTH_UNITS = [
  { value: "m", label: "m" },
  { value: "cm", label: "cm" },
  { value: "ft", label: "ft" },
  { value: "in", label: "in" },
]

export interface CableFormProps {
  cable?: Cable
  /** Pre-seeded A-side terminations (create only) - e.g. "Connect cable"
   * from an interface arrives with that port already on the A end. */
  initialA?: TerminationInput[]
  /** Pre-seeded B-side terminations (create only) - the 3D room's
   * pick-both-ends flow arrives with both ports already chosen. */
  initialB?: TerminationInput[]
  onSaved: (c: Cable) => void
  /** After "Many at once" creates its cables. Defaults to `onCancel`: the
   * caller is done either way, and there is no single cable to open. */
  onSavedMany?: (cables: Cable[]) => void
  onCancel: () => void
}

const toInputs = (terms: Cable["a_terminations"]): TerminationInput[] =>
  terms.map((t) => ({ kind: t.kind, id: t.id }))

const endName = (terms: Termination[]) =>
  terms.map((t) => `${t.device.name}:${t.name}`).join(", ")

/** Everything a new or removed cable makes stale. */
function invalidateCableCaches(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["cables"] })
  // The drawn run caches its own trace - without this, a colour or type
  // change only showed after a reload.
  qc.invalidateQueries({ queryKey: ["trace"] })
  qc.invalidateQueries({ queryKey: ["interfaces"] })
  // Singular keys are separate caches - the port DETAIL pages read
  // ["interface", id] / ["front-port", id] / ["rear-port", id], which
  // the plural keys never touch.
  qc.invalidateQueries({ queryKey: ["interface"] })
  qc.invalidateQueries({ queryKey: ["front-port"] })
  qc.invalidateQueries({ queryKey: ["rear-port"] })
  // This form's own port lists, so a port just cabled shows as taken when
  // the form stays open for the next cable.
  qc.invalidateQueries({ queryKey: ["cable-ports"] })
  qc.invalidateQueries({ queryKey: ["device-port-utilization"] })
  // The per-device faceplate/port caches - broad on purpose: a cable flips
  // `connected` on BOTH ends' markers (2D photo faceplate and 3D room),
  // and this form doesn't know which devices those ports live on.
  qc.invalidateQueries({ queryKey: ["device-face-ports"] })
  // Same reason, same breadth: cabling a port clears its mark_connected
  // flag and RELEASES any reservation on it, so the device tabs, the
  // reservation list and the utilization counts are all stale now.
  qc.invalidateQueries({ queryKey: ["device-interfaces"] })
  qc.invalidateQueries({ queryKey: ["device-rear-ports"] })
  qc.invalidateQueries({ queryKey: ["device-front-ports"] })
  qc.invalidateQueries({ queryKey: ["port-reservations"] })
  invalidatePortCounts(qc)
}

export function CableForm({
  cable,
  initialA,
  initialB,
  onSaved,
  onSavedMany,
  onCancel,
}: CableFormProps) {
  const isEdit = !!cable
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  const choices = useDcimChoices()

  const [a, setA] = useState<TerminationInput[]>(
    cable ? toInputs(cable.a_terminations) : (initialA ?? [])
  )
  const [b, setB] = useState<TerminationInput[]>(
    cable ? toInputs(cable.b_terminations) : (initialB ?? [])
  )
  const [label, setLabel] = useState(cable?.label ?? "")
  const [type, setType] = useState(cable?.type ?? "")
  const [statusId, setStatusId] = useState<string | null>(
    cable?.status?.id ?? null
  )
  const [length, setLength] = useState(cable?.length ?? "")
  const [lengthUnit, setLengthUnit] = useState(cable?.length_unit || "m")
  const [color, setColor] = useState(cable?.color ?? "")
  const [description, setDescription] = useState(cable?.description ?? "")
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    cable?.custom_fields ?? {}
  )
  const [tagIds, setTagIds] = useState<number[]>(
    cable?.tags.map((t) => t.id) ?? []
  )
  // "Many at once" (#454): two port lists, paired positionally.
  const [mode, setMode] = useState<"one" | "many">("one")
  const bulk = !isEdit && mode === "many"
  const [pairs, setPairs] = useState<BulkPair[]>([])
  const [pairErrors, setPairErrors] = useState<Record<string, unknown>[]>()
  // Cables made with "Save and add another" in this sitting, each undoable.
  const [added, setAdded] = useState<Cable[]>([])
  // Set by Ctrl/Cmd+Enter just before the footer submits the form.
  const againRef = useRef(false)

  useEffect(() => {
    if (!cable) return
    setA(toInputs(cable.a_terminations))
    setB(toInputs(cable.b_terminations))
    setLabel(cable.label)
    setType(cable.type)
    setStatusId(cable.status?.id ?? null)
    setLength(cable.length ?? "")
    setLengthUnit(cable.length_unit || "m")
    setColor(cable.color)
    setDescription(cable.description)
    setTagIds(cable.tags.map((t) => t.id))
    setCustomFields(cable.custom_fields ?? {})
    reset()
  }, [cable, reset])

  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => apiAll<TagOption>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "cable"],
    queryFn: () => apiAll<Status>("/api/statuses/?available_to=cable&picker=1"),
    staleTime: 5 * 60_000,
  })

  // A new cable defaults to the "Connected" status (or the first available),
  // so freshly-drawn cables aren't left statusless - a null status can't tint
  // the row or show a badge. Only seeds on create, never overrides an edit or
  // a status the user already picked.
  useEffect(() => {
    if (isEdit || statusId) return
    const opts = statuses.data?.results ?? []
    if (opts.length === 0) return
    const connected = opts.find((s) => s.name.toLowerCase() === "connected")
    setStatusId((connected ?? opts[0]).id)
  }, [isEdit, statusId, statuses.data])

  // What every cable made here carries, whichever way it is made.
  const shared = (): Omit<CableWritePayload, "a" | "b"> => ({
    type: type.trim(),
    status_id: statusId,
    length: length.trim() === "" ? null : length.trim(),
    length_unit: lengthUnit,
    color: color || "",
    description: description.trim(),
    tag_ids: tagIds,
    custom_fields: customFields,
  })

  const mutation = useMutation({
    // `again`: "Save and add another" - stay open on the next ports.
    mutationFn: async (again: boolean) => {
      void again
      const payload: CableWritePayload = {
        a,
        b,
        label: label.trim(),
        ...shared(),
      }
      return saveObject<Cable>({
        objectType: "api.cable",
        endpoint: "/api/cables/",
        id: isEdit ? cable!.id : undefined,
        payload,
      })
    },
    onSuccess: async (saved, again) => {
      qc.invalidateQueries({ queryKey: ["cable", saved.id] })
      invalidateCableCaches(qc)
      toast.success(isEdit ? "Cable updated" : "Cable created")
      if (!again) {
        onSaved(saved)
        return
      }
      // Keep both devices and the cable's attributes; move each end on to
      // its next free port so a run of ports is one keystroke per cable.
      setAdded((prev) => [...prev, saved])
      setLabel("")
      reset()
      const nextA = await advanceEnd(saved.a_terminations)
      const nextB = await advanceEnd(
        saved.b_terminations,
        new Set(nextA.map((t) => t.id))
      )
      setA(nextA)
      setB(nextB)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const bulkMutation = useMutation({
    mutationFn: () =>
      api<{ created: number; results: Cable[] }>("/api/cables/bulk-create/", {
        method: "POST",
        body: JSON.stringify({
          cables: pairs.map((p) => ({ a: [p.a], b: [p.b], ...shared() })),
        }),
      }),
    onSuccess: (res) => {
      invalidateCableCaches(qc)
      toast.success(
        `${res.created} ${res.created === 1 ? "cable" : "cables"} created`
      )
      if (onSavedMany) onSavedMany(res.results)
      else onCancel()
    },
    onError: (err) => {
      const body = err instanceof ApiError ? err.body : null
      const perPair =
        body && typeof body === "object" && "cables" in body
          ? body.cables
          : null
      if (Array.isArray(perPair)) {
        setPairErrors(perPair as Record<string, unknown>[])
        toast.error("Nothing was created - fix the marked pairs.")
        return
      }
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const undo = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/cables/${id}/`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      setAdded((prev) => prev.filter((c) => c.id !== id))
      invalidateCableCaches(qc)
      toast.success("Cable removed")
    },
    onError: (err) => apiErrorToast(err),
  })

  const canSubmit = bulk ? pairs.length > 0 : a.length > 0 && b.length > 0
  const pending = mutation.isPending || bulkMutation.isPending
  const manyLabel =
    pairs.length === 1 ? "Create 1 cable" : `Create ${pairs.length} cables`

  // Standard cable types; keep any legacy/custom value selectable.
  const cableTypeOptions = [...choices.cable_types]
  if (type && !cableTypeOptions.some((o) => o.value === type)) {
    cableTypeOptions.unshift({ value: type, label: type })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const again = againRef.current
        againRef.current = false
        if (!canSubmit || pending) return
        if (bulk) bulkMutation.mutate()
        else mutation.mutate(again)
      }}
      // Enter saves and closes; Ctrl/Cmd+Enter saves and adds another. The
      // footer turns Ctrl/Cmd+Enter into a submit; this only marks which.
      onKeyDownCapture={(e) => {
        if (e.key === "Enter")
          againRef.current = !isEdit && !bulk && (e.metaKey || e.ctrlKey)
      }}
      className="grid gap-4"
    >
      {!isEdit && (
        <SegmentedTabs
          value={mode}
          onValueChange={setMode}
          items={[
            { value: "one", label: "One cable" },
            { value: "many", label: "Many at once" },
          ]}
        />
      )}

      {/* The two ends side by side - a cable is two endpoints, and picking
          a port off the panel beats hunting a dropdown. Everything the cable
          itself carries (label, type, colour, length) sits below, spanning
          both, because it belongs to neither end. */}
      {bulk ? (
        <CableBulkPairs
          onPairsChange={(next) => {
            setPairs(next)
            setPairErrors(undefined)
          }}
          errors={pairErrors}
        />
      ) : (
        <FormColumns>
          <FormColumn>
            <FormSection title="A side" card>
              <CableEndpointPicker
                label="Ports"
                error={fieldErrors.a}
                value={a}
                onChange={setA}
                seedDeviceId={cable?.a_terminations?.[0]?.device?.id ?? null}
                hint="One or more ports - a breakout uses one here, several on B"
              />
            </FormSection>
          </FormColumn>
          <FormColumn>
            <FormSection title="B side" card>
              <CableEndpointPicker
                label="Ports"
                error={fieldErrors.b}
                value={b}
                onChange={setB}
                seedDeviceId={cable?.b_terminations?.[0]?.device?.id ?? null}
                hint={
                  a[0]?.kind === "circuit_termination"
                    ? "The port the circuit lands on"
                    : "The far end"
                }
              />
            </FormSection>
          </FormColumn>
        </FormColumns>
      )}

      <FormSection title="Cable" card>
        {/* A label names one cable, so it has no place on many. */}
        {!bulk && (
          <FormText
            label="Label"
            hint="What's printed on the cable's physical tag (optional)."
            value={label}
            onChange={setLabel}
            error={fieldErrors.label}
          />
        )}

        <div className="grid grid-cols-2 gap-3">
          <FormCombobox
            label="Type"
            value={type || null}
            onChange={(v) => setType(v ?? "")}
            noneLabel="No type"
            placeholder="Pick a type"
            searchPlaceholder="Search types…"
            emptyText="No types."
            options={cableTypeOptions}
            error={fieldErrors.type}
          />
          <FormCombobox
            label="Status"
            value={statusId}
            onChange={setStatusId}
            options={(statuses.data?.results ?? []).map((s) => ({
              value: s.id,
              label: s.name,
            }))}
            noneLabel="No status"
            placeholder="Select a status…"
            error={fieldErrors.status_id}
          />
        </div>
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <FormText
            label="Length"
            type="number"
            value={length}
            onChange={setLength}
            error={fieldErrors.length}
          />
          <FormSelect
            label="Unit"
            value={lengthUnit}
            onChange={(v) => v && setLengthUnit(v)}
            options={LENGTH_UNITS}
          />
        </div>
        <FormColor
          label="Color"
          hint="The physical cable's color"
          value={color}
          onChange={setColor}
          error={fieldErrors.color}
        />
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <Field label="Tags" error={fieldErrors.tag_ids}>
          <TagMultiSelect
            options={tags.data?.results ?? []}
            value={tagIds}
            onChange={setTagIds}
          />
        </Field>
      </FormSection>

      <CustomFieldInputs
        model="cable"
        value={customFields}
        onChange={setCustomFields}
      />

      {added.length > 0 && (
        <FormSection
          title={`${added.length} ${added.length === 1 ? "cable" : "cables"} added`}
          card
        >
          <SimpleTable
            data={added}
            getRowKey={(c) => c.id}
            columns={[
              {
                id: "a",
                header: "A side",
                cell: (c) => (
                  <span className="font-mono text-xs">
                    {endName(c.a_terminations)}
                  </span>
                ),
              },
              {
                id: "b",
                header: "B side",
                flex: true,
                cell: (c) => (
                  <span className="font-mono text-xs">
                    {endName(c.b_terminations)}
                  </span>
                ),
              },
              {
                id: "undo",
                header: "",
                align: "right",
                cell: (c) => (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        aria-label="Undo"
                        disabled={undo.isPending}
                        onClick={() => undo.mutate(c.id)}
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent variant="panel">
                      Undo - delete this cable
                    </TooltipContent>
                  </Tooltip>
                ),
              },
            ]}
          />
        </FormSection>
      )}

      {!canSubmit && (
        <p className="text-[11px] text-muted-foreground">
          {bulk
            ? "Tick ports on both sides to pair them."
            : "Add at least one port to each side."}
        </p>
      )}
      <FormFooter
        onCancel={onCancel}
        cancelLabel={added.length > 0 ? "Done" : "Cancel"}
        submitting={pending}
        submitLabel={
          isEdit ? "Save changes" : bulk ? manyLabel : "Create cable"
        }
        secondary={
          isEdit || bulk ? undefined : (
            <Button
              type="button"
              variant="outline"
              disabled={pending || !canSubmit}
              onClick={() => mutation.mutate(true)}
            >
              Save and add another
            </Button>
          )
        }
      />
    </form>
  )
}
