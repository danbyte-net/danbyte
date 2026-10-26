import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { toast } from "sonner"

import { api, ApiError } from "@/lib/api"
import type {
  ApplicationGroupMini,
  CustomField,
  DeviceProfile,
  PlatformOption,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import {
  Field,
  FormColor,
  FormCombobox,
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { IdMultiSelect } from "@/components/cells/id-multi-select"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import {
  CustomFieldInput,
  CustomFieldInputs,
} from "@/components/custom-field-inputs"
import { PROFILES_ENDPOINT } from "@/components/device-profile-assign"

// Create / edit a device profile: its facts, its parent and what it applies
// to, then one card per section - what assigning the profile writes.

export interface DeviceProfileFormProps {
  profile?: DeviceProfile
  onSaved: (p: DeviceProfile) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128)
}

/** Profiles that cannot be ``selfId``'s parent: itself and everything
 * under it - picking one would make the profile its own ancestor. */
export function excludedParents(
  profiles: { id: string; parent: { id: string } | null }[],
  selfId: string | undefined
): Set<string> {
  const out = new Set<string>()
  if (!selfId) return out
  out.add(selfId)
  let grew = true
  while (grew) {
    grew = false
    for (const p of profiles) {
      if (!out.has(p.id) && p.parent && out.has(p.parent.id)) {
        out.add(p.id)
        grew = true
      }
    }
  }
  return out
}

/** Custom fields a profile may fill: those of every kind it applies to. */
export function applicableFields(
  device: CustomField[],
  vm: CustomField[],
  devices: boolean,
  vms: boolean
): CustomField[] {
  if (devices && vms) {
    const onVm = new Set(vm.map((d) => d.key))
    return device.filter((d) => onVm.has(d.key))
  }
  return devices ? device : vms ? vm : []
}

function SwitchRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} size="sm" checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-xs whitespace-nowrap">
        {label}
      </Label>
    </div>
  )
}

