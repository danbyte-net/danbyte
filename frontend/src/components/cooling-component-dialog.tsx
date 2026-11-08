import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  CoolingComponentWritePayload,
  CoolingDeviceRef,
  CoolingIntake,
  CoolingOutflow,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { useDcimChoices } from "@/lib/use-dcim-choices"

export type CoolingKind = "intake" | "outflow"

const ENDPOINT: Record<CoolingKind, string> = {
  intake: "/api/cooling-intakes/",
  outflow: "/api/cooling-outflows/",
}

export const coolingQueryKey = (kind: CoolingKind, deviceId: string) => [
  kind === "intake" ? "device-cooling-intakes" : "device-cooling-outflows",
  deviceId,
]

type FeedOption = { id: string; name: string; source: { name: string } }
/** "hidden": connected to a feed or outflow the caller may not view
 * (#453) - kept as it is until another is picked. */
type Upstream = "none" | "feed" | "outflow" | "hidden"

export interface CoolingComponentDialogProps {
  kind: CoolingKind
  deviceId: string
  /** When set, the dialog edits this row instead of creating one. */
  item?: CoolingIntake | CoolingOutflow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Add/edit a cooling intake or outflow (#434). An intake takes coolant from
 * a feed or from an outflow on another device; an outflow is fed by an
 * intake on the same device. */
export function CoolingComponentDialog({
  kind,
  deviceId,
  item,
  open,
  onOpenChange,
}: CoolingComponentDialogProps) {
  const isEdit = !!item
  const noun = kind === "intake" ? "intake" : "outflow"
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const choices = useDcimChoices()

  const [name, setName] = useState("")
  const [label, setLabel] = useState("")
  const [connector, setConnector] = useState("")
  const [diameter, setDiameter] = useState("")
  const [flow, setFlow] = useState("")
  const [description, setDescription] = useState("")
  const [upstream, setUpstream] = useState<Upstream>("none")
  const [feedId, setFeedId] = useState<string | null>(null)
  const [outflowId, setOutflowId] = useState<string | null>(null)
  const [intakeId, setIntakeId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(item?.name ?? "")
    setLabel(item?.label ?? "")
    setConnector(item?.connector ?? "")
    setDiameter(item?.diameter_mm != null ? String(item.diameter_mm) : "")
    setFlow(item?.max_flow_lpm ?? "")
    setDescription(item?.description ?? "")
    const intake = kind === "intake" ? (item as CoolingIntake | null) : null
    setFeedId(intake?.cooling_feed?.id ?? null)
    setOutflowId(intake?.outflow?.id ?? null)
    setUpstream(
      intake?.upstream_hidden
        ? "hidden"
        : intake?.cooling_feed
          ? "feed"
          : intake?.outflow
            ? "outflow"
            : "none"
    )
    setIntakeId(
      kind === "outflow"
        ? ((item as CoolingOutflow | null)?.intake?.id ?? null)
        : null
    )
    reset()
  }, [open, item, kind, reset])

  const feeds = useQuery({
    queryKey: ["cooling-feeds", "picker"],
    queryFn: () => apiAll<FeedOption>("/api/cooling-feeds/?picker=1"),
    enabled: open && kind === "intake",
  })
  // Outflows on the tenant's other devices - a CDU's secondary ports.
  const outflows = useQuery({
    queryKey: ["cooling-outflows", "picker", deviceId],
    queryFn: () =>
      apiAll<CoolingDeviceRef>(
        `/api/cooling-outflows/?picker=1&exclude_device=${deviceId}`
      ),
    enabled: open && kind === "intake",
  })
  // An outflow is fed by an intake on the same device.
  const intakes = useQuery({
    queryKey: ["cooling-intakes", "picker", deviceId],
    queryFn: () =>
      apiAll<CoolingDeviceRef>(
        `/api/cooling-intakes/?picker=1&device=${deviceId}`
      ),
    enabled: open && kind === "outflow",
  })

  const mutation = useMutation({
    mutationFn: () => {
      const payload: CoolingComponentWritePayload = {
        device_id: deviceId,
        name: name.trim(),
        label: label.trim(),
        connector,
        diameter_mm: diameter.trim() ? Number(diameter) : null,
        max_flow_lpm: flow.trim() || null,
        description: description.trim(),
      }
      if (kind === "intake") {
        // A hidden upstream sends nothing, so the server keeps it.
        if (upstream !== "hidden") {
          payload.cooling_feed_id = upstream === "feed" ? feedId : null
          payload.outflow_id = upstream === "outflow" ? outflowId : null
        }
      } else {
        payload.intake_id = intakeId
      }
      return item
        ? api<CoolingIntake>(`${ENDPOINT[kind]}${item.id}/`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : api<CoolingIntake>(ENDPOINT[kind], {
            method: "POST",
            body: JSON.stringify(payload),
          })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: coolingQueryKey("intake", deviceId) })
      qc.invalidateQueries({ queryKey: coolingQueryKey("outflow", deviceId) })
      qc.invalidateQueries({ queryKey: ["device-cooling-path", deviceId] })
      qc.invalidateQueries({ queryKey: ["device", deviceId] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit cooling ${noun}` : `Add cooling ${noun}`}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={setName}
              mono
              placeholder={kind === "intake" ? "Supply" : "Secondary 1"}
              error={fieldErrors.name}
            />
            <FormText
              label="Label"
              value={label}
              onChange={setLabel}
              placeholder="Optional"
              error={fieldErrors.label}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <FormCombobox
              label="Connector"
              value={connector || null}
              onChange={(v) => setConnector(v ?? "")}
              noneLabel="None"
              placeholder="None"
              searchPlaceholder="Search connectors…"
              emptyText="No connectors."
              options={choices.cooling_connectors}
              error={fieldErrors.connector}
            />
            <FormText
              label="Diameter (mm)"
              type="number"
              min={0}
              value={diameter}
              onChange={setDiameter}
              error={fieldErrors.diameter_mm}
            />
            <FormText
              label="Max flow (L/min)"
              type="number"
              min={0}
              step={0.1}
              value={flow}
              onChange={setFlow}
              error={fieldErrors.max_flow_lpm}
            />
          </div>
          {kind === "intake" ? (
            <div className="grid grid-cols-2 gap-3">
              <FormSelect
                label="Fed from"
                value={upstream}
                onChange={(v) => setUpstream((v ?? "none") as Upstream)}
                options={[
                  ...(upstream === "hidden"
                    ? [{ value: "hidden", label: "Hidden" }]
                    : []),
                  { value: "none", label: "Nothing" },
                  { value: "feed", label: "Cooling feed" },
                  { value: "outflow", label: "Outflow" },
                ]}
              />
              {upstream === "feed" && (
                <FormCombobox
                  label="Cooling feed"
                  value={feedId}
                  onChange={setFeedId}
                  placeholder="Pick a feed"
                  searchPlaceholder="Search feeds…"
                  emptyText="No cooling feeds."
                  options={(feeds.data?.results ?? []).map((f) => ({
                    value: f.id,
                    label: f.name,
                    group: f.source.name,
                  }))}
                  error={fieldErrors.cooling_feed_id}
                />
              )}
              {upstream === "outflow" && (
                <FormCombobox
                  label="Outflow"
                  value={outflowId}
                  onChange={setOutflowId}
                  placeholder="Pick an outflow"
                  searchPlaceholder="Search outflows…"
                  emptyText="No outflows on other devices."
                  options={(outflows.data?.results ?? []).map((o) => ({
                    value: o.id,
                    label: o.name,
                    group: o.device.name,
                  }))}
                  error={fieldErrors.outflow_id}
                />
              )}
            </div>
          ) : (
            <FormCombobox
              label="Fed by intake"
              value={intakeId}
              onChange={setIntakeId}
              noneLabel="None"
              placeholder="Pick an intake"
              searchPlaceholder="Search intakes…"
              emptyText="No intakes on this device."
              options={(intakes.data?.results ?? []).map((i) => ({
                value: i.id,
                label: i.name,
              }))}
              error={fieldErrors.intake_id}
            />
          )}
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="Optional"
            error={fieldErrors.description}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={isEdit ? "Save changes" : `Create ${noun}`}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
