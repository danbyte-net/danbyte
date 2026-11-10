import { useEffect, useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { InventoryProfile, Site } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  Field,
  FormCheckbox,
  FormFooter,
  FormRow,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { TimePicker } from "@/components/ui/time-picker"
import { DevicePicker } from "@/components/device-picker"
import { VMPicker } from "@/components/vm-picker"
import { PrefixPicker } from "@/components/prefix-picker"
import { ObjectPicker } from "@/components/object-picker"
import type { ObjectPickerSpec } from "@/components/object-picker"

// Create or edit an inventory profile (#451 B2). Saving a statement in
// "Authorisation" records you and now as who authorised the scope; changing
// the scope without one clears the authorisation, and an unauthorised
// profile never runs.

type Ref = { id: string; label: string }
type ScopeKey = "sites" | "prefixes" | "devices" | "virtual_machines"
const ID_FIELD: Record<ScopeKey, string> = {
  sites: "site_ids",
  prefixes: "prefix_ids",
  devices: "device_ids",
  virtual_machines: "virtual_machine_ids",
}

function SitePicker(props: {
  label: string
  excludeIds: string[]
  onPickMany: (items: Ref[]) => void
}) {
  const spec = useMemo<ObjectPickerSpec<Site>>(
    () => ({
      noun: "site",
      pickerEndpoint: "/api/sites/?picker=1",
      pickerQueryKey: ["sites-picker"],
      detailEndpoint: (id) => `/api/sites/${id}/`,
      detailQueryKey: (id) => ["site", id],
      listEndpoint: "/api/sites/",
      searchHint: "Search name…",
      filters: [],
      columns: [{ header: "Name", cell: (s) => s.name }],
    }),
    []
  )
  return (
    <ObjectPicker
      spec={spec}
      value={null}
      onChange={() => undefined}
      {...props}
    />
  )
}

function Chips({
  items,
  onRemove,
}: {
  items: Ref[]
  onRemove: (id: string) => void
}) {
  if (!items.length) return null
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((i) => (
        <Badge key={i.id} variant="secondary" className="gap-1 pr-1">
          <span className="font-mono">{i.label}</span>
          <button
            type="button"
            className="rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onRemove(i.id)}
            aria-label={`Remove ${i.label}`}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  )
}

function initialScope(p: InventoryProfile | null): Record<ScopeKey, Ref[]> {
  const map = (rows: { id: string; name: string }[] | undefined) =>
    (rows ?? []).map((r) => ({ id: r.id, label: r.name }))
  return {
    sites: map(p?.scope.sites),
    prefixes: map(p?.scope.prefixes),
    devices: map(p?.scope.devices),
    virtual_machines: map(p?.scope.virtual_machines),
  }
}

export function ProfileDialog({
  open,
  onOpenChange,
  profile,
  onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** The profile to change; null creates one. */
  profile: InventoryProfile | null
  onSaved?: (p: InventoryProfile) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [enabled, setEnabled] = useState(false)
  const [scope, setScope] = useState<Record<ScopeKey, Ref[]>>(
    initialScope(null)
  )
  const [interval, setInterval] = useState("24")
  const [windowStart, setWindowStart] = useState<string | null>(null)
  const [windowEnd, setWindowEnd] = useState<string | null>(null)
  const [concurrency, setConcurrency] = useState("4")
  const [timeout, setTimeoutSecs] = useState("60")
  const [authorisation, setAuthorisation] = useState("")

  useEffect(() => {
    if (!open) return
    reset()
    setName(profile?.name ?? "")
    setDescription(profile?.description ?? "")
    setEnabled(profile?.enabled ?? false)
    setScope(initialScope(profile))
    setInterval(String(profile?.interval_hours ?? 24))
    setWindowStart(profile?.window_start?.slice(0, 5) ?? null)
    setWindowEnd(profile?.window_end?.slice(0, 5) ?? null)
    setConcurrency(String(profile?.max_concurrency ?? 4))
    setTimeoutSecs(String(profile?.timeout_seconds ?? 60))
    setAuthorisation(profile?.authorisation ?? "")
  }, [open, profile, reset])

  const add = (key: ScopeKey) => (items: Ref[]) =>
    setScope((s) => ({
      ...s,
      [key]: [
        ...s[key],
        ...items.filter((i) => !s[key].some((x) => x.id === i.id)),
      ],
    }))
  const remove = (key: ScopeKey) => (id: string) =>
    setScope((s) => ({ ...s, [key]: s[key].filter((x) => x.id !== id) }))
  const ids = (key: ScopeKey) => scope[key].map((i) => i.id)

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name,
        description,
        enabled,
        interval_hours: Number(interval),
        window_start: windowStart,
        window_end: windowEnd,
        max_concurrency: Number(concurrency),
        timeout_seconds: Number(timeout),
      }
      for (const k of Object.keys(ID_FIELD) as ScopeKey[])
        body[ID_FIELD[k]] = ids(k)
      // Only a new or changed statement re-records the authoriser.
      if (!profile || authorisation.trim() !== profile.authorisation)
        body.authorisation = authorisation
      return api<InventoryProfile>(
        profile
          ? `/api/discovery/profiles/${profile.id}/`
          : "/api/discovery/profiles/",
        { method: profile ? "PATCH" : "POST", body: JSON.stringify(body) }
      )
    },
    onSuccess: (p) => {
      toast.success(profile ? "Profile saved" : "Profile created")
      qc.invalidateQueries({ queryKey: ["discovery", "profiles"] })
      qc.setQueryData(["discovery", "profile", p.id], p)
      onOpenChange(false)
      onSaved?.(p)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg !== null) apiErrorToast(err)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {profile ? `Edit ${profile.name}` : "New inventory profile"}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            required
            error={fieldErrors.name}
            autoFocus
          />
          <FormTextarea
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />
          <FormCheckbox
            label="Enabled"
            checked={enabled}
            onChange={setEnabled}
          />

          <Field
            label="Scope"
            group
            info="A host is read when it is named here, sits at a named site, or its primary address is in a named prefix. Exempt hosts, deny subnets and open maintenance events always win."
          >
            <div className="space-y-3">
              <div className="space-y-1">
                <SitePicker
                  label="Sites"
                  excludeIds={ids("sites")}
                  onPickMany={add("sites")}
                />
                <Chips items={scope.sites} onRemove={remove("sites")} />
              </div>
              <div className="space-y-1">
                <PrefixPicker
                  label="Prefixes"
                  value={null}
                  onChange={() => undefined}
                  excludeIds={ids("prefixes")}
                  onPickMany={add("prefixes")}
                />
                <Chips items={scope.prefixes} onRemove={remove("prefixes")} />
              </div>
              <div className="space-y-1">
                <DevicePicker
                  label="Devices"
                  value={null}
                  onChange={() => undefined}
                  excludeIds={ids("devices")}
                  onPickMany={add("devices")}
                />
                <Chips items={scope.devices} onRemove={remove("devices")} />
              </div>
              <div className="space-y-1">
                <VMPicker
                  label="Virtual machines"
                  value={null}
                  onChange={() => undefined}
                  excludeIds={ids("virtual_machines")}
                  onPickMany={add("virtual_machines")}
                />
                <Chips
                  items={scope.virtual_machines}
                  onRemove={remove("virtual_machines")}
                />
              </div>
              {(fieldErrors.site_ids ||
                fieldErrors.prefix_ids ||
                fieldErrors.device_ids ||
                fieldErrors.virtual_machine_ids) && (
                <p className="text-xs text-destructive">
                  {fieldErrors.site_ids ||
                    fieldErrors.prefix_ids ||
                    fieldErrors.device_ids ||
                    fieldErrors.virtual_machine_ids}
                </p>
              )}
            </div>
          </Field>

          <FormRow>
            <FormText
              label="Every"
              type="number"
              min={0}
              value={interval}
              onChange={setInterval}
              hint="hours"
              info="Hours between scheduled runs. 0 runs only when someone presses Run now."
              error={fieldErrors.interval_hours}
            />
            <Field
              label="Window from"
              error={fieldErrors.window_start}
              info="Runs start only inside this daily window, server time. Leave both empty for any time."
            >
              <TimePicker value={windowStart} onChange={setWindowStart} />
            </Field>
            <Field label="Window to" error={fieldErrors.window_end}>
              <TimePicker value={windowEnd} onChange={setWindowEnd} />
            </Field>
          </FormRow>
          <FormRow>
            <FormText
              label="Hosts at once"
              type="number"
              min={1}
              max={16}
              value={concurrency}
              onChange={setConcurrency}
              error={fieldErrors.max_concurrency}
            />
            <FormText
              label="Per-host timeout"
              type="number"
              min={10}
              max={600}
              value={timeout}
              onChange={setTimeoutSecs}
              hint="seconds"
              error={fieldErrors.timeout_seconds}
            />
          </FormRow>

          <FormTextarea
            label="Authorisation"
            value={authorisation}
            onChange={setAuthorisation}
            error={fieldErrors.authorisation}
            placeholder="Who approved reading these hosts, and the reference"
            info="Required before the profile runs. Saving a statement records you and the time as the authoriser; a scope change clears it."
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={profile ? "Save" : "Create"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