export function DeviceProfileForm({
  profile,
  onSaved,
  onCancel,
}: DeviceProfileFormProps) {
  const isEdit = !!profile
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const [cfErrors, setCfErrors] = useState<Record<string, string>>({})

  const [name, setName] = useState(profile?.name ?? "")
  const [slug, setSlug] = useState(profile?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [description, setDescription] = useState(profile?.description ?? "")
  const [color, setColor] = useState(profile?.color ?? "")
  const [parentId, setParentId] = useState<string | null>(
    profile?.parent?.id ?? null
  )
  const [devices, setDevices] = useState(profile?.applies_to_devices ?? true)
  const [vms, setVms] = useState(profile?.applies_to_vms ?? true)
  const [groupIds, setGroupIds] = useState<string[]>(
    profile?.application_groups.map((g) => g.id) ?? []
  )
  const [addTagIds, setAddTagIds] = useState<number[]>(
    profile?.add_tags.map((t) => t.id) ?? []
  )
  const [cfValues, setCfValues] = useState<Record<string, unknown>>(
    profile?.cf_values ?? {}
  )
  const [platformId, setPlatformId] = useState<string | null>(
    profile?.platform?.id ?? null
  )
  const [runbookUrl, setRunbookUrl] = useState(profile?.runbook_url ?? "")
  const [notes, setNotes] = useState(profile?.notes ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    profile?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    profile?.custom_fields ?? {}
  )

  const profiles = useQuery({
    queryKey: ["device-profiles", "all"],
    queryFn: () => apiAll<DeviceProfile>(PROFILES_ENDPOINT),
  })
  const groups = useQuery({
    queryKey: ["application-groups-picker"],
    queryFn: () =>
      apiAll<ApplicationGroupMini>("/api/application-groups/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const platforms = useQuery({
    queryKey: ["platforms-picker"],
    queryFn: () => apiAll<PlatformOption>("/api/platforms/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () =>
      apiAll<{
        id: number
        name: string
        slug: string
        color: string
        text_color: string
      }>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  const deviceFields = useQuery({
    queryKey: ["custom-fields-for", "device"],
    queryFn: () => apiAll<CustomField>("/api/custom-fields/?model=device"),
    staleTime: 5 * 60_000,
  })
  const vmFields = useQuery({
    queryKey: ["custom-fields-for", "virtualmachine"],
    queryFn: () =>
      apiAll<CustomField>("/api/custom-fields/?model=virtualmachine"),
    staleTime: 5 * 60_000,
  })

  const all = useMemo(() => profiles.data?.results ?? [], [profiles.data])
  const excluded = useMemo(
    () => excludedParents(all, profile?.id),
    [all, profile?.id]
  )
  const fields = applicableFields(
    deviceFields.data?.results ?? [],
    vmFields.data?.results ?? [],
    devices,
    vms
  )
  const byKey = new Map(fields.map((d) => [d.key, d]))
  const unused = fields.filter((d) => !(d.key in cfValues))

  const save = useMutation({
    mutationFn: () =>
      api<DeviceProfile>(
        profile ? `${PROFILES_ENDPOINT}${profile.id}/` : PROFILES_ENDPOINT,
        {
          method: profile ? "PATCH" : "POST",
          body: JSON.stringify({
            name: name.trim(),
            slug: slug.trim() || slugify(name),
            description: description.trim(),
            color,
            parent_id: parentId,
            applies_to_devices: devices,
            applies_to_vms: vms,
            application_group_ids: groupIds,
            add_tag_ids: addTagIds,
            cf_values: cfValues,
            platform_id: platformId,
            runbook_url: runbookUrl.trim(),
            notes,
            tag_ids: tagIds,
            custom_fields: customFields,
          }),
        }
      ),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["device-profiles"] })
      qc.invalidateQueries({ queryKey: ["device-profiles-picker"] })
      qc.invalidateQueries({ queryKey: ["device-profile", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const cf =
        err instanceof ApiError &&
        err.body &&
        typeof err.body === "object" &&
        (err.body as Record<string, unknown>).cf_values
      setCfErrors(
        cf && typeof cf === "object" && !Array.isArray(cf)
          ? (cf as Record<string, string>)
          : {}
      )
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const setCf = (key: string, v: unknown) =>
    setCfValues((cur) => ({ ...cur, [key]: v }))
  const dropCf = (key: string) =>
    setCfValues((cur) => {
      const next = { ...cur }
      delete next[key]
      return next
    })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Device profile" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={(v) => {
              setName(v)
              if (!slugDirty) setSlug(slugify(v))
            }}
            placeholder="RDS-Server-HR"
            error={fieldErrors.name}
          />
          <FormText
            label="Slug"
            hint="URL-safe id"
            value={slug}
            onChange={(v) => {
              setSlugDirty(true)
              setSlug(slugify(v))
            }}
            mono
            error={fieldErrors.slug}
          />
          <FormCombobox
            label="Parent"
            hint="optional"
            value={parentId}
            onChange={setParentId}
            options={all
              .filter((p) => !excluded.has(p.id))
              .map((p) => ({
                value: p.id,
                label: p.name,
                color: p.color || null,
                badge: true,
              }))}
            noneLabel="No parent"
            placeholder="Select a parent…"
            searchPlaceholder="Search profiles…"
            emptyText="No profiles."
            error={fieldErrors.parent_id}
          />
          <FormColor
            label="Color"
            value={color}
            onChange={setColor}
            error={fieldErrors.color}
          />
          <Field label="Applies to" error={fieldErrors.applies_to_devices}>
            <div className="flex h-8 items-center gap-4">
              <SwitchRow
                id="applies-devices"
                label="Devices"
                checked={devices}
                onChange={setDevices}
              />
              <SwitchRow
                id="applies-vms"
                label="Virtual machines"
                checked={vms}
                onChange={setVms}
              />
            </div>
          </Field>
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>

      <FormSection title="Application groups" card>
        <Field label="Groups" error={fieldErrors.application_group_ids}>
          <IdMultiSelect
            ordered
            options={(groups.data?.results ?? []).map((g) => ({
              id: g.id,
              name: g.name,
            }))}
            value={groupIds}
            onChange={setGroupIds}
            placeholder="Add group…"
            searchPlaceholder="Search groups…"
            emptyText="No application groups."
          />
        </Field>
      </FormSection>

      <FormSection title="Tags to add" card>
        <Field label="Tags" error={fieldErrors.add_tag_ids}>
          <TagMultiSelect
            options={tags.data?.results ?? []}
            value={addTagIds}
            onChange={setAddTagIds}
          />
        </Field>
      </FormSection>

      <FormSection title="Custom field values" card>
        <div className="grid gap-3">
          {Object.keys(cfValues).map((key) => {
            const def = byKey.get(key)
            return (
              <div
                key={key}
                className="flex items-end gap-2"
                data-testid={`cf-row-${key}`}
              >
                <div className="min-w-0 flex-1">
                  {def ? (
                    <CustomFieldInput
                      def={def}
                      value={cfValues[key]}
                      onChange={(v) => setCf(key, v)}
                    />
                  ) : (
                    <FormText
                      label={key}
                      value={String(cfValues[key] ?? "")}
                      onChange={(v) => setCf(key, v)}
                      error="Not a field of every kind this profile applies to."
                    />
                  )}
                  {cfErrors[key] && (
                    <p className="mt-1 text-xs text-destructive">
                      {cfErrors[key]}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  title={`Remove ${def?.label ?? key}`}
                  onClick={() => dropCf(key)}
                >
                  <X className="h-3.5 w-3.5" />
                  <span className="sr-only">Remove {def?.label ?? key}</span>
                </Button>
              </div>
            )
          })}
          <FormCombobox
            label="Add field"
            value={null}
            onChange={(k) => k && setCf(k, "")}
            options={unused.map((d) => ({ value: d.key, label: d.label }))}
            placeholder="Pick a field…"
            searchPlaceholder="Search fields…"
            emptyText="No more fields."
          />
        </div>
      </FormSection>

      <FormSection title="Platform" card>
        <FormCombobox
          label="Platform"
          hint="when the object has none"
          value={platformId}
          onChange={setPlatformId}
          options={(platforms.data?.results ?? []).map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          noneLabel="No platform"
          placeholder="Select a platform…"
          searchPlaceholder="Search platforms…"
          emptyText="No platforms."
          error={fieldErrors.platform_id}
        />
      </FormSection>

      <FormSection title="Runbook and notes" card>
        <FormText
          label="Runbook link"
          value={runbookUrl}
          onChange={setRunbookUrl}
          placeholder="https://"
          error={fieldErrors.runbook_url}
        />
        <FormTextarea
          label="Notes"
          value={notes}
          onChange={setNotes}
          error={fieldErrors.notes}
        />
      </FormSection>

      <CustomFieldInputs
        model="deviceprofile"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save changes" : "Create profile"}
      />
    </form>
  )
}
