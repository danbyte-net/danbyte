import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ConfigContext,
  type ConfigContextWritePayload,
  type Paginated,
} from "@/lib/api"
import {
  CheckList,
  Field,
  FormCheckbox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
  type CheckOption,
} from "@/components/forms"

interface NamedRow {
  id: string
  name: string
}

function usePicker(key: string, url: string) {
  return useQuery({
    queryKey: [key],
    queryFn: () => api<Paginated<NamedRow>>(url),
    staleTime: 10 * 60_000,
  })
}

export interface ConfigContextFormProps {
  context?: ConfigContext
  onSaved: (v: ConfigContext) => void
  onCancel: () => void
}

export function ConfigContextForm({
  context,
  onSaved,
  onCancel,
}: ConfigContextFormProps) {
  const isEdit = !!context
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(context?.name ?? "")
  const [weight, setWeight] = useState(
    context?.weight != null ? String(context.weight) : "1000"
  )
  const [isActive, setIsActive] = useState(context?.is_active ?? true)
  const [description, setDescription] = useState(context?.description ?? "")
  const [dataText, setDataText] = useState(
    context?.data ? JSON.stringify(context.data, null, 2) : "{}"
  )
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [weightError, setWeightError] = useState<string | null>(null)
  const [regionIds, setRegionIds] = useState<string[]>(
    context?.regions.map((r) => r.id) ?? []
  )
  const [siteIds, setSiteIds] = useState<string[]>(
    context?.sites.map((s) => s.id) ?? []
  )
  const [roleIds, setRoleIds] = useState<string[]>(
    context?.device_roles.map((r) => r.id) ?? []
  )
  const [platformIds, setPlatformIds] = useState<string[]>(
    context?.platforms.map((p) => p.id) ?? []
  )

  useEffect(() => {
    if (!context) return
    setName(context.name)
    setWeight(String(context.weight))
    setIsActive(context.is_active)
    setDescription(context.description)
    setDataText(JSON.stringify(context.data ?? {}, null, 2))
    setWeightError(null)
    setRegionIds(context.regions.map((r) => r.id))
    setSiteIds(context.sites.map((s) => s.id))
    setRoleIds(context.device_roles.map((r) => r.id))
    setPlatformIds(context.platforms.map((p) => p.id))
    reset()
  }, [context, reset])

  const regions = usePicker("regions-picker", "/api/regions/?picker=1")
  const sites = usePicker("sites-picker", "/api/sites/?picker=1")
  const roles = usePicker("device-roles-picker", "/api/device-roles/?picker=1")
  const platforms = usePicker("platforms-picker", "/api/platforms/?picker=1")

  const opt = (rows?: NamedRow[]): CheckOption<string>[] =>
    (rows ?? []).map((r) => ({ value: r.id, label: r.name }))

  const mutation = useMutation({
    mutationFn: async () => {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(dataText || "{}")
        if (typeof data !== "object" || Array.isArray(data) || data === null)
          throw new Error("not an object")
      } catch {
        setJsonError("Data must be a valid JSON object.")
        throw new Error("Invalid JSON in data.")
      }
      setJsonError(null)
      // Number("abc") is NaN, which would serialize as null and silently
      // clobber the weight — validate before building the payload.
      const trimmedWeight = weight.trim()
      const weightNum = trimmedWeight === "" ? 1000 : Number(trimmedWeight)
      if (!Number.isFinite(weightNum)) {
        setWeightError("Weight must be a number.")
        throw new Error("Invalid weight.")
      }
      setWeightError(null)
      const payload: ConfigContextWritePayload = {
        name: name.trim(),
        weight: weightNum,
        is_active: isActive,
        description: description.trim(),
        data,
        region_ids: regionIds,
        site_ids: siteIds,
        device_role_ids: roleIds,
        platform_ids: platformIds,
      }
      if (isEdit)
        return api<ConfigContext>(`/api/config-contexts/${context!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<ConfigContext>("/api/config-contexts/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["config-contexts"] })
      qc.invalidateQueries({ queryKey: ["config-context", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const message = (err as Error).message
      if (message === "Invalid JSON in data." || message === "Invalid weight.")
        return
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
      className="grid max-w-2xl gap-4"
    >
      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-4">
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <FormText
          label="Weight"
          type="number"
          hint="higher wins"
          value={weight}
          onChange={(v) => {
            setWeight(v)
            setWeightError(null)
          }}
          error={weightError ?? fieldErrors.weight}
        />
        <FormCheckbox
          label="Active"
          checked={isActive}
          onChange={setIsActive}
          className="pb-2"
        />
      </div>

      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />

      <FormTextarea
        label="Data (JSON)"
        hint="Merged onto matching devices/VMs"
        rows={8}
        value={dataText}
        onChange={(v) => {
          setDataText(v)
          setJsonError(null)
        }}
        error={jsonError ?? fieldErrors.data}
      />

      <p className="text-[11px] text-muted-foreground">
        Assignment — a context applies to a device/VM that matches{" "}
        <span className="font-medium">all</span> the dimensions you set below.
        Leave a dimension empty to match everything.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Regions">
          <CheckList
            options={opt(regions.data?.results)}
            value={regionIds}
            onChange={setRegionIds}
            empty="No regions."
          />
        </Field>
        <Field label="Sites">
          <CheckList
            options={opt(sites.data?.results)}
            value={siteIds}
            onChange={setSiteIds}
            empty="No sites."
          />
        </Field>
        <Field label="Device roles">
          <CheckList
            options={opt(roles.data?.results)}
            value={roleIds}
            onChange={setRoleIds}
            empty="No roles."
          />
        </Field>
        <Field label="Platforms">
          <CheckList
            options={opt(platforms.data?.results)}
            value={platformIds}
            onChange={setPlatformIds}
            empty="No platforms."
          />
        </Field>
      </div>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create context"}
      />
    </form>
  )
}
