import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  CheckTemplate,
  Paginated,
  SlaCheckGroup,
  SlaCheckItem,
} from "@/lib/api"
import {
  CheckList,
  Field,
  FormCheckbox,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

type Option = {
  id: string
  name?: string
  model?: string
  color?: string | null
}

function usePicker(key: string, url: string) {
  return (
    useQuery({
      queryKey: [key, "sla-picker"],
      queryFn: () => api<Paginated<Option>>(url),
      staleTime: 5 * 60_000,
    }).data?.results ?? []
  )
}

/** Create or edit one check group: which checks count, which addresses they
 * are read from, and - optionally - which devices join by selector. */
export function SlaGroupDialog({
  agreementId,
  group,
  open,
  onOpenChange,
  onSaved,
}: {
  agreementId: string
  group?: SlaCheckGroup
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {group ? `Edit ${group.name}` : "New check group"}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <GroupForm
            agreementId={agreementId}
            group={group}
            onCancel={() => onOpenChange(false)}
            onSaved={() => {
              onOpenChange(false)
              onSaved()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function GroupForm({
  agreementId,
  group: g,
  onCancel,
  onSaved,
}: {
  agreementId: string
  group?: SlaCheckGroup
  onCancel: () => void
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState(g?.name ?? "")
  const [target, setTarget] = useState(g?.target ?? "primary")
  const [combine, setCombine] = useState(g?.combine ?? "all")
  const [items, setItems] = useState<SlaCheckItem[]>(g?.items ?? [])
  const [useSelector, setUseSelector] = useState(g?.use_selector ?? false)
  const [sites, setSites] = useState<string[]>(g?.match_sites ?? [])
  const [roles, setRoles] = useState<string[]>(g?.match_roles ?? [])
  const [types, setTypes] = useState<string[]>(g?.match_device_types ?? [])
  const [platforms, setPlatforms] = useState<string[]>(g?.match_platforms ?? [])
  const [tags, setTags] = useState((g?.match_tags ?? []).join(", "))
  const [matchName, setMatchName] = useState(g?.match_name ?? "")

  const templates =
    useQuery({
      queryKey: ["check-templates", "sla-picker"],
      queryFn: () =>
        api<Paginated<CheckTemplate>>(
          "/api/monitoring/templates/?page_size=500"
        ),
      staleTime: 60_000,
    }).data?.results ?? []
  const siteOpts = usePicker("sites", "/api/sites/?picker=1")
  const roleOpts = usePicker("device-roles", "/api/device-roles/?picker=1")
  const typeOpts = usePicker(
    "device-types",
    "/api/device-types/?picker=1&page_size=500"
  )
  const platformOpts = usePicker("platforms", "/api/platforms/?picker=1")

  const byTemplate = new Map(items.map((i) => [i.template, i]))
  const pickTemplates = (ids: string[]) =>
    setItems(
      ids.map(
        (id) =>
          byTemplate.get(id) ?? {
            template: id,
            counts: true,
            weight: 1,
            required: false,
          }
      )
    )
  const setItem = (id: string, patch: Partial<SlaCheckItem>) =>
    setItems((xs) =>
      xs.map((x) => (x.template === id ? { ...x, ...patch } : x))
    )

  const save = useMutation({
    mutationFn: () => {
      reset()
      const body = JSON.stringify({
        agreement: agreementId,
        name: name.trim(),
        target,
        combine,
        items: items.map(({ template, counts, weight, required }) => ({
          template,
          counts,
          weight,
          required,
        })),
        use_selector: useSelector,
        match_sites: sites,
        match_roles: roles,
        match_device_types: types,
        match_platforms: platforms,
        match_tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        match_name: matchName.trim(),
      })
      return g
        ? api(`/api/monitoring/sla-check-groups/${g.id}/`, {
            method: "PATCH",
            body,
          })
        : api("/api/monitoring/sla-check-groups/", { method: "POST", body })
    },
    onSuccess: () => {
      toast.success(g ? `Saved ${name}` : `Created ${name}`)
      qc.invalidateQueries({ queryKey: ["sla-groups", agreementId] })
      onSaved()
    },
    onError: (e) => {
      const msg = handleApiError(e)
      if (msg) toast.error(msg)
    },
  })

  const tmplName = new Map(templates.map((t) => [t.id, t]))
  return (
    <form
      className="grid max-h-[70vh] gap-4 overflow-auto pr-1"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <FormText
          label="Name"
          value={name}
          onChange={setName}
          required
          placeholder="Leaf switches"
          error={fieldErrors.name}
        />
        <FormSelect
          label="Addresses"
          value={target}
          onChange={(v) => setTarget(v as typeof target)}
          options={[
            { value: "primary", label: "Primary address" },
            { value: "all", label: "Every address" },
          ]}
          info="Which of a device's addresses its checks are read from."
        />
        <FormSelect
          label="Checks combine as"
          value={combine}
          onChange={(v) => setCombine(v as typeof combine)}
          options={[
            { value: "all", label: "All must pass" },
            { value: "weighted", label: "Weighted" },
          ]}
          info="All must pass: the object is down while any counted check is down. Weighted: the weighted average, a required check's down time always counting."
        />
      </div>

      <Field
        label="Checks"
        info="With none picked, every check on the member's addresses counts."
        error={fieldErrors.items}
      >
        <CheckList
          options={templates.map((t) => ({
            value: t.id,
            label: `${t.name}`,
            hint: t.kind.toUpperCase(),
          }))}
          value={items.map((i) => i.template)}
          onChange={pickTemplates}
          className="max-h-40"
          empty="No check templates yet."
        />
      </Field>
      {items.length > 0 && (
        <div className="grid gap-1 rounded-md border border-border p-2 text-[13px]">
          {items.map((i) => (
            <div key={i.template} className="flex items-center gap-3">
              <span className="w-48 truncate">
                {tmplName.get(i.template)?.name ?? i.template_name}
              </span>
              <label className="flex items-center gap-1.5 whitespace-nowrap">
                <Checkbox
                  checked={i.counts}
                  onCheckedChange={(v) =>
                    setItem(i.template, { counts: v === true })
                  }
                />
                Counts
              </label>
              {combine === "weighted" && (
                <>
                  <label className="flex items-center gap-1.5 whitespace-nowrap">
                    <Checkbox
                      checked={i.required}
                      onCheckedChange={(v) =>
                        setItem(i.template, { required: v === true })
                      }
                    />
                    Required
                  </label>
                  <Input
                    type="number"
                    min={0}
                    step="0.1"
                    className="h-7 w-20"
                    value={i.weight}
                    onChange={(e) =>
                      setItem(i.template, {
                        weight: Number(e.target.value) || 0,
                      })
                    }
                    aria-label="Weight"
                  />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <FormCheckbox
        label="Devices join by selector"
        checked={useSelector}
        onChange={setUseSelector}
        info="Devices matching everything set below are members without being added. Add a device and mark it excluded to keep it out."
      />
      {useSelector && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Sites">
            <CheckList
              options={siteOpts.map((o) => ({
                value: o.id,
                label: o.name ?? "",
              }))}
              value={sites}
              onChange={setSites}
              className="max-h-32"
            />
          </Field>
          <Field label="Roles">
            <CheckList
              options={roleOpts.map((o) => ({
                value: o.id,
                label: o.name ?? "",
                color: o.color,
              }))}
              value={roles}
              onChange={setRoles}
              className="max-h-32"
            />
          </Field>
          <Field label="Device types">
            <CheckList
              options={typeOpts.map((o) => ({
                value: o.id,
                label: o.model ?? o.name ?? "",
              }))}
              value={types}
              onChange={setTypes}
              className="max-h-32"
            />
          </Field>
          <Field label="Platforms">
            <CheckList
              options={platformOpts.map((o) => ({
                value: o.id,
                label: o.name ?? "",
              }))}
              value={platforms}
              onChange={setPlatforms}
              className="max-h-32"
            />
          </Field>
          <FormText
            label="Tags"
            value={tags}
            onChange={setTags}
            placeholder="core, production"
            info="Tag slugs, comma-separated. A device must carry all of them."
            error={fieldErrors.match_tags}
          />
          <FormText
            label="Name"
            value={matchName}
            onChange={setMatchName}
            placeholder="leaf-*"
            info="A pattern on the device name; * matches anything."
            error={fieldErrors.match_name}
          />
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving..." : "Save"}
        </Button>
      </DialogFooter>
    </form>
  )
}
