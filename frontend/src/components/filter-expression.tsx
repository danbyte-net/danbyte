import { useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, Info, ListFilter, Plus, X } from "lucide-react"

import {
  OP_LABELS,
  blankGroup,
  blankRule,
  discoverFields,
  format,
  fromTree,
  isEmptyOp,
  isListOp,
  parse,
  toTree,
} from "@/lib/filter-expr"
import type {
  BuilderOp,
  FieldInfo,
  TreeGroup,
  TreeNode,
  TreeRule,
} from "@/lib/filter-expr"
import { apiAll } from "@/lib/api-all"
import type { StatusMini } from "@/lib/api"
import { cn } from "@/lib/utils"
import { FacetHeading } from "@/components/filter-rail"
import { ColorBadge } from "@/components/cells/color-badge"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * The advanced filter: one expression per list, written either through the
 * row-based builder or as text in the same grammar - both edit the same AST,
 * so switching between them is lossless (until the text uses nesting the
 * builder can't show, in which case the text editor stays authoritative).
 *
 * Lives at the top of the filter rail on every list, and is captured by saved
 * views exactly like the facet selections.
 */

export function ExpressionFilter({
  value,
  onChange,
  rows,
  onHide,
}: {
  /** The committed expression text ("" = off). */
  value: string
  onChange: (next: string) => void
  rows: unknown[]
  /** Hide this filter on the list (#285); omitted where it can't be. */
  onHide?: () => void
}) {
  const [open, setOpen] = useState(false)
  const active = value.trim() !== ""

  return (
    <div>
      <FacetHeading
        label="Advanced"
        onHide={onHide}
        onClear={active ? () => onChange("") : undefined}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-start gap-1.5 font-normal"
        onClick={() => setOpen(true)}
      >
        <ListFilter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-[12px]">
          {active ? value : "Filter expression…"}
        </span>
      </Button>
      {open && (
        <ExpressionDialog
          initial={value}
          rows={rows}
          onClose={() => setOpen(false)}
          onApply={(next) => {
            onChange(next)
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

function ExpressionDialog({
  initial,
  rows,
  onClose,
  onApply,
}: {
  initial: string
  rows: unknown[]
  onClose: () => void
  onApply: (next: string) => void
}) {
  const [state, setState] = useState<{ text: string; error: string | null }>({
    text: initial,
    error: null,
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            Advanced filter
            <OperatorsHint />
          </DialogTitle>
          <DialogDescription>
            Build conditions, or type them -{" "}
            <code className="text-[11px]">
              status = active and (site.name ~ cph or tags ~ core)
            </code>
            . Fields and values come from this list's own rows.
          </DialogDescription>
        </DialogHeader>

        <ExpressionEditor
          initial={initial}
          rows={rows}
          onChange={(text, error) => setState({ text, error })}
        />

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!!state.error || !state.text.trim()}
            onClick={() => {
              onApply(state.text.trim())
              // Hand off to the SavedViews naming flow (same page, different
              // subtree) - the snapshot it saves includes this expression.
              window.dispatchEvent(new CustomEvent("danbyte:save-view"))
            }}
          >
            Apply &amp; save as view
          </Button>
          <Button
            size="sm"
            disabled={!!state.error}
            onClick={() => onApply(state.text.trim())}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The builder + text pair, reusable outside the list dialog (the saved-filter
 * management page edits stored expressions with no rows to sample). Reports
 * every edit with its parse error so the host can gate its save button.
 *
 * `fields` replaces the fields discovered from `rows` - a host that knows its
 * fields' kinds hands them in, and the value controls follow them. */
export function ExpressionEditor({
  initial,
  rows,
  fields: given,
  onChange,
}: {
  initial: string
  rows: unknown[]
  fields?: FieldSpec[]
  onChange: (text: string, error: string | null) => void
}) {
  const fields = useMemo(
    () => given ?? fieldsFromRows(discoverFields(rows)),
    [given, rows]
  )

  // The tree is STATE, not a projection of the text: a freshly added blank
  // row isn't part of the expression yet, so deriving rows from text on every
  // keystroke made "+ Condition" a no-op. Text and tree stay in sync in both
  // directions; the tree goes null only for nesting deeper than it shows.
  const seed = (t: string): TreeGroup | null => {
    try {
      return withBlank(toTree(parse(t), MAX_GROUPS))
    } catch {
      return null
    }
  }
  const [text, setText] = useState(initial)
  const [tree, setTree] = useState(() => seed(initial))

  let error: string | null = null
  try {
    parse(text)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const onTextEdit = (t: string) => {
    setText(t)
    let err: string | null = null
    try {
      parse(t)
      setTree(seed(t))
    } catch (e) {
      // Invalid mid-edit text: keep the rows as they were.
      err = e instanceof Error ? e.message : String(e)
    }
    onChange(t, err)
  }

  const setFromTree = (next: TreeGroup) => {
    setTree(next)
    const t = format(fromTree(next))
    setText(t)
    onChange(t, null)
  }

  return (
    <>
      {tree ? (
        <ExpressionBuilder
          fields={fields}
          value={tree}
          onChange={setFromTree}
        />
      ) : (
        !error && (
          <p className="text-[12px] text-muted-foreground">
            This expression nests deeper than the builder shows - edit it as
            text below.
          </p>
        )
      )}

      <div>
        <Textarea
          value={text}
          onChange={(e) => onTextEdit(e.target.value)}
          placeholder="e.g. status = active and due_date < 2026-09-01"
          className="min-h-16 font-mono text-[12.5px]"
        />
        {error && <p className="mt-1 text-[12px] text-destructive">{error}</p>}
      </div>
    </>
  )
}

/** Groups the builder nests, the root included. */
export const MAX_GROUPS = 3

/** A tree with at least one row to type into. */
export function withBlank(tree: TreeGroup | null): TreeGroup | null {
  if (!tree) return null
  return tree.items.length ? tree : { ...tree, items: [blankRule()] }
}

/** One field the builder offers. A list filter derives these from its rows;
 * compliance reads them from /api/compliance/fields/. */
export interface FieldSpec {
  key: string
  label?: string
  kind:
    | "string"
    | "number"
    | "boolean"
    | "bool"
    | "date"
    | "choice"
    | "ref"
    | "tags"
    | "type"
  /** The operators offered, in order; every scalar one by default. */
  ops?: BuilderOp[]
  /** Values seen in the rows, offered as the value's suggestions. */
  samples?: string[]
  /** Where a ref's values come from and how they draw. */
  ref?: {
    model: string
    api: string
    badge: "status" | "color" | ""
    noun: string
  } | null
  choices?: { value: string; label: string }[]
  /** The object types that have the field (compliance). */
  types?: string[]
}

/** What a page already knows about a referenced row (the rule's `refs`). */
export interface RefInfo {
  name: string | null
  color?: string
  missing?: boolean
  hidden?: boolean
}

const LIST_FILTER_OPS: BuilderOp[] = [
  "=",
  "!=",
  "~",
  "!~",
  ">",
  "<",
  ">=",
  "<=",
  "in",
  "not_in",
  "matches",
  "not_matches",
  "empty",
  "not_empty",
]

/** A list's discovered fields as builder specs: free values, row samples. */
export function fieldsFromRows(found: FieldInfo[]): FieldSpec[] {
  return found.map((f) => ({
    key: f.path,
    label: f.path,
    kind: f.kind,
    samples: f.samples,
  }))
}

const opsOf = (spec: FieldSpec | undefined): BuilderOp[] =>
  spec?.ops ?? LIST_FILTER_OPS

const TYPE_PLURAL: Record<string, string> = {
  prefix: "Prefixes",
  ipaddress: "IP addresses",
  device: "Devices",
  vlan: "VLANs",
  vrf: "VRFs",
  site: "Sites",
  virtualmachine: "VMs",
}

/** "Devices only" - for a field some of the chosen types lack. */
export function typesOnlyLabel(have: string[]): string {
  return `${have.map((t) => TYPE_PLURAL[t] ?? t).join(", ")} only`
}

interface BuilderContext {
  fields: FieldSpec[]
  /** The chosen object types; a field on fewer of them is marked. */
  types?: string[]
  /** Builder row or group id → the server's complaint about it. */
  errors?: Map<number, string>
  refs?: Record<string, RefInfo>
  maxGroups: number
}

/**
 * The visual expression builder: a tree of groups, each matching All or Any
 * of its rows and nested groups, up to `maxGroups` deep. Value controls follow
 * each field's kind - catalog rows and tags as their coloured pills, choices
 * from a list, dates as dates, free text with the values seen in the rows.
 */
export function ExpressionBuilder({
  fields,
  value,
  onChange,
  types,
  errors,
  refs,
  maxGroups = MAX_GROUPS,
  emptyText,
}: {
  fields: FieldSpec[]
  value: TreeGroup
  onChange: (next: TreeGroup) => void
  types?: string[]
  errors?: Map<number, string>
  refs?: Record<string, RefInfo>
  maxGroups?: number
  /** Shown while the root has no rows (e.g. "Every object"). */
  emptyText?: string
}) {
  const ctx: BuilderContext = { fields, types, errors, refs, maxGroups }
  return (
    <GroupEditor
      group={value}
      level={1}
      ctx={ctx}
      onChange={onChange}
      emptyText={emptyText}
    />
  )
}

const OP_WORD = { and: "and", or: "or" } as const

function GroupEditor({
  group,
  level,
  ctx,
  onChange,
  onRemove,
  emptyText,
}: {
  group: TreeGroup
  level: number
  ctx: BuilderContext
  onChange: (next: TreeGroup) => void
  onRemove?: () => void
  emptyText?: string
}) {
  const setItem = (id: number, next: TreeNode | null) =>
    onChange({
      ...group,
      items: next
        ? group.items.map((it) => (it.id === id ? next : it))
        : group.items.filter((it) => it.id !== id),
    })
  const error = ctx.errors?.get(group.id)
  const nested = level > 1

  return (
    <div
      className={cn(
        "space-y-2",
        nested && "rounded-lg border border-border p-2.5",
        error && "ring-1 ring-destructive"
      )}
      data-testid={`expr-group-${level}`}
    >
      {(group.items.length > 1 || nested) && (
        <div className="flex items-center gap-2">
          <SegmentedTabs
            items={[
              { value: "and", label: "All" },
              { value: "or", label: "Any" },
            ]}
            value={group.op}
            onValueChange={(op) => onChange({ ...group, op })}
          />
          <span className="text-[12px] whitespace-nowrap text-muted-foreground">
            of these
          </span>
          {onRemove && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Remove group"
              onClick={onRemove}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-[12px] text-destructive">{error}</p>}
      {group.items.length === 0 && emptyText && (
        <p className="text-[12px] text-muted-foreground">{emptyText}</p>
      )}
      {group.items.map((it, i) => (
        <div key={it.id}>
          {i > 0 && (
            <div className="mb-2 flex items-center gap-2">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                {OP_WORD[group.op]}
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}
          {it.kind === "group" ? (
            <GroupEditor
              group={it}
              level={level + 1}
              ctx={ctx}
              onChange={(next) => setItem(it.id, next)}
              onRemove={() => setItem(it.id, null)}
            />
          ) : (
            <RuleRow
              rule={it}
              ctx={ctx}
              onChange={(next) => setItem(it.id, next)}
              onRemove={() => setItem(it.id, null)}
            />
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({ ...group, items: [...group.items, blankRule()] })
          }
        >
          <Plus className="h-3.5 w-3.5" /> Condition
        </Button>
        {level < ctx.maxGroups && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange({
                ...group,
                items: [
                  ...group.items,
                  blankGroup(group.op === "and" ? "or" : "and"),
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" /> Group
          </Button>
        )}
      </div>
    </div>
  )
}

function RuleRow({
  rule,
  ctx,
  onChange,
  onRemove,
}: {
  rule: TreeRule
  ctx: BuilderContext
  onChange: (next: TreeRule) => void
  onRemove: () => void
}) {
  const spec = ctx.fields.find((f) => f.key === rule.field)
  const ops = opsOf(spec)
  const error = ctx.errors?.get(rule.id)
  const partial =
    spec?.types && ctx.types && ctx.types.length > 1
      ? ctx.types.filter((t) => spec.types!.includes(t))
      : null
  const marker =
    partial && ctx.types && partial.length < ctx.types.length
      ? typesOnlyLabel(partial)
      : null

  const pickField = (key: string) => {
    const next = ctx.fields.find((f) => f.key === key)
    const nextOps = opsOf(next)
    // A field of another kind keeps the operator only when it takes it.
    const cmp = nextOps.includes(rule.cmp) ? rule.cmp : nextOps[0]
    const sameKind = next?.kind === spec?.kind && next?.ref === spec?.ref
    onChange({
      ...rule,
      field: key,
      cmp,
      value: sameKind ? rule.value : "",
      values: sameKind ? rule.values : [],
    })
  }

  return (
    <div
      className={cn("rounded-md", error && "ring-1 ring-destructive")}
      data-testid="expr-row"
    >
      <div className="grid grid-cols-[10rem_8.5rem_minmax(0,1fr)_auto_2rem] items-center gap-1.5">
        {ctx.fields.length === 0 ? (
          <Input
            value={rule.field}
            onChange={(e) => onChange({ ...rule, field: e.target.value })}
            placeholder="Field"
            className="h-8 w-full font-mono text-[12px]"
          />
        ) : (
          <Select value={rule.field || undefined} onValueChange={pickField}>
            <SelectTrigger
              className="h-8 w-full text-[12px]"
              aria-label="Field"
            >
              <SelectValue placeholder="Field" />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {ctx.fields.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label ?? f.key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select
          value={rule.cmp}
          onValueChange={(v) => onChange({ ...rule, cmp: v as BuilderOp })}
        >
          <SelectTrigger
            className="h-8 w-full text-[12px]"
            aria-label="Operator"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(ops.includes(rule.cmp) ? ops : [rule.cmp, ...ops]).map((o) => (
              <SelectItem key={o} value={o}>
                {OP_LABELS[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isEmptyOp(rule.cmp) ? (
          <div />
        ) : (
          <RuleValue
            rule={rule}
            spec={spec}
            ctx={ctx}
            onChange={onChange}
            fieldChosen={
              ctx.fields.length === 0 ||
              ctx.fields.some((f) => f.key === rule.field)
            }
          />
        )}
        {marker ? (
          <Badge variant="outline" className="whitespace-nowrap">
            {marker}
          </Badge>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Remove condition"
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && (
        <p className="mt-1 px-1 text-[12px] text-destructive">{error}</p>
      )}
    </div>
  )
}

/** The value control a field's kind calls for. */
function RuleValue({
  rule,
  spec,
  ctx,
  onChange,
  fieldChosen,
}: {
  rule: TreeRule
  spec: FieldSpec | undefined
  ctx: BuilderContext
  onChange: (next: TreeRule) => void
  fieldChosen: boolean
}) {
  const setValue = (value: string) => onChange({ ...rule, value })
  const setValues = (values: string[]) => onChange({ ...rule, values })
  const kind = spec?.kind

  if (isListOp(rule.cmp)) {
    const values = rule.values ?? []
    if (spec?.ref)
      return (
        <RefValues
          spec={spec}
          values={values}
          onChange={setValues}
          refs={ctx.refs}
        />
      )
    if (spec?.choices?.length)
      return (
        <PillValues
          values={values}
          onChange={setValues}
          options={spec.choices.map((c) => ({
            value: c.value,
            label: c.label,
          }))}
        />
      )
    // A list filter's free values, comma-separated.
    return (
      <Input
        value={values.join(", ")}
        onChange={(e) =>
          setValues(
            e.target.value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean)
          )
        }
        placeholder="Values, comma-separated"
        className="h-8 min-w-0 flex-1 text-[12px]"
      />
    )
  }
  if (rule.cmp === "matches" || rule.cmp === "not_matches")
    return (
      <Input
        value={rule.value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Pattern"
        className="h-8 min-w-0 flex-1 font-mono text-[12px]"
      />
    )
  if (kind === "date")
    return (
      <Input
        type="date"
        value={rule.value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Date"
        className="h-8 min-w-0 flex-1 text-[12px]"
      />
    )
  if (kind === "bool")
    return (
      <Select value={rule.value || undefined} onValueChange={setValue}>
        <SelectTrigger className="h-8 w-full text-[12px]" aria-label="Value">
          <SelectValue placeholder="Value" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    )
  if (kind === "number" && !spec?.samples?.length)
    return (
      <Input
        type="number"
        value={rule.value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Value"
        className="h-8 min-w-0 flex-1 text-[12px]"
      />
    )
  return (
    <ValueField
      value={rule.value}
      onChange={setValue}
      samples={spec?.samples ?? []}
      fieldChosen={fieldChosen}
    />
  )
}

interface PillOption {
  value: string
  label: string
  color?: string | null
  status?: boolean
}

/** Picked values as pills, each removable, and a picker to add one more. */
function PillValues({
  values,
  onChange,
  options,
  known,
  loading,
  noun = "value",
}: {
  values: string[]
  onChange: (next: string[]) => void
  options: PillOption[]
  /** Labels for picked values the options lack (a row now hidden). */
  known?: Record<string, PillOption>
  loading?: boolean
  noun?: string
}) {
  const byValue = new Map(options.map((o) => [o.value, o]))
  const left = options.filter((o) => !values.includes(o.value))
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {values.map((v) => {
        const o = byValue.get(v) ?? known?.[v]
        const name = o?.label ?? "Unknown"
        return (
          <span key={v} className="inline-flex items-center gap-0.5">
            {o?.status ? (
              <StatusBadge
                status={{ id: v, name, color: o.color ?? "" } as StatusMini}
              />
            ) : (
              <ColorBadge name={name} color={o?.color || undefined} />
            )}
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${name}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )
      })}
      <Combobox
        value={null}
        onChange={(v) => v && onChange([...values, v])}
        options={left.map((o) => ({
          value: o.value,
          label: o.label,
          color: o.color ?? null,
          badge: true,
        }))}
        placeholder={loading ? "Loading…" : values.length ? "Add…" : "Pick…"}
        searchPlaceholder={`Search ${noun}s…`}
        aria-label={`Add ${noun}`}
        className="h-8 w-28 text-[12px]"
      />
    </div>
  )
}

interface RefRow {
  id: string
  name?: string
  display?: string
  model?: string
  slug?: string
  color?: string
}

/** A catalog field's values: the rows as their pills (statuses as status
 * pills, coloured catalogs in their colour), read from the catalog's own list
 * endpoint so its access rules apply. */
function RefValues({
  spec,
  values,
  onChange,
  refs,
}: {
  spec: FieldSpec
  values: string[]
  onChange: (next: string[]) => void
  refs?: Record<string, RefInfo>
}) {
  const ref = spec.ref!
  const q = useQuery({
    queryKey: ["expr-ref-options", ref.api],
    queryFn: () => apiAll<RefRow>(ref.api),
    staleTime: 5 * 60_000,
  })
  const colored = ref.badge !== ""
  const options: PillOption[] = (q.data?.results ?? []).map((r) => ({
    value: String(r.id),
    label: r.name ?? r.display ?? r.model ?? r.slug ?? String(r.id),
    color: colored ? r.color || null : null,
    status: ref.badge === "status",
  }))
  const known: Record<string, PillOption> = {}
  for (const [id, info] of Object.entries(refs ?? {}))
    known[id] = {
      value: id,
      label: info.hidden
        ? "Hidden"
        : info.missing
          ? "Deleted"
          : (info.name ?? "Unknown"),
      color: colored ? info.color || null : null,
      status: ref.badge === "status",
    }
  return (
    <PillValues
      values={values}
      onChange={onChange}
      options={options}
      known={known}
      loading={q.isLoading}
      noun={ref.noun}
    />
  )
}

/** The value input as a combobox: focusing it opens the values actually
 * present in this list, typing narrows them, and free text always wins.
 * Values are per-field, so the box directs to the field picker first. */
function ValueField({
  value,
  onChange,
  samples,
  fieldChosen,
}: {
  value: string
  onChange: (v: string) => void
  samples: string[]
  fieldChosen: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const q = value.trim().toLowerCase()
  const narrowed = q
    ? samples.filter((s) => s.toLowerCase().includes(q))
    : samples
  // Typed text that matches nothing (or exactly one pick) keeps the full list
  // visible - the point of the picker is seeing what exists.
  const exhausted =
    narrowed.length === 0 || (narrowed.length === 1 && narrowed[0] === value)
  const shown = exhausted ? samples : narrowed

  if (!fieldChosen || samples.length === 0)
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={fieldChosen ? "Value" : "Pick a field first"}
        className="h-8 min-w-0 flex-1 text-[12px]"
      />
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="relative flex min-w-0 flex-1">
          <Input
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            // A second click on an already-focused input fires no focus event -
            // pointerdown covers reopening.
            onPointerDown={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false)
            }}
            placeholder="Value"
            className="h-8 min-w-0 flex-1 pr-7 text-[12px]"
          />
          <button
            type="button"
            tabIndex={-1}
            className="absolute inset-y-0 right-1.5 flex items-center text-muted-foreground hover:text-foreground"
            title="Values in this list"
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        // `block`, because PopoverContent is a flex column by default: as its
        // own scroll container the option rows became flex items, and once the
        // list outgrew max-h they shrank to nothing instead of scrolling - an
        // empty panel with a scrollbar (#117).
        className="block max-h-56 w-60 overflow-y-auto p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // The click that focuses the input is "outside" the content - without
        // this guard the popover opens on focus and closes on the same click.
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault()
        }}
      >
        {q && narrowed.length === 0 && (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
            No value contains "{value.trim()}" - free text still applies.
          </p>
        )}
        {shown.map((s) => (
          <button
            key={s}
            type="button"
            className="block w-full truncate rounded-md px-2 py-1 text-left text-[12px] hover:bg-accent"
            onClick={() => {
              onChange(s)
              setOpen(false)
            }}
          >
            {s}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** The grammar on a card, so nobody has to find the docs mid-filter. */
function OperatorsHint() {
  const row = (op: string, what: string) => (
    <>
      <code className="font-mono text-[11px] font-semibold whitespace-nowrap text-foreground">
        {op}
      </code>
      <span className="text-muted-foreground">{what}</span>
    </>
  )
  return (
    <HoverCard openDelay={100}>
      <HoverCardTrigger asChild>
        {/* tabIndex -1: the dialog focuses its first tabbable element on open,
            and a focused trigger opens the card - which made the reference
            cover the dialog before the pointer ever moved. */}
        <button
          type="button"
          tabIndex={-1}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Operator reference"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 text-xs">
        <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5">
          {row("=  !=", "equals / not equals")}
          {row("~  !~", "contains / does not contain (case-insensitive)")}
          {row("in (a, b)", "is any of the values; not in for none of them")}
          {row("matches", "regular expression; not matches for the reverse")}
          {row("<  >  <=  >=", "compare numbers and dates")}
          {row("is empty", "field has no value (is not empty for the reverse)")}
          {row("and  or", "combine conditions; and binds tighter, ( ) group")}
          {row("new line", "one condition per line reads as and")}
          {row("site.name", "dotted paths reach related objects")}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          On list fields like tags, <code className="font-mono">~</code> matches
          any element; <code className="font-mono">!~</code> must hold for all
          of them.
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}
