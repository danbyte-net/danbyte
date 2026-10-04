import type { ColumnDef } from "@tanstack/react-table"
import type { QueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { SortHeader } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { TruncatedText } from "@/components/ui/truncated-text"
import { ColorBadge } from "@/components/cells/color-badge"
import { ColorValueCell } from "@/components/cells/color-value-cell"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { dash } from "@/components/cells/dash"
import {
  formatCustomValue,
  hasCustomValue,
  loadObjectLabel,
  objectLabelKey,
  objectRefId,
} from "@/components/custom-field-display"
import type { ObjectLabel } from "@/components/custom-field-display"
import type { ListCustomField, ListField } from "@/lib/list-fields"
import { objectDetailRoute } from "@/lib/object-routes"
import { useDateFormat } from "@/lib/datetime"
import { useMe } from "@/lib/use-me"
import type { Tag } from "@/lib/api"

// Columns nobody hand-wrote (#243). DataTable asks the list-column catalog
// (lib/list-fields.ts) what a list's rows carry and offers each field - and
// each custom field - as a column: hidden until ticked in the Columns menu,
// sortable, exported, and rendered by what kind of value it is. A factory
// column always wins; these only fill in what no factory covers.

type Row = Record<string, unknown>

/** `row` followed down a dotted `path`; undefined past a missing segment. */
export function getPath(row: unknown, path: string): unknown {
  let v: unknown = row
  for (const part of path.split(".")) {
    if (v == null || typeof v !== "object") return undefined
    v = (v as Row)[part]
  }
  return v
}

// The backend's list_fields.NAME_KEYS reads the same keys.
const NAME_KEYS = [
  "name",
  "label",
  "display",
  "cidr",
  "ip_address",
  "prefix",
  "address",
  "mac_address",
  "cid",
  "username",
  "slug",
  "asn",
]

/** The text an object-shaped value reads as ("HQ", "10.0.0.0/24"). */
export function objectName(v: unknown): string {
  if (v == null) return ""
  if (typeof v !== "object") return String(v)
  const o = v as Row
  for (const k of NAME_KEYS) {
    const x = o[k]
    if (x != null && x !== "" && typeof x !== "object") return String(x)
  }
  return ""
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_A_PART = /^(id|numid|slug|color)$|_(id|at|color)$/

/** What a single record with no name of its own reads as: its first few
 * words - text values and the names of the records it points at, skipping
 * ids, timestamps and colour-carrying catalogs (a status describes a
 * record, it does not name it). A link peer reads "sw1 · Gi1/0/1", a BGP
 * instance "core1 · 64599", an unlabelled cable "#50". */
function objectSummary(o: Row): string {
  const parts: string[] = []
  for (const [k, x] of Object.entries(o)) {
    if (parts.length === 3) break
    if (NOT_A_PART.test(k) || x == null || x === "") continue
    if (typeof x === "string") {
      if (!UUID.test(x)) parts.push(x)
    } else if (typeof x === "object" && !Array.isArray(x) && !("color" in x)) {
      const n = objectName(x)
      if (n) parts.push(n)
    }
  }
  if (parts.length) return parts.join(" · ")
  return typeof o.numid === "number" ? `#${o.numid}` : ""
}

/** The text one object-shaped value reads as: its name, else a summary of
 * it. Items of a list use `objectName` alone - a list of records with no
 * name has nothing a cell can say. */
export function objectText(v: unknown): string {
  const name = objectName(v)
  if (name || v == null || typeof v !== "object" || Array.isArray(v))
    return name
  return objectSummary(v as Row)
}

function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  )
}

/** A resolver for choice labels: inline options first, then a named
 * /api/dcim/choices/ list. */
export type ChoiceLabel = (field: ListField, value: string) => string

export const inlineChoiceLabel: ChoiceLabel = (field, value) =>
  field.options?.find((o) => String(o.value) === value)?.label ?? value

/** Plain text for a catalog value - what an export writes. */
export function autoText(
  field: ListField,
  v: unknown,
  choiceLabel: ChoiceLabel = inlineChoiceLabel
): string {
  if (isEmpty(v)) return ""
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (
    field.kind === "choice" &&
    (typeof v === "string" || typeof v === "number")
  )
    return choiceLabel(field, String(v))
  if (Array.isArray(v))
    return v
      .map((x) => objectName(x))
      .filter(Boolean)
      .join(", ")
  if (typeof v === "object") return objectText(v)
  return String(v)
}

/** What a catalog column sorts by: numbers by value, the rest as text (the
 * table's natural sort); empty is undefined so it sorts last. */
