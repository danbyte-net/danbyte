import { useState } from "react"

import type {
  ASPathList,
  CommunityList,
  CommunityMini,
  PrefixList,
  PrefixListMini,
  RoutingPolicy,
} from "@/lib/api"
import {
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormTags,
  FormText,
  FormTextarea,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { Button } from "@/components/ui/button"
import { Plus, Trash2 } from "lucide-react"

import { MultiPick } from "./multi-pick"
import {
  ACTIONS,
  CellInput,
  CellSelect,
  RulesTable,
  numOrNull,
  numText,
  usePickList,
  ROUTING_OBJECT_TYPES,
  useRoutingSave,
} from "./form-bits"

// The four lists that carry rules. Each form is one page: the list's own
// fields, then its rules, written together (the API replaces the rule set
// on save, upserting by sequence).

interface CatalogState {
  name: string
  description: string
  tagIds: number[]
  customFields: Record<string, unknown>
}

function useCatalogState(item?: {
  name: string
  description: string
  tags: { id: number }[]
  custom_fields: Record<string, unknown>
}) {
  const [name, setName] = useState(item?.name ?? "")
  const [description, setDescription] = useState(item?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const state: CatalogState = { name, description, tagIds, customFields }
  return { state, setName, setDescription, setTagIds, setCustomFields }
}

function CatalogFields({
  cfModel,
  s,
  errors,
  isEdit,
  children,
}: {
  cfModel: string
  s: ReturnType<typeof useCatalogState>
  errors: Record<string, string | undefined>
  isEdit: boolean
  children?: React.ReactNode
}) {
  return (
    <FormSection title="List" card>
      <div className="grid gap-3 @md:grid-cols-2">
        <FormText
          label="Name"
          required
          mono
          autoFocus={!isEdit}
          value={s.state.name}
          onChange={s.setName}
          placeholder="CUSTOMER-IN"
          error={errors.name}
        />
        {children}
      </div>
      <FormTextarea
        label="Description"
        value={s.state.description}
        onChange={s.setDescription}
        error={errors.description}
      />
      <FormTags value={s.state.tagIds} onChange={s.setTagIds} label="Tags" />
      <CustomFieldInputs
        model={cfModel}
        value={s.state.customFields}
        onChange={s.setCustomFields}
      />
    </FormSection>
  )
}

const catalogPayload = (s: CatalogState) => ({
  name: s.name.trim(),
  description: s.description.trim(),
  tag_ids: s.tagIds,
  custom_fields: s.customFields,
})

// ─── Prefix list ─────────────────────────────────────────────────────────────

interface PrefixRuleDraft {
  sequence: number
  action: string
  prefix: string
  ge: string
  le: string
  description: string
}

export function PrefixListForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: PrefixList
  onSaved: (v: PrefixList) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const s = useCatalogState(item)
  const [family, setFamily] = useState<string | null>(item?.family ?? "ipv4")
  const [rules, setRules] = useState<PrefixRuleDraft[]>(
    (item?.rules ?? []).map((r) => ({
      sequence: r.sequence,
      action: r.action,
      prefix: r.prefix,
      ge: numText(r.ge),
      le: numText(r.le),
      description: r.description,
    }))
  )
  const { mutation, fieldErrors } = useRoutingSave<PrefixList>({
    objectType: ROUTING_OBJECT_TYPES.prefixlist,
    endpoint: "/api/routing/prefix-lists/",
    queryKey: "prefix-lists",
    id: item?.id,
    label: (v) => v.name,
    onSaved,
  })
  const rulesError = ruleErrors(fieldErrors)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          ...catalogPayload(s.state),
          family,
          rules: rules.map((r) => ({
            sequence: r.sequence,
            action: r.action,
            prefix: r.prefix.trim(),
            ge: numOrNull(r.ge),
            le: numOrNull(r.le),
            description: r.description.trim(),
          })),
        })
      }}
      className="@container grid gap-4"
    >
      <CatalogFields
        cfModel="prefixlist"
        s={s}
        errors={fieldErrors}
        isEdit={isEdit}
      >
        <FormSelect
          label="Family"
          value={family}
          onChange={setFamily}
          options={[
            { value: "ipv4", label: "IPv4" },
            { value: "ipv6", label: "IPv6" },
          ]}
          error={fieldErrors.family}
        />
      </CatalogFields>
      <FormSection title="Rules" card>
        <RulesTable<PrefixRuleDraft>
          rows={rules}
          onChange={setRules}
          headers={[
            { label: "Seq", width: "w-16" },
            { label: "Action", width: "w-24" },
            { label: "Prefix", width: "w-40" },
            { label: "ge", width: "w-14" },
            { label: "le", width: "w-14" },
            { label: "Description", width: "min-w-0 flex-1" },
          ]}
          newRow={(sequence) => ({
            sequence,
            action: "permit",
            prefix: "",
            ge: "",
            le: "",
            description: "",
          })}
          renderRow={(r, update) => [
            <CellInput
              key="seq"
              type="number"
              value={String(r.sequence)}
              onChange={(v) => update({ sequence: Number(v) })}
            />,
            <CellSelect
              key="action"
              value={r.action}
              onChange={(v) => update({ action: v })}
              options={ACTIONS}
            />,
            <CellInput
              key="prefix"
              mono
              value={r.prefix}
              placeholder="10.0.0.0/8"
              onChange={(v) => update({ prefix: v })}
            />,
            <CellInput
              key="ge"
              type="number"
              value={r.ge}
              onChange={(v) => update({ ge: v })}
            />,
            <CellInput
              key="le"
              type="number"
              value={r.le}
              onChange={(v) => update({ le: v })}
            />,
            <CellInput
              key="desc"
              value={r.description}
              onChange={(v) => update({ description: v })}
            />,
          ]}
        />
        {rulesError && <p className="text-xs text-destructive">{rulesError}</p>}
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create prefix list"}
      />
    </form>
  )
}

