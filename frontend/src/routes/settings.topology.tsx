import { Fragment, useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DeviceRole, Paginated, TopologyCardSettings } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { openingScope } from "@/lib/settings-catalog"
import { useMe } from "@/lib/use-me"
import { useUrlEnum, useUrlPatch, useUrlText } from "@/lib/use-url-state"
import { ColorBadge } from "@/components/cells/color-badge"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  FieldListEditor,
  FieldScopeHeading,
  FieldScopeRow,
  useCustomFieldMeta,
} from "@/components/settings/field-list-editor"
import type {
  FieldGroup,
  FieldMeta,
} from "@/components/settings/field-list-editor"
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { cardFieldLabel } from "@/components/topology/diagram/card-fields"
import { Button } from "@/components/ui/button"
import { InfoTip } from "@/components/ui/info-tip"
import { Switch } from "@/components/ui/switch"

/**
 * Topology card lines: what a device card on the Diagram shows under its
 * name, for every device or per device role, at the tenant or deployment
 * tier. A saved view and a single device can still choose their own - those
 * are edited where they live, on the map and on the device.
 *
 * `?scope=tenant|deployment` picks the tier and `?role=<slug>` the role, so
 * the map can link straight to one role's lines.
 */
export const Route = createFileRoute("/settings/topology")({
  component: TopologySettingsPage,
})

const TIERS = ["tenant", "deployment"] as const
type Tier = (typeof TIERS)[number]

/** The scope key for every device; a role is `role:<slug>`. */
const GLOBAL = ""

const CF_MODELS = ["device"] as const

/** One line of help per built-in key. Labels come from the card itself
 * (`cardFieldLabel`), so the settings and the card never name a line
 * differently. */
const HINTS: Partial<Record<string, string>> = {
  monitor: "Pill while down or degraded",
  status: "Lifecycle status pill",
  primary_ip: "Primary address",
  secondary_ip: "Secondary address",
  oob_ip: "Out-of-band address",
  loopback: "Addresses with the loopback role",
  serial: "Serial number",
  asset_tag: "Inventory tag",
  device_type: "Model",
  manufacturer: "The type's manufacturer",
  platform: "Or the type's platform",
  role: "Device role",
  site: "Site name",
  location: "Location in the site",
  rack: "Rack and position",
  tags: "Tag names",
}

/** The add picker. A key the server adds later lands in "Other". */
const GROUPS: FieldGroup[] = [
  { title: "Pill", keys: ["monitor", "status"] },
  {
    title: "Addresses",
    keys: ["primary_ip", "secondary_ip", "oob_ip", "loopback"],
  },
  {
    title: "Hardware",
    keys: ["serial", "asset_tag", "device_type", "manufacturer", "platform"],
  },
  { title: "Placement", keys: ["role", "site", "location", "rack"] },
  { title: "Other", keys: ["tags"] },
]

function TopologySettingsPage() {
  const { canManage, canManageDeployment, isLoading } = useMe()
  const allowed = TIERS.filter((t) =>
    t === "deployment" ? canManageDeployment : canManage
  )
  const [tierParam, setTier] = useUrlEnum<Tier>(
    "scope",
    openingScope("topology", allowed) ?? "tenant",
    TIERS
  )

  // `?scope=role:<slug>` is read as `?role=<slug>`, so a link written
  // either way lands on the role.
  const [rawScope] = useUrlText("scope")
  const patch = useUrlPatch()
  useEffect(() => {
    if (rawScope.startsWith("role:"))
      patch({ scope: undefined, role: rawScope.slice(5) }, { replace: true })
  }, [rawScope, patch])

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (allowed.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Admin required to change the topology card lines.
      </p>
    )
  const tier = allowed.includes(tierParam) ? tierParam : allowed[0]

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Topology"
        badge={
          <InfoTip>
            A device&apos;s own lines win, then its saved view&apos;s, then its
            role&apos;s, then All devices. An empty list shows the name only.
          </InfoTip>
        }
      >
        What a device card on the topology Diagram shows under its name.
      </SettingsHeader>

      {allowed.length > 1 && (
        <SegmentedTabs
          value={tier}
          onValueChange={setTier}
          items={[
            { value: "tenant", label: "This tenant" },
            { value: "deployment", label: "Deployment default" },
          ]}
        />
      )}

      {/* Keyed by tier, so an unsaved edit never leaks into the other. */}
      <CardLines key={tier} tier={tier} />
    </div>
  )
}

/** The editor's working copy of one tier. */
interface Draft {
  fields: string[]
  /** Nothing stored: the built-in default, which follows future releases. */
  isDefault: boolean
  roles: Record<string, string[]>
  /** Tenant tier: this tenant has its own lines. */
  override: boolean
}

const fromData = (d: TopologyCardSettings): Draft => ({
  fields: d.card_fields,
  isDefault: d.is_default,
  roles: d.role_overrides,
  override: d.override ?? false,
})