export function autoSortValue(
  field: ListField,
  v: unknown,
  choiceLabel: ChoiceLabel = inlineChoiceLabel
): string | number | undefined {
  if (isEmpty(v)) return undefined
  if (field.kind === "choice")
    return autoText(field, v, choiceLabel) || undefined
  if (typeof v === "number") return v
  if (typeof v === "boolean") return v ? 1 : 0
  if (field.kind === "number") {
    const n = Number(v)
    return Number.isFinite(n) ? n : String(v)
  }
  return autoText(field, v, choiceLabel) || undefined
}

function relatedSlug(related?: string): string | undefined {
  return related?.split(".")[1]
}

/** One object value: a colour badge when it carries a colour (statuses,
 * roles, zones), else its name - linked to its page when it has one and you
 * may view it. `item` is one of a list, which reads by its name alone. */
function ObjectRef({
  value,
  related,
  item,
}: {
  value: unknown
  related?: string
  item?: boolean
}) {
  const { canDo } = useMe()
  if (value == null || typeof value !== "object")
    return value == null ? dash : <span>{String(value)}</span>
  const o = value as Row
  const name = item ? objectName(o) : objectText(o)
  if (!name) return dash
  const id = typeof o.id === "string" ? o.id : undefined
  const route = related ? objectDetailRoute(related) : undefined
  const slug = relatedSlug(related)
  const to =
    route && id && (!slug || canDo(slug, "view"))
      ? route.replace("$id", id)
      : undefined
  const color = typeof o.color === "string" ? o.color : undefined
  const body =
    color !== undefined || related === "api.status" ? (
      <ColorBadge name={name} color={color || undefined} />
    ) : (
      <span>{name}</span>
    )
  if (!to) return body
  return (
    <Link to={to as "/"} className="link">
      {body}
    </Link>
  )
}

function DateText({ value }: { value: string }) {
  const { formatDate } = useDateFormat()
  return <span className="num">{formatDate(value)}</span>
}

const MAX_OBJECTS = 3

/** The cell for a catalog value, chosen by the field's kind and, where the
 * kind is `auto`, by the value's own shape. */
export function AutoCell({
  field,
  value,
  choiceLabel = inlineChoiceLabel,
}: {
  field: ListField
  value: unknown
  choiceLabel?: ChoiceLabel
}) {
  if (isEmpty(value)) return dash
  if (typeof value === "boolean" || field.kind === "bool")
    return <Badge variant="secondary">{value ? "Yes" : "No"}</Badge>
  if (field.kind === "tags" && Array.isArray(value))
    return <TagList tags={value as Tag[]} inline />
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_OBJECTS)
    const more = value.length - shown.length
    return (
      <span className="inline-flex items-center gap-1">
        {shown.map((x, i) => (
          <span key={i} className="inline-flex items-center">
            <ObjectRef value={x} related={field.related} item />
            {i < shown.length - 1 && <span>,</span>}
          </span>
        ))}
        {more > 0 && <Badge variant="secondary">+{more}</Badge>}
      </span>
    )
  }
  if (typeof value === "object")
    return <ObjectRef value={value} related={field.related} />
  const text = String(value)
  switch (field.kind) {
    case "number":
      return <span className="num">{text}</span>
    case "ip":
      return <span className="font-mono text-xs">{text}</span>
    case "datetime":
      return <TimeCell iso={text} />
    case "date":
      return <DateText value={text} />
    case "color":
      return <ColorValueCell color={text} />
    case "choice":
      return <span>{choiceLabel(field, text)}</span>
    case "longtext":
      return (
        <TruncatedText className="block max-w-[24rem] text-muted-foreground">
          {text}
        </TruncatedText>
      )
    default:
      return typeof value === "number" ? (
        <span className="num">{text}</span>
      ) : (
        <span>{text}</span>
      )
  }
}

export interface AutoColumnOpts<T> {
  /** The catalog-shaped object inside a row, when rows wrap it (the prefix
   * IP table's rows are `{kind, ip}`); undefined skips the row. */
  get?: (row: T) => unknown
  /** Header click sorts (off for server-sorted tables). */
  sortable?: boolean
  choiceLabel?: ChoiceLabel
}

/** One hidden-by-default column per catalog field. The id is the field's
 * key, so a saved layout that ticked it keeps it even if a factory later
 * hand-writes the same field. */