/** The API reports rule problems as readable lines under ``rules``
 * ("Rule 2: ge: Must be between 8 and 32."); the first one goes under the
 * table. */
function ruleErrors(errors: Record<string, string | undefined>): string | null {
  return errors.rules ?? null
}

// ─── Community list ──────────────────────────────────────────────────────────

interface CommunityRuleDraft {
  sequence: number
  action: string
  communityIds: string[]
  regex: string
  description: string
}

export function CommunityListForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: CommunityList
  onSaved: (v: CommunityList) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const s = useCatalogState(item)
  const [kind, setKind] = useState<string | null>(item?.kind ?? "standard")
  const [rules, setRules] = useState<CommunityRuleDraft[]>(
    (item?.rules ?? []).map((r) => ({
      sequence: r.sequence,
      action: r.action,
      communityIds: r.communities.map((c) => c.id),
      regex: r.regex,
      description: r.description,
    }))
  )
  const communities = usePickList<CommunityMini>(
    "communities",
    "/api/routing/communities/",
    (c) => (c.name ? `${c.value} · ${c.name}` : c.value)
  )
  const { mutation, fieldErrors } = useRoutingSave<CommunityList>({
    objectType: ROUTING_OBJECT_TYPES.communitylist,
    endpoint: "/api/routing/community-lists/",
    queryKey: "community-lists",
    id: item?.id,
    label: (v) => v.name,
    onSaved,
  })
  const expanded = kind === "expanded"
  const rulesError = ruleErrors(fieldErrors)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          ...catalogPayload(s.state),
          kind,
          rules: rules.map((r) => ({
            sequence: r.sequence,
            action: r.action,
            community_ids: expanded ? [] : r.communityIds,
            regex: expanded ? r.regex.trim() : "",
            description: r.description.trim(),
          })),
        })
      }}
      className="@container grid gap-4"
    >
      <CatalogFields
        cfModel="communitylist"
        s={s}
        errors={fieldErrors}
        isEdit={isEdit}
      >
        <FormSelect
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "standard", label: "Standard" },
            { value: "expanded", label: "Expanded (regex)" },
            { value: "large", label: "Large" },
            { value: "extended", label: "Extended" },
          ]}
          error={fieldErrors.kind}
        />
      </CatalogFields>
      <FormSection title="Rules" card>
        <RulesTable<CommunityRuleDraft>
          rows={rules}
          onChange={setRules}
          headers={[
            { label: "Seq", width: "w-16" },
            { label: "Action", width: "w-24" },
            {
              label: expanded ? "Pattern" : "Communities",
              width: "min-w-0 flex-1",
            },
            { label: "Description", width: "w-40" },
          ]}
          newRow={(sequence) => ({
            sequence,
            action: "permit",
            communityIds: [],
            regex: "",
            description: "",
          })}
          renderRow={(r, update) => [
            <CellInput
              key="seq"
              type="number"
              value={String(r.sequence)}
              onChange={(v) => update({ sequence: Number(v) })}
            />,
            <CellSelect
              key="action"
              value={r.action}
              onChange={(v) => update({ action: v })}
              options={ACTIONS}
            />,
            expanded ? (
              <CellInput
                key="regex"
                mono
                value={r.regex}
                placeholder="^65000:1.."
                onChange={(v) => update({ regex: v })}
              />
            ) : (
              <MultiPick
                key="communities"
                options={communities}
                value={r.communityIds}
                onChange={(v) => update({ communityIds: v })}
                placeholder="Add community"
                searchPlaceholder="Search communities…"
                emptyText="No communities yet."
              />
            ),
            <CellInput
              key="desc"
              value={r.description}
              onChange={(v) => update({ description: v })}
            />,
          ]}
        />
        {rulesError && <p className="text-xs text-destructive">{rulesError}</p>}
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create community list"}
      />
    </form>
  )
}