/** Key order carries no meaning in the role map. */
const sameDraft = (a: Draft, b: Draft) =>
  JSON.stringify(a.fields) === JSON.stringify(b.fields) &&
  a.isDefault === b.isDefault &&
  a.override === b.override &&
  JSON.stringify(Object.entries(a.roles).sort()) ===
    JSON.stringify(Object.entries(b.roles).sort())

function CardLines({ tier }: { tier: Tier }) {
  const qc = useQueryClient()
  const editingTenant = tier === "tenant"
  const queryKey = [
    editingTenant ? "tenant-topology-card" : "deployment-topology-card",
  ]
  const url = editingTenant
    ? "/api/tenant-settings/topology-card/"
    : "/api/deployment/topology-card/"

  const q = useQuery({
    queryKey,
    queryFn: () => api<TopologyCardSettings>(url),
  })
  const roles = useQuery({
    queryKey: ["device-roles"],
    queryFn: () => api<Paginated<DeviceRole>>("/api/device-roles/"),
  })
  // Hidden custom fields never reach a card, so they are not offered.
  const cfMeta = useCustomFieldMeta(CF_MODELS, { skipHidden: true })

  const [role, setRole] = useUrlText("role", "", { replace: true })
  const [draft, setDraft] = useState<Draft | null>(null)
  // The list each scope had before "Name only", to put back when it goes off.
  const [stash, setStash] = useState<Record<string, string[]>>({})

  const save = useMutation({
    mutationFn: (d: Draft) =>
      api<TopologyCardSettings>(url, {
        method: "PUT",
        body: JSON.stringify({
          card_fields: d.isDefault ? null : d.fields,
          role_overrides: d.roles,
          ...(editingTenant ? { override: d.override } : {}),
        }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      setDraft(null)
      // The Diagram and the device form read the effective lines.
      void qc.invalidateQueries({ queryKey: ["topology"] })
      void qc.invalidateQueries({ queryKey: ["topology-card"] })
      toast.success("Card lines updated")
    },
    onError: (e) => apiErrorToast(e),
  })

  if (q.isError) return <QueryError error={q.error} />
  if (!q.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  const data = q.data
  const saved = fromData(data)
  const cur = draft ?? saved
  const dirty = draft !== null && !sameDraft(draft, saved)
  const update = (next: Partial<Draft>) => setDraft({ ...cur, ...next })

  const roleList = roles.data?.results ?? []
  const roleBySlug = new Map(roleList.map((r) => [r.slug, r]))
  // Lists kept for a role that no longer exists: shown, so they can be
  // cleared, rather than riding along invisibly.
  const orphans = Object.keys(cur.roles).filter(
    (k) => !roleBySlug.has(k.slice(5))
  )

  const known =
    !role || !roles.data || roleBySlug.has(role) || `role:${role}` in cur.roles
  const scope = known && role ? `role:${role}` : GLOBAL
  const isGlobal = scope === GLOBAL

  const cfKeys = Object.keys(cfMeta)
  const cfLabels = Object.fromEntries(
    cfKeys.map((k) => [k.slice(3), cfMeta[k]?.label ?? k])
  )
  const meta = (key: string): FieldMeta => ({
    label: cardFieldLabel(key, cfLabels),
    hint:
      HINTS[key] ??
      cfMeta[key]?.hint ??
      (key.startsWith("cf_") ? "Custom field" : ""),
  })
  const grouped = new Set(GROUPS.flatMap((g) => g.keys))
  const extra = data.available.filter((k) => !grouped.has(k))
  const groups: FieldGroup[] = [
    ...GROUPS.map((g) =>
      g.title === "Other" ? { ...g, keys: [...g.keys, ...extra] } : g
    ),
    ...(cfKeys.length ? [{ title: "Custom fields", keys: cfKeys }] : []),
  ]
  const available = [...data.available, ...cfKeys]

  // While this tenant inherits, the card shows what it inherits instead.
  const inheriting = editingTenant && !cur.override
  const overriding = !inheriting && (isGlobal || scope in cur.roles)
  const current = isGlobal ? cur.fields : (cur.roles[scope] ?? cur.fields)
  const nameOnly = current.length === 0

  const setCurrent = (next: string[]) =>
    isGlobal
      ? update({ fields: next, isDefault: false })
      : update({ roles: { ...cur.roles, [scope]: next } })
  const startOverride = () =>
    update({ roles: { ...cur.roles, [scope]: [...cur.fields] } })
  const resetToInherit = () => {
    const next = { ...cur.roles }
    delete next[scope]
    update({ roles: next })
  }
  const setNameOnly = (on: boolean) => {
    if (on) {
      if (current.length) setStash({ ...stash, [scope]: current })
      setCurrent([])
      return
    }
    const fallback = !isGlobal && cur.fields.length ? cur.fields : data.defaults
    setCurrent(stash[scope] ?? fallback)
  }

  const scopeBadge = (key: string) => {
    const r = roleBySlug.get(key.slice(5))
    return (
      <ColorBadge
        name={r?.name ?? key.slice(5)}
        color={r?.color}
        className="max-w-full"
      />
    )
  }

  return (
    <SettingsCard
      title="Card lines"
      description="The lines under a device's name, for every device or for one role."
      layout="flush"
      inherit={
        editingTenant
          ? {
              overridden: cur.override,
              onChange: (next) =>
                update({
                  override: next,
                  // Start from what it was inheriting, not a blank slate.
                  ...(next && data.deployment_defaults
                    ? {
                        fields: data.deployment_defaults.card_fields,
                        isDefault: data.deployment_defaults.is_default,
                        roles: data.deployment_defaults.role_overrides,
                      }
                    : {}),
                }),
              labels: { on: "This tenant", off: "Deployment default" },
              summary: (
                <InheritedLines
                  defaults={data.deployment_defaults}
                  meta={meta}
                  badge={scopeBadge}
                />
              ),
            }
          : undefined
      }
      onSave={() => save.mutate(cur)}
      dirty={dirty}
      saving={save.isPending}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty}
            onClick={() => {
              setDraft(null)
              setStash({})
            }}
          >
            Reset
          </Button>
          {isGlobal && overriding && (
            <Button
              variant="ghost"
              size="sm"
              disabled={cur.isDefault}
              onClick={() => update({ fields: data.defaults, isDefault: true })}
            >
              Restore defaults
            </Button>
          )}
        </>
      }
    >
      <div className="flex">
        {/* A role without its own lines uses All devices, so only the roles
            that genuinely differ need configuring. */}
        <aside className="w-56 shrink-0 border-r border-border p-3">
          <FieldScopeHeading first>Applies to</FieldScopeHeading>
          <FieldScopeRow
            active={isGlobal}
            onSelect={() => setRole("")}
            label="All devices"
            custom={false}
          />

          {roleList.length + orphans.length > 0 && (
            <FieldScopeHeading>Device roles</FieldScopeHeading>
          )}
          {roleList.map((r) => (
            <FieldScopeRow
              key={r.id}
              active={scope === `role:${r.slug}`}
              onSelect={() => setRole(r.slug)}
              label={scopeBadge(`role:${r.slug}`)}
              custom={`role:${r.slug}` in cur.roles}
            />
          ))}
          {orphans.map((k) => (
            <FieldScopeRow
              key={k}
              active={scope === k}
              onSelect={() => setRole(k.slice(5))}
              label={scopeBadge(k)}
              custom
            />
          ))}
        </aside>

        <div className="min-w-0 flex-1 p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">
                {isGlobal ? "All devices" : scopeBadge(scope)}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isGlobal
                  ? "Top to bottom under the name. A line with no value for a device is skipped."
                  : overriding
                    ? "This role's own lines."
                    : "Uses All devices."}
              </p>
            </div>
            {!isGlobal &&
              (overriding ? (
                <Button variant="outline" size="sm" onClick={resetToInherit}>
                  <RotateCcw className="h-3.5 w-3.5" /> Inherit
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={startOverride}>
                  Override
                </Button>
              ))}
          </div>

          {overriding && (
            <div className="mb-3 flex items-center gap-3">
              <label className="flex items-center gap-2 text-[13px] whitespace-nowrap">
                <Switch
                  size="sm"
                  checked={nameOnly}
                  onCheckedChange={setNameOnly}
                  aria-label="Name only"
                />
                Name only
              </label>
              <span className="ml-auto text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
                {current.length} of {data.max_fields}
              </span>
            </div>
          )}

          <FieldListEditor
            value={current}
            onChange={setCurrent}
            editable={overriding}
            meta={meta}
            groups={groups}
            available={available}
            empty="The card shows just the device name."
            max={data.max_fields}
          />
        </div>
      </div>
    </SettingsCard>
  )
}

/** What a tenant gets while it inherits: the deployment's lines, for every
 * device and for each role that has its own. */
function InheritedLines({
  defaults,
  meta,
  badge,
}: {
  defaults: TopologyCardSettings["deployment_defaults"]
  meta: (key: string) => FieldMeta
  badge: (scope: string) => React.ReactNode
}) {
  if (!defaults) return <span>Inheriting the deployment default.</span>
  const lines = (keys: string[]) =>
    keys.length ? keys.map((k) => meta(k).label).join(" · ") : "Name only"
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
      <span className="text-foreground">All devices</span>
      <span>{lines(defaults.card_fields)}</span>
      {Object.entries(defaults.role_overrides).map(([scope, keys]) => (
        <Fragment key={scope}>
          <span>{badge(scope)}</span>
          <span>{lines(keys)}</span>
        </Fragment>
      ))}
    </div>
  )
}