export function listFieldColumns<T>(
  fields: ListField[],
  opts: AutoColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const get = opts.get ?? ((r: T) => r)
  const sortable = opts.sortable !== false
  const choiceLabel = opts.choiceLabel ?? inlineChoiceLabel
  return fields.map((f) => {
    const path = f.path ?? f.key
    const valueOf = (r: T) => getPath(get(r), path)
    return {
      id: f.key,
      accessorFn: (r: T) => autoSortValue(f, valueOf(r), choiceLabel),
      header: sortable
        ? ({ column }) => <SortHeader column={column} label={f.label} />
        : f.label,
      enableSorting: sortable,
      enableGlobalFilter: false,
      sortUndefined: "last",
      cell: ({ row }) => (
        <AutoCell
          field={f}
          value={valueOf(row.original)}
          choiceLabel={choiceLabel}
        />
      ),
      meta: {
        label: f.label,
        group: f.group,
        defaultHidden: true,
        field: f.key,
        export: {
          header: f.label,
          value: (r: T) => autoText(f, valueOf(r), choiceLabel),
        },
      },
    } satisfies ColumnDef<T, unknown>
  })
}

// ─── Custom-field columns ────────────────────────────────────────────────

type CfDef = Pick<ListCustomField, "key" | "label" | "type" | "related_model">

function cfValue<T>(get: (r: T) => unknown, r: T, key: string): unknown {
  const o = get(r)
  if (!o || typeof o !== "object") return undefined
  const cfs = (o as Row).custom_fields
  return cfs && typeof cfs === "object" ? (cfs as Row)[key] : undefined
}

/** Stable facet bucket for a custom-field value (null = not counted). */
export function cfFacetKey(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (Array.isArray(v)) return v.map(String).join(", ")
  return String(v)
}

/** A custom-field value as plain text: Yes/No, joined selections, an object
 * reference's label when it is known (else its id). */
export function customValueText(
  def: CfDef,
  v: unknown,
  objectLabel?: (slug: string, id: string) => string | undefined
): string {
  if (!hasCustomValue(v)) return ""
  if (def.type === "boolean" || typeof v === "boolean") return v ? "Yes" : "No"
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ")
  if (def.type === "object") {
    const id = objectRefId(v)
    return (def.related_model && objectLabel?.(def.related_model, id)) || id
  }
  if (typeof v === "object") return objectName(v)
  return String(v)
}

/** What a custom-field column sorts by: numbers (a decimal may be stored as
 * a string) by value, dates by their ISO text, the rest naturally. */
export function customSortValue(
  def: CfDef,
  v: unknown
): string | number | undefined {
  if (!hasCustomValue(v)) return undefined
  if (def.type === "integer" || def.type === "decimal") {
    const n = typeof v === "number" ? v : parseFloat(String(v))
    return Number.isFinite(n) ? n : undefined
  }
  if (def.type === "boolean" || typeof v === "boolean") return v ? 1 : 0
  return customValueText(def, v) || undefined
}

function CustomValueCell({ def, value }: { def: CfDef; value: unknown }) {
  if (!hasCustomValue(value)) return dash
  if (def.type === "date" && typeof value === "string")
    return <DateText value={value} />
  if (def.type === "textarea")
    return (
      <TruncatedText className="block max-w-[24rem]">
        {String(value)}
      </TruncatedText>
    )
  return <>{formatCustomValue(def, value)}</>
}

export interface CustomFieldColumnOpts<T> {
  /** The object carrying `custom_fields` inside a row (default: the row). */
  get?: (row: T) => unknown
  /** An enum facet over the observed values, for pages with a filter rail. */
  facet?: boolean
  defaultHidden?: boolean
  sortable?: boolean
  /** Lets exports write an object reference's label instead of its id. */
  queryClient?: QueryClient
}

