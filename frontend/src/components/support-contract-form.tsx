import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  ManufacturerOption,
  Paginated,
  SupportContract,
  SupportContractWritePayload,
} from "@/lib/api"
import {
  CheckList,
  Field,
  FormColumn,
  FormColumns,
  FormCombobox,
  FormDate,
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"
import { useMe } from "@/lib/use-me"

export interface SupportContractFormProps {
  contract?: SupportContract
  onSaved: (v: SupportContract) => void
  onCancel: () => void
}

/** Support contract create/edit (#421). */
export function SupportContractForm({
  contract,
  onSaved,
  onCancel,
}: SupportContractFormProps) {
  const isEdit = !!contract
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  // Cost is commercial data: without view_cost it is neither shown nor sent,
  // so an edit keeps the stored cost.
  const { canDo } = useMe()
  const money = canDo("supportcontract", "view_cost")

  const [manufacturerId, setManufacturerId] = useState<string | null>(
    contract?.manufacturer.id ?? null
  )
  const [number, setNumber] = useState(contract?.contract_number ?? "")
  const [serviceLevel, setServiceLevel] = useState(
    contract?.service_level ?? ""
  )
  const [startDate, setStartDate] = useState(contract?.start_date ?? "")
  const [endDate, setEndDate] = useState(contract?.end_date ?? "")
  const [reseller, setReseller] = useState(contract?.reseller ?? "")
  const [cost, setCost] = useState(
    contract?.cost != null ? String(contract.cost) : ""
  )
  const [currency, setCurrency] = useState(contract?.currency ?? "")
  const [portalUrl, setPortalUrl] = useState(contract?.portal_url ?? "")
  const [renewalNotes, setRenewalNotes] = useState(
    contract?.renewal_notes ?? ""
  )
  const [description, setDescription] = useState(contract?.description ?? "")
  const [channels, setChannels] = useState<string[]>(
    contract?.notify_channels.map((c) => c.id) ?? []
  )
  const [tagIds, setTagIds] = useState<number[]>(
    contract?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    contract?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!contract) return
    setManufacturerId(contract.manufacturer.id)
    setNumber(contract.contract_number)
    setServiceLevel(contract.service_level)
    setStartDate(contract.start_date ?? "")
    setEndDate(contract.end_date ?? "")
    setReseller(contract.reseller)
    setCost(contract.cost != null ? String(contract.cost) : "")
    setCurrency(contract.currency ?? "")
    setPortalUrl(contract.portal_url)
    setRenewalNotes(contract.renewal_notes)
    setDescription(contract.description)
    setChannels(contract.notify_channels.map((c) => c.id))
    setTagIds(contract.tags.map((t) => t.id))
    setCustomFields(contract.custom_fields)
    reset()
  }, [contract, reset])

  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () =>
      api<Paginated<ManufacturerOption>>("/api/manufacturers/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const channelList = useQuery({
    queryKey: ["notification-channels", "support-contract"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string; kind: string }>>(
        "/api/monitoring/channels/?page_size=200"
      ),
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: SupportContractWritePayload = {
        manufacturer_id: manufacturerId ?? "",
        contract_number: number.trim(),
        service_level: serviceLevel.trim(),
        start_date: startDate || null,
        end_date: endDate || null,
        reseller: reseller.trim(),
        ...(money
          ? {
              cost: cost.trim() === "" ? null : Number(cost),
              currency: currency.trim().toUpperCase(),
            }
          : {}),
        portal_url: portalUrl.trim(),
        renewal_notes: renewalNotes.trim(),
        description: description.trim(),
        notify_channel_ids: channels,
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<SupportContract>({
        objectType: "api.supportcontract",
        endpoint: "/api/support-contracts/",
        id: isEdit ? contract.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["support-contracts"] })
      qc.invalidateQueries({ queryKey: ["support-contract", saved.id] })
      toast.success(
        isEdit
          ? `Updated ${saved.contract_number}`
          : `Created ${saved.contract_number}`
      )
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
          <FormSection title="Contract" card>
            <FormCombobox
              label="Manufacturer"
              required
              value={manufacturerId}
              onChange={setManufacturerId}
              options={(manufacturers.data?.results ?? []).map((m) => ({
                value: m.id,
                label: m.name,
              }))}
              placeholder="Select manufacturer"
              searchPlaceholder="Search manufacturers…"
              emptyText="No manufacturers."
              error={fieldErrors.manufacturer_id}
            />
            <FormText
              label="Contract number"
              required
              mono
              autoFocus={!isEdit}
              value={number}
              onChange={setNumber}
              error={fieldErrors.contract_number}
            />
            <FormText
              label="Service level"
              value={serviceLevel}
              onChange={setServiceLevel}
              placeholder="8x5xNBD"
              error={fieldErrors.service_level}
            />
            <div className="grid gap-3 @md:grid-cols-2">
              <FormDate
                label="Start"
                value={startDate}
                onChange={setStartDate}
                error={fieldErrors.start_date}
              />
              <FormDate
                label="End"
                info="Last covered day. Leave empty for open-ended."
                value={endDate}
                onChange={setEndDate}
                error={fieldErrors.end_date}
              />
            </div>
          </FormSection>
          <FormSection title="Notes" card>
            <FormText
              label="Description"
              value={description}
              onChange={setDescription}
              error={fieldErrors.description}
            />
            <FormTextarea
              label="Renewal notes"
              value={renewalNotes}
              onChange={setRenewalNotes}
              rows={3}
              error={fieldErrors.renewal_notes}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Commercial" card>
            <FormText
              label="Reseller"
              value={reseller}
              onChange={setReseller}
              error={fieldErrors.reseller}
            />
            {money && (
              <div className="grid gap-3 @md:grid-cols-2">
                <FormText
                  label="Cost"
                  type="number"
                  inputMode="decimal"
                  value={cost}
                  onChange={setCost}
                  error={fieldErrors.cost}
                />
                <FormText
                  label="Currency"
                  value={currency}
                  onChange={(v) => setCurrency(v.toUpperCase().slice(0, 3))}
                  placeholder="EUR"
                  error={fieldErrors.currency}
                />
              </div>
            )}
            <FormText
              label="Vendor portal"
              type="url"
              value={portalUrl}
              onChange={setPortalUrl}
              placeholder="https://"
              error={fieldErrors.portal_url}
            />
          </FormSection>
          <FormSection title="Notifications" card>
            <Field
              label="Channels"
              info="Told when the contract enters the warning window and when it expires."
              error={fieldErrors.notify_channel_ids}
            >
              <CheckList
                options={(channelList.data?.results ?? []).map((c) => ({
                  value: c.id,
                  label: c.name,
                  hint: c.kind,
                }))}
                value={channels}
                onChange={setChannels}
                className="max-h-32"
                empty="No notification channels yet."
              />
            </Field>
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
        model="supportcontract"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create contract"}
      />
    </form>
  )
}
