import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  CoolingFeed,
  CoolingFeedType,
  CoolingFeedWritePayload,
  CoolingSource,
  CoolingSourceOption,
  Paginated,
  RackOption,
  Status,
} from "@/lib/api"
import { useDcimChoices } from "@/lib/use-dcim-choices"
import { kwToWatts, wattsToKw } from "@/lib/rack-capacity"
import {
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormStatusSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

/** A decimal string as the API takes it: "" → null, "18,5" → "18.5". */
function decimalOrNull(text: string): string | null {
  const t = text.trim().replace(",", ".")
  return t === "" ? null : t
}

export interface CoolingFeedFormProps {
  feed?: CoolingFeed
  onSaved: (v: CoolingFeed) => void
  onCancel: () => void
}

/** A cooling loop from a source to a rack (#434). The rack is picked from
 * the source's site - the server refuses one elsewhere. */
export function CoolingFeedForm({
  feed,
  onSaved,
  onCancel,
}: CoolingFeedFormProps) {
  const isEdit = !!feed
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  const choices = useDcimChoices()

  const [name, setName] = useState(feed?.name ?? "")
  const [sourceId, setSourceId] = useState<string | null>(
    feed?.source.id ?? null
  )
  const [rackId, setRackId] = useState<string | null>(feed?.rack?.id ?? null)
  const [statusId, setStatusId] = useState<string | null>(
    feed?.status?.id ?? null
  )
  const [type, setType] = useState<CoolingFeedType>(feed?.type ?? "primary")
  const [ratedKw, setRatedKw] = useState(wattsToKw(feed?.rated_capacity_w))
  const [maxUtil, setMaxUtil] = useState(
    feed?.max_utilization != null ? String(feed.max_utilization) : "80"
  )
  const [flow, setFlow] = useState(feed?.flow_rate_lpm ?? "")
  const [supplyTemp, setSupplyTemp] = useState(feed?.supply_temp_c ?? "")
  const [returnTemp, setReturnTemp] = useState(feed?.return_temp_c ?? "")
  const [connector, setConnector] = useState(feed?.connector ?? "")
  const [comments, setComments] = useState(feed?.comments ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    feed?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    feed?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!feed) return
    setName(feed.name)
    setSourceId(feed.source.id)
    setRackId(feed.rack?.id ?? null)
    setStatusId(feed.status?.id ?? null)
    setType(feed.type)
    setRatedKw(wattsToKw(feed.rated_capacity_w))
    setMaxUtil(String(feed.max_utilization))
    setFlow(feed.flow_rate_lpm ?? "")
    setSupplyTemp(feed.supply_temp_c ?? "")
    setReturnTemp(feed.return_temp_c ?? "")
    setConnector(feed.connector)
    setComments(feed.comments)
    setTagIds(feed.tags.map((t) => t.id))
    setCustomFields(feed.custom_fields)
    reset()
  }, [feed, reset])

  const sources = useQuery({
    queryKey: ["cooling-sources-picker"],
    queryFn: () =>
      api<Paginated<CoolingSourceOption>>("/api/cooling-sources/?picker=1"),
    staleTime: 10 * 60_000,
  })
  // The chosen source's site: the feed's own while its source is unchanged,
  // else read off the source.
  const keptSource = isEdit && sourceId === feed.source.id
  const source = useQuery({
    queryKey: ["cooling-source", sourceId],
    queryFn: () => api<CoolingSource>(`/api/cooling-sources/${sourceId}/`),
    enabled: !!sourceId && !keptSource,
    staleTime: 60_000,
  })
  const siteId = keptSource
    ? (feed.site?.id ?? null)
    : (source.data?.site?.id ?? null)

  const racks = useQuery({
    queryKey: ["racks-picker", "site", siteId],
    queryFn: () =>
      api<Paginated<RackOption>>(`/api/racks/?picker=1&site=${siteId}`),
    enabled: !!siteId,
    staleTime: 5 * 60_000,
  })
  // A new source elsewhere takes the rack with it: once the new site's racks
  // load, a rack that is not among them is cleared.
  useEffect(() => {
    if (keptSource || !rackId || !racks.data) return
    if (!racks.data.results.some((r) => r.id === rackId)) setRackId(null)
  }, [keptSource, rackId, racks.data])

  const statuses = useQuery({
    queryKey: ["statuses", "coolingfeed"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=coolingfeed&picker=1"
      ),
    staleTime: 5 * 60_000,
  })
  // A new feed starts at the catalog's default status for its kind.
  useEffect(() => {
    if (isEdit || statusId) return
    const d = statuses.data?.results.find((s) =>
      s.default_for.includes("coolingfeed")
    )
    if (d) setStatusId(d.id)
  }, [isEdit, statusId, statuses.data])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: CoolingFeedWritePayload = {
        name: name.trim(),
        source_id: sourceId ?? "",
        rack_id: rackId,
        status_id: statusId,
        type,
        rated_capacity_w: kwToWatts(ratedKw),
        max_utilization: maxUtil ? Number(maxUtil) : 80,
        flow_rate_lpm: decimalOrNull(flow),
        supply_temp_c: decimalOrNull(supplyTemp),
        return_temp_c: decimalOrNull(returnTemp),
        connector: connector.trim(),
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<CoolingFeed>({
        objectType: "api.coolingfeed",
        endpoint: "/api/cooling-feeds/",
        id: isEdit ? feed.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["cooling-feeds"] })
      qc.invalidateQueries({ queryKey: ["cooling-feed", saved.id] })
      qc.invalidateQueries({ queryKey: ["embedded-cooling-feeds"] })
      qc.invalidateQueries({ queryKey: ["cooling-sources"] })
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
      className="grid gap-4"
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="Cooling feed" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="Name"
                required
                autoFocus={!isEdit}
                value={name}
                onChange={setName}
                error={fieldErrors.name}
              />
              <FormStatusSelect
                value={statusId}
                onChange={setStatusId}
                options={statuses.data?.results ?? []}
                noneLabel="No status"
                placeholder="Select a status…"
                error={fieldErrors.status_id}
              />
            </div>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormCombobox
                label="Cooling source"
                required
                value={sourceId}
                onChange={setSourceId}
                options={(sources.data?.results ?? []).map((s) => ({
                  value: s.id,
                  label: s.name,
                }))}
                placeholder="Select source"
                searchPlaceholder="Search sources…"
                emptyText="No sources."
                error={fieldErrors.source_id}
              />
              <FormCombobox
                label="Rack"
                hint="optional"
                value={rackId}
                onChange={setRackId}
                options={(racks.data?.results ?? []).map((r) => ({
                  value: r.id,
                  label: r.name,
                }))}
                noneLabel="No rack"
                placeholder={siteId ? "No rack" : "Pick a source first"}
                searchPlaceholder="Search racks…"
                emptyText="No racks at the source's site."
                disabled={!siteId}
                error={fieldErrors.rack_id}
              />
            </div>
          </FormSection>

          <FormSection title="Notes" card>
            <FormTextarea
              label="Comments"
              value={comments}
              onChange={setComments}
              error={fieldErrors.comments}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Loop" card>
            <div className="grid gap-3 @md:grid-cols-3">
              <FormSelect
                label="Type"
                info="A redundant feed must carry the whole rack alone when the primary fails."
                value={type}
                onChange={(v) => setType((v ?? "primary") as CoolingFeedType)}
                options={choices.cooling_feed_types}
                error={fieldErrors.type}
              />
              <FormText
                label="Rated capacity (kW)"
                hint="optional"
                type="number"
                inputMode="decimal"
                min={0}
                step={0.001}
                value={ratedKw}
                onChange={setRatedKw}
                error={fieldErrors.rated_capacity_w}
              />
              <FormText
                label="Max utilisation (%)"
                info="The share of the rated capacity a rack may load."
                type="number"
                min={1}
                max={100}
                value={maxUtil}
                onChange={setMaxUtil}
                error={fieldErrors.max_utilization}
              />
            </div>
            <div className="grid gap-3 @md:grid-cols-3">
              <FormText
                label="Flow (L/min)"
                hint="optional"
                type="number"
                inputMode="decimal"
                min={0}
                step={0.1}
                value={flow}
                onChange={setFlow}
                error={fieldErrors.flow_rate_lpm}
              />
              <FormText
                label="Supply (°C)"
                hint="optional"
                type="number"
                inputMode="decimal"
                step={0.1}
                value={supplyTemp}
                onChange={setSupplyTemp}
                error={fieldErrors.supply_temp_c}
              />
              <FormText
                label="Return (°C)"
                hint="optional"
                type="number"
                inputMode="decimal"
                step={0.1}
                value={returnTemp}
                onChange={setReturnTemp}
                error={fieldErrors.return_temp_c}
              />
            </div>
            <FormText
              label="Connector"
              hint="optional"
              value={connector}
              onChange={setConnector}
              error={fieldErrors.connector}
            />
          </FormSection>
        </FormColumn>
      </FormColumns>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />
      <CustomFieldInputs
        model="coolingfeed"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create feed"}
      />
    </form>
  )
}