/** One column per custom-field definition, id `cf_<key>`. */
export function customFieldColumns<T>(
  defs: CfDef[],
  opts: CustomFieldColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const get = opts.get ?? ((r: T) => r)
  const sortable = opts.sortable !== false
  const qc = opts.queryClient
  const labelOf = (slug: string, id: string) =>
    qc?.getQueryData<ObjectLabel | null>(objectLabelKey(slug, id))?.label
  return defs.map((d) => {
    const canSort = sortable && d.type !== "object"
    const col: ColumnDef<T, unknown> = {
      id: `cf_${d.key}`,
      accessorFn: (r: T) => customSortValue(d, cfValue(get, r, d.key)),
      header: canSort
        ? ({ column }) => <SortHeader column={column} label={d.label} />
        : d.label,
      enableSorting: canSort,
      enableGlobalFilter: false,
      sortUndefined: "last",
      cell: ({ row }) =>
        get(row.original) ? (
          <CustomValueCell def={d} value={cfValue(get, row.original, d.key)} />
        ) : null,
      meta: {
        label: d.label,
        group: "custom",
        defaultHidden: opts.defaultHidden,
        field: `custom_fields.${d.key}`,
        facet: opts.facet
          ? {
              kind: "enum",
              label: d.label,
              get: (r: T) =>
                get(r) ? cfFacetKey(cfValue(get, r, d.key)) : null,
            }
          : undefined,
        export: {
          header: d.label,
          value: (r: T) => customValueText(d, cfValue(get, r, d.key), labelOf),
        },
        prepareExport:
          d.type === "object" && d.related_model && qc
            ? async (rows: T[]) => {
                const ids = new Set<string>()
                for (const r of rows) {
                  const v = cfValue(get, r, d.key)
                  if (hasCustomValue(v)) ids.add(objectRefId(v))
                }
                await Promise.all(
                  [...ids].map((id) =>
                    qc.fetchQuery({
                      queryKey: objectLabelKey(d.related_model, id),
                      queryFn: () => loadObjectLabel(d.related_model, id),
                      staleTime: 5 * 60_000,
                    })
                  )
                )
              }
            : undefined,
      },
    }
    return col
  })
}

// ─── Merging into a table's own columns ──────────────────────────────────

/** Row keys a factory column already shows: its id, its accessorKey and any
 * `meta.field`, plus the timestamp aliases every factory uses. */
export function coveredKeys<T>(columns: ColumnDef<T, unknown>[]): Set<string> {
  const out = new Set<string>()
  for (const c of columns) {
    if (c.id) out.add(c.id)
    const key = (c as { accessorKey?: string }).accessorKey
    if (key) out.add(key)
    const f = c.meta?.field
    for (const k of Array.isArray(f) ? f : f ? [f] : []) out.add(k)
  }
  if (out.has("updated")) out.add("updated_at")
  if (out.has("created")) out.add("created_at")
  return out
}

/** `extra` columns not covered by `base`, inserted before its trailing
 * pinned columns (the row actions stay last). */
export function mergeAutoColumns<T>(
  base: ColumnDef<T, unknown>[],
  extra: ColumnDef<T, unknown>[],
  exclude: string[] = []
): ColumnDef<T, unknown>[] {
  if (!extra.length) return base
  const covered = coveredKeys(base)
  for (const k of exclude) covered.add(k)
  const add = extra.filter((c) => {
    const f = c.meta?.field
    const key = Array.isArray(f) ? f[0] : f
    return !covered.has(c.id ?? "") && !(key && covered.has(key))
  })
  if (!add.length) return base
  let at = base.length
  while (at > 0 && base[at - 1].enableHiding === false) at--
  return [...base.slice(0, at), ...add, ...base.slice(at)]
}

/** Top-level keys present on the catalog objects of the first rows - a field
 * is offered only when the rows really carry it (a mis-registered table then
 * offers nothing rather than empty columns). `seen` persists across calls so
 * an empty filter result does not make columns vanish. */
export function collectRowKeys<T>(
  rows: T[],
  get: (row: T) => unknown,
  seen: Set<string>,
  limit = 50
): Set<string> {
  for (const r of rows.slice(0, limit)) {
    const o = get(r)
    if (o && typeof o === "object") for (const k of Object.keys(o)) seen.add(k)
  }
  return seen
}

/** Catalog fields whose values read as nothing: every value seen so far
 * that is not empty renders no text (a figure set, a list of records with no
 * name), so a column of them would be a column of dashes. `readable` and
 * `unreadable` persist across calls, like `collectRowKeys`' `seen`; one
 * readable value keeps a field for good. */
export function unreadableFields<T>(
  fields: ListField[],
  rows: T[],
  get: (row: T) => unknown,
  readable: Set<string>,
  unreadable: Set<string>,
  limit = 50
): string[] {
  const sample = rows.slice(0, limit)
  for (const f of fields) {
    if (readable.has(f.key)) continue
    const path = f.path ?? f.key
    for (const r of sample) {
      const v = getPath(get(r), path)
      if (isEmpty(v)) continue
      if (autoText(f, v)) {
        readable.add(f.key)
        break
      }
      unreadable.add(f.key)
    }
  }
  return [...unreadable].filter((k) => !readable.has(k)).sort()
}

/** The custom-field keys any of the first rows holds a value for. */
export function hasCustomFieldsKey(seen: Set<string>): boolean {
  return seen.has("custom_fields")
}
