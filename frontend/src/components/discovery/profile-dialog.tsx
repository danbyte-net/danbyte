import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  DiscoverySettings,
  DiscoveryProfileKind,
  InventoryProfile,
  SharedCredential,
  Site,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import {
  Field,
  FormCheckbox,
  FormFooter,
  FormRow,
  FormCombobox,
  FormSelect,
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

// Create or edit a discovery profile (#451 B2, B3): package inventory or a
// service scan, chosen when it is created. Saving a statement in
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

const ENGINE_OPTIONS = [
  { value: "builtin", label: "Built-in" },
  { value: "nmap", label: "nmap" },
]
const INTENSITY_OPTIONS = [0, 1, 2, 3, 4, 5].map((n) => ({
  value: String(n),
  label: n === 2 ? "2 (light)" : String(n),
}))
const TIMING_OPTIONS = [
  { value: "2", label: "Polite (-T2)" },
  { value: "3", label: "Normal (-T3)" },
  { value: "4", label: "Aggressive (-T4)" },
]

/** "22, 80, 8000-8100" -> [22, 80, "8000-8100"]; the server validates. */
function parsePorts(text: string): (number | string)[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s))
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
  const [sharedId, setSharedId] = useState<string | null>(null)
  const [kind, setKind] = useState<DiscoveryProfileKind>("inventory")
  const [ports, setPorts] = useState("")
  const [rate, setRate] = useState("20")
  const [engine, setEngine] = useState<"builtin" | "nmap">("builtin")
  const [intensity, setIntensity] = useState("2")
  const [timing, setTiming] = useState("3")
  const scan = kind === "service_scan"
  const { canDo } = useMe()
  const nmapOn = !!useQuery({
    queryKey: ["discovery", "settings"],
    queryFn: () => api<DiscoverySettings>("/api/discovery/settings/"),
    enabled: open && scan,
  }).data?.nmap.enabled
  const shared = useQuery({
    queryKey: ["shared-credentials", "ssh"],
    queryFn: () =>
      apiAll<SharedCredential>("/api/monitoring/shared-credentials/?enabled=1"),
    enabled: open && canDo("sharedcredential", "view"),
    select: (d) =>
      d.results.filter(
        (c) => c.kind === "ssh_key" || c.kind === "ssh_password"
      ),
  })

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
    setSharedId(profile?.shared_credential_id ?? null)
    setKind(profile?.kind ?? "inventory")
    setPorts((profile?.ports ?? []).join(", "))
    setRate(String(profile?.connects_per_second ?? 20))
    setEngine(profile?.scan_engine ?? "builtin")
    setIntensity(String(profile?.nmap_version_intensity ?? 2))
    setTiming(String(profile?.nmap_timing ?? 3))
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
      }
      if (!profile) body.kind = kind
      if (scan) {
        body.ports = parsePorts(ports)
        body.connects_per_second = Number(rate)
        body.scan_engine = engine
        if (engine === "nmap") {
          body.nmap_version_intensity = Number(intensity)
          body.nmap_timing = Number(timing)
        }
      } else {
        body.timeout_seconds = Number(timeout)
        body.shared_credential_id = sharedId
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
            {profile ? `Edit ${profile.name}` : "New discovery profile"}
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
          {!profile && (
            <FormSelect
              label="Kind"
              value={kind}
              onChange={(v) =>
                setKind(v === "service_scan" ? "service_scan" : "inventory")
              }
              options={[
                { value: "inventory", label: "Package inventory" },
                { value: "service_scan", label: "Service scan" },
              ]}
              error={fieldErrors.kind}
              info="Package inventory logs in and reads installed packages. A service scan connects to TCP ports of IPAM addresses and reads what answers. Fixed once created."
            />
          )}
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
            info={
              scan
                ? "Scans IPAM addresses only: every address in a named prefix, of a named site, or of a named device or VM. Exempt objects, deny subnets and open maintenance events always win."
                : "A host is read when it is named here, sits at a named site, or its primary address is in a named prefix. Exempt hosts, deny subnets and open maintenance events always win."
            }
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
          {scan && (
            <FormRow>
              <FormText
                label="Ports"
                value={ports}
                onChange={setPorts}
                placeholder="Default list"
                error={fieldErrors.ports}
                info="Ports and ranges, comma separated: 22, 80, 8000-8100. Empty scans the default list of about 40 common ports. At most 1,024."
              />
              <FormText
                label="Connects per second"
                type="number"
                min={1}
                max={profile?.rate_cap}
                value={rate}
                onChange={setRate}
                error={fieldErrors.connects_per_second}
                info="New TCP connections per second across the whole run. The deployment caps it."
              />
            </FormRow>
          )}
          {scan && (
            <FormRow>
              <FormSelect
                label="Engine"
                value={engine}
                onChange={(v) => setEngine(v === "nmap" ? "nmap" : "builtin")}
                options={ENGINE_OPTIONS.filter(
                  (o) => o.value === "builtin" || nmapOn || engine === "nmap"
                )}
                error={fieldErrors.scan_engine}
                info="Built-in needs nothing installed. nmap recognises more services and versions; it is offered once a tenant admin switches it on on the Discovery card."
              />
              {engine === "nmap" && (
                <FormSelect
                  label="Version probes"
                  value={intensity}
                  onChange={(v) => setIntensity(v ?? "2")}
                  options={INTENSITY_OPTIONS}
                  error={fieldErrors.nmap_version_intensity}
                  info="nmap --version-intensity: how many service probes it tries per port. Higher finds more and sends more."
                />
              )}
              {engine === "nmap" && (
                <FormSelect
                  label="Timing"
                  value={timing}
                  onChange={(v) => setTiming(v ?? "3")}
                  options={TIMING_OPTIONS}
                  error={fieldErrors.nmap_timing}
                  info="nmap's timing template. The connects-per-second cap applies as --max-rate either way."
                />
              )}
            </FormRow>
          )}
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
            {!scan && (
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
            )}
          </FormRow>

          {!scan && (
            <FormCombobox
              label="Credential"
              value={sharedId}
              onChange={setSharedId}
              noneLabel="Host's own, then matching shared"
              options={[
                ...(shared.data ?? []).map((c) => ({
                  value: c.id,
                  label: c.name,
                })),
                // Keep a pinned one the list does not carry (disabled since).
                ...(profile?.shared_credential &&
                !(shared.data ?? []).some(
                  (c) => c.id === profile.shared_credential!.id
                )
                  ? [
                      {
                        value: profile.shared_credential.id,
                        label: profile.shared_credential.name,
                      },
                    ]
                  : []),
              ]}
              error={fieldErrors.shared_credential_id}
              info="A shared credential tried for every host right after the host's own device credential, before the shared credentials whose scope matches."
            />
          )}
          <FormTextarea
            label="Authorisation"
            value={authorisation}
            onChange={setAuthorisation}
            error={fieldErrors.authorisation}
            placeholder="Who approved reading these hosts, and the reference"
            info={
              scan
                ? "Required before the profile runs. Saving a statement records you and the time as the authoriser; a change to the scope or the ports clears it."
                : "Required before the profile runs. Saving a statement records you and the time as the authoriser; a scope change clears it."
            }
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