// ─── AS-path list ────────────────────────────────────────────────────────────

interface ASPathRuleDraft {
  sequence: number
  action: string
  regex: string
  description: string
}

export function ASPathListForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: ASPathList
  onSaved: (v: ASPathList) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const s = useCatalogState(item)
  const [rules, setRules] = useState<ASPathRuleDraft[]>(
    (item?.rules ?? []).map((r) => ({
      sequence: r.sequence,
      action: r.action,
      regex: r.regex,
      description: r.description,
    }))
  )
  const { mutation, fieldErrors } = useRoutingSave<ASPathList>({
    objectType: ROUTING_OBJECT_TYPES.aspathlist,
    endpoint: "/api/routing/as-path-lists/",
    queryKey: "as-path-lists",
    id: item?.id,
    label: (v) => v.name,
    onSaved,
  })
  const rulesError = ruleErrors(fieldErrors)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          ...catalogPayload(s.state),
          rules: rules.map((r) => ({
            sequence: r.sequence,
            action: r.action,
            regex: r.regex.trim(),
            description: r.description.trim(),
          })),
        })
      }}
      className="@container grid gap-4"
    >
      <CatalogFields
        cfModel="aspathlist"
        s={s}
        errors={fieldErrors}
        isEdit={isEdit}
      />
      <FormSection title="Rules" card>
        <RulesTable<ASPathRuleDraft>
          rows={rules}
          onChange={setRules}
          headers={[
            { label: "Seq", width: "w-16" },
            { label: "Action", width: "w-24" },
            { label: "Pattern", width: "w-56" },
            { label: "Description", width: "min-w-0 flex-1" },
          ]}
          newRow={(sequence) => ({
            sequence,
            action: "permit",
            regex: "",
            description: "",
          })}
          renderRow={(r, update) => [
            <CellInput
              key="seq"
              type="number"
              value={String(r.sequence)}
              onChange={(v) => update({ sequence: Number(v) })}
            />,
            <CellSelect
              key="action"
              value={r.action}
              onChange={(v) => update({ action: v })}
              options={ACTIONS}
            />,
            <CellInput
              key="regex"
              mono
              value={r.regex}
              placeholder="^65010_"
              onChange={(v) => update({ regex: v })}
            />,
            <CellInput
              key="desc"
              value={r.description}
              onChange={(v) => update({ description: v })}
            />,
          ]}
        />
        {rulesError && <p className="text-xs text-destructive">{rulesError}</p>}
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create AS-path list"}
      />
    </form>
  )
}

// ─── Routing policy ──────────────────────────────────────────────────────────

interface PolicyRuleDraft {
  sequence: number
  action: string
  description: string
  matchPrefixListIds: string[]
  matchCommunityListIds: string[]
  matchAsPathListIds: string[]
  matchNextHopId: string | null
  setLocalPref: string
  setMed: string
  setWeight: string
  setOrigin: string
  setNextHop: string
  setAsPathPrepend: string
  setCommunityIds: string[]
  setCommunitiesAdditive: boolean
  setMetricType: string
  continueSeq: string
}

const ORIGINS = [
  { value: "igp", label: "IGP" },
  { value: "egp", label: "EGP" },
  { value: "incomplete", label: "Incomplete" },
]
const METRIC_TYPES = [
  { value: "1", label: "Type 1" },
  { value: "2", label: "Type 2" },
]

export function RoutingPolicyForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: RoutingPolicy
  onSaved: (v: RoutingPolicy) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const s = useCatalogState(item)
  const [rules, setRules] = useState<PolicyRuleDraft[]>(
    (item?.rules ?? []).map((r) => ({
      sequence: r.sequence,
      action: r.action,
      description: r.description,
      matchPrefixListIds: r.match_prefix_lists.map((x) => x.id),
      matchCommunityListIds: r.match_community_lists.map((x) => x.id),
      matchAsPathListIds: r.match_as_path_lists.map((x) => x.id),
      matchNextHopId: r.match_next_hop?.id ?? null,
      setLocalPref: numText(r.set_local_pref),
      setMed: numText(r.set_med),
      setWeight: numText(r.set_weight),
      setOrigin: r.set_origin,
      setNextHop: r.set_next_hop,
      setAsPathPrepend: r.set_as_path_prepend,
      setCommunityIds: r.set_communities.map((c) => c.id),
      setCommunitiesAdditive: r.set_communities_additive,
      setMetricType: numText(r.set_metric_type),
      continueSeq: numText(r.continue_seq),
    }))
  )
  const prefixLists = usePickList<PrefixListMini>(
    "prefix-lists",
    "/api/routing/prefix-lists/",
    (x) => x.name
  )
  const communityLists = usePickList<{ id: string; name: string }>(
    "community-lists",
    "/api/routing/community-lists/",
    (x) => x.name
  )
  const asPathLists = usePickList<{ id: string; name: string }>(
    "as-path-lists",
    "/api/routing/as-path-lists/",
    (x) => x.name
  )
  const communities = usePickList<CommunityMini>(
    "communities",
    "/api/routing/communities/",
    (c) => (c.name ? `${c.value} · ${c.name}` : c.value)
  )
  const { mutation, fieldErrors } = useRoutingSave<RoutingPolicy>({
    objectType: ROUTING_OBJECT_TYPES.routingpolicy,
    endpoint: "/api/routing/policies/",
    queryKey: "routing-policies",
    id: item?.id,
    label: (v) => v.name,
    onSaved,
  })
  const rulesError = ruleErrors(fieldErrors)

  const update = (i: number, patch: Partial<PolicyRuleDraft>) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => setRules(rules.filter((_, j) => j !== i))
  const add = () => {
    const last = rules.reduce((m, r) => Math.max(m, r.sequence || 0), 0)
    setRules([
      ...rules,
      {
        sequence: last + 10,
        action: "permit",
        description: "",
        matchPrefixListIds: [],
        matchCommunityListIds: [],
        matchAsPathListIds: [],
        matchNextHopId: null,
        setLocalPref: "",
        setMed: "",
        setWeight: "",
        setOrigin: "",
        setNextHop: "",
        setAsPathPrepend: "",
        setCommunityIds: [],
        setCommunitiesAdditive: false,
        setMetricType: "",
        continueSeq: "",
      },
    ])
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          ...catalogPayload(s.state),
          rules: rules.map((r) => ({
            sequence: r.sequence,
            action: r.action,
            description: r.description.trim(),
            match_prefix_list_ids: r.matchPrefixListIds,
            match_community_list_ids: r.matchCommunityListIds,
            match_as_path_list_ids: r.matchAsPathListIds,
            match_next_hop_id: r.matchNextHopId,
            set_local_pref: numOrNull(r.setLocalPref),
            set_med: numOrNull(r.setMed),
            set_weight: numOrNull(r.setWeight),
            set_origin: r.setOrigin,
            set_next_hop: r.setNextHop.trim(),
            set_as_path_prepend: r.setAsPathPrepend.trim(),
            set_community_ids: r.setCommunityIds,
            set_communities_additive: r.setCommunitiesAdditive,
            set_metric_type: numOrNull(r.setMetricType),
            continue_seq: numOrNull(r.continueSeq),
          })),
        })
      }}
      className="@container grid gap-4"
    >
      <CatalogFields
        cfModel="routingpolicy"
        s={s}
        errors={fieldErrors}
        isEdit={isEdit}
      />

      {rules.map((r, i) => (
        <section
          key={i}
          className="grid min-w-0 content-start gap-3 rounded-lg border border-border bg-card p-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Rule {r.sequence} · {r.action}
            </h3>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => remove(i)}
              aria-label="Remove rule"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="grid gap-3 @md:grid-cols-4">
            <FormText
              label="Sequence"
              type="number"
              value={String(r.sequence)}
              onChange={(v) => update(i, { sequence: Number(v) })}
            />
            <FormSelect
              label="Action"
              value={r.action}
              onChange={(v) => update(i, { action: v ?? "permit" })}
              options={ACTIONS}
            />
            <div className="@md:col-span-2">
              <FormText
                label="Description"
                value={r.description}
                onChange={(v) => update(i, { description: v })}
              />
            </div>
          </div>
          <div className="grid gap-4 @lg:grid-cols-2">
            <div className="grid gap-3 rounded-md border border-border p-3">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Match
              </p>
              <PickRow label="Prefix lists">
                <MultiPick
                  options={prefixLists}
                  value={r.matchPrefixListIds}
                  onChange={(v) => update(i, { matchPrefixListIds: v })}
                  placeholder="Add prefix list"
                  emptyText="No prefix lists yet."
                />
              </PickRow>
              <PickRow label="Community lists">
                <MultiPick
                  options={communityLists}
                  value={r.matchCommunityListIds}
                  onChange={(v) => update(i, { matchCommunityListIds: v })}
                  placeholder="Add community list"
                  emptyText="No community lists yet."
                />
              </PickRow>
              <PickRow label="AS-path lists">
                <MultiPick
                  options={asPathLists}
                  value={r.matchAsPathListIds}
                  onChange={(v) => update(i, { matchAsPathListIds: v })}
                  placeholder="Add AS-path list"
                  emptyText="No AS-path lists yet."
                />
              </PickRow>
              <FormCombobox
                label="Next hop in"
                value={r.matchNextHopId}
                onChange={(v) => update(i, { matchNextHopId: v })}
                options={prefixLists.map((p) => ({
                  value: p.id,
                  label: p.label,
                }))}
                noneLabel="Any"
                placeholder="Any"
              />
            </div>
            <div className="grid gap-3 rounded-md border border-border p-3">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Set
              </p>
              <div className="grid gap-3 @md:grid-cols-3">
                <FormText
                  label="Local pref"
                  type="number"
                  value={r.setLocalPref}
                  onChange={(v) => update(i, { setLocalPref: v })}
                />
                <FormText
                  label="MED"
                  type="number"
                  value={r.setMed}
                  onChange={(v) => update(i, { setMed: v })}
                />
                <FormText
                  label="Weight"
                  type="number"
                  value={r.setWeight}
                  onChange={(v) => update(i, { setWeight: v })}
                />
              </div>
              <div className="grid gap-3 @md:grid-cols-2">
                <FormText
                  label="Next hop"
                  mono
                  value={r.setNextHop}
                  onChange={(v) => update(i, { setNextHop: v })}
                  placeholder="10.0.0.1"
                />
                <FormText
                  label="AS-path prepend"
                  mono
                  value={r.setAsPathPrepend}
                  onChange={(v) => update(i, { setAsPathPrepend: v })}
                  placeholder="65001 65001"
                />
              </div>
              <PickRow label="Communities">
                <MultiPick
                  options={communities}
                  value={r.setCommunityIds}
                  onChange={(v) => update(i, { setCommunityIds: v })}
                  placeholder="Add community"
                  emptyText="No communities yet."
                />
              </PickRow>
              <FormCheckbox
                label="Additive"
                checked={r.setCommunitiesAdditive}
                onChange={(v) => update(i, { setCommunitiesAdditive: v })}
                hint="keep the communities already on the route"
              />
              <div className="grid gap-3 @md:grid-cols-3">
                <FormSelect
                  label="Origin"
                  value={r.setOrigin || null}
                  onChange={(v) => update(i, { setOrigin: v ?? "" })}
                  options={ORIGINS}
                  noneLabel="Unchanged"
                />
                <FormSelect
                  label="Metric type"
                  value={r.setMetricType || null}
                  onChange={(v) => update(i, { setMetricType: v ?? "" })}
                  options={METRIC_TYPES}
                  noneLabel="Unchanged"
                />
                <FormText
                  label="Continue"
                  type="number"
                  value={r.continueSeq}
                  onChange={(v) => update(i, { continueSeq: v })}
                />
              </div>
            </div>
          </div>
        </section>
      ))}
      {rulesError && <p className="text-xs text-destructive">{rulesError}</p>}
      <div>
        <Button type="button" size="sm" variant="outline" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add rule
        </Button>
      </div>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create policy"}
      />
    </form>
  )
}

function PickRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
    </div>
  )
}
