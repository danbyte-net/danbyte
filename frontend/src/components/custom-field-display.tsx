import type React from "react"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"

import { Link } from "@tanstack/react-router"

import { api, type CustomField, type Paginated } from "@/lib/api"
import { groupCustomFields, UNGROUPED_KEY } from "@/lib/custom-fields"
import { Badge } from "@/components/ui/badge"
import { KvCard } from "@/components/kv-card"
import { cn } from "@/lib/utils"

// Shared fetch of a model's custom-field definitions (cached per model).
export function useCustomFieldDefs(model: string) {
  return useQuery({
    queryKey: ["custom-fields-for", model],
    queryFn: () =>
      api<Paginated<CustomField>>(`/api/custom-fields/?model=${model}`),
    staleTime: 5 * 60_000,
  })
}

export function hasCustomValue(v: unknown): boolean {
  return !(
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  )
}

// Render a stored custom-field value, formatted by its definition's type.
export function formatCustomValue(
  def: CustomField | undefined,
  v: unknown
): React.ReactNode {
  if (!hasCustomValue(v))
    return <span className="text-muted-foreground">—</span>
  const type = def?.type
  if (type === "boolean" || typeof v === "boolean") {
    return <Badge variant="secondary">{v ? "Yes" : "No"}</Badge>
  }
  if (type === "multiselect" || Array.isArray(v)) {
    const arr = Array.isArray(v) ? v : [v]
    return (
      <span className="flex flex-wrap gap-1">
        {arr.map((x, i) => (
          <span
            key={i}
            className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px]"
          >
            {String(x)}
          </span>
        ))}
      </span>
    )
  }
  if (type === "url") {
    return (
      <a
        href={String(v)}
        target="_blank"
        rel="noreferrer"
        className="text-primary hover:underline"
      >
        {String(v)}
      </a>
    )
  }
  if (type === "integer" || type === "decimal" || typeof v === "number") {
    return <span className="num">{String(v)}</span>
  }
  if (type === "object" && def?.related_model) {
    // The stored value may be a bare id OR a serialized object dict — pull the
    // id out either way so we never pass "[object Object]" to ObjectValue.
    const id =
      v && typeof v === "object"
        ? String((v as Record<string, unknown>).id ?? "")
        : String(v)
    if (id) return <ObjectValue slug={def.related_model} id={id} />
  }
  // Any object value (e.g. a MAC/related dict on a field whose def we couldn't
  // resolve) — show a sensible label instead of "[object Object]".
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    const label =
      o.name ?? o.label ?? o.display ?? o.mac_address ?? o.address ?? o.value
    return <span>{label != null ? String(label) : JSON.stringify(v)}</span>
  }
  return <span>{String(v)}</span>
}

/** Resolve a stored object-reference id to its label (+ link when the model
 * has a detail route) via the bulk label endpoint. */
function ObjectValue({ slug, id }: { slug: string; id: string }) {
  const q = useQuery({
    queryKey: ["cf-object-label", slug, id],
    queryFn: () =>
      api<{ results: { id: string; label: string; route: string | null }[] }>(
        `/api/customization/object-labels/?model=${slug}&ids=${id}`
      ),
    staleTime: 5 * 60_000,
  })
  const hit = q.data?.results[0]
  if (!hit)
    return (
      <span className="font-mono text-[11px] text-muted-foreground">
        {q.isLoading ? "…" : id}
      </span>
    )
  if (hit.route)
    return (
      <Link to={hit.route as "/"} className="text-primary hover:underline">
        {hit.label}
      </Link>
    )
  return <span>{hit.label}</span>
}

export interface CustomFieldValuesProps {
  model: string
  values: Record<string, unknown> | null | undefined
  /** How to render. "strip" (default) is the full-width bordered section used at
   * the bottom of most detail pages. "cards" renders each group as a titled
   * KvCard table so it sits in a detail page's card grid like the other tables. */
  layout?: "strip" | "cards"
}

type Row = { key: string; label: string; node: React.ReactNode }

// Detail-page strip of labeled custom-field values, split into sections by the
// fields' groups. Renders nothing when no field carries a value. Named groups
// are collapsible (and start collapsed when their group says so); the default
// "Custom fields" section is always open, matching the pre-groups behaviour.
export function CustomFieldValues({
  model,
  values,
  layout = "strip",
}: CustomFieldValuesProps) {
  const q = useCustomFieldDefs(model)
  const defs = q.data?.results ?? []
  const vals = values ?? {}
  const sections = groupCustomFields(defs)

  const rendered = sections.map((s) => ({
    ...s,
    rows: s.fields
      .filter((d) => hasCustomValue(vals[d.key]))
      .map<Row>((d) => ({
        key: d.key,
        label: d.label,
        node: formatCustomValue(d, vals[d.key]),
      })),
  }))

  // Stray keys with no matching definition (legacy / ad-hoc) show under the
  // default section.
  const seen = new Set(defs.map((d) => d.key))
  const strayRows: Row[] = Object.entries(vals)
    .filter(([k, v]) => !seen.has(k) && hasCustomValue(v))
    .map(([k, v]) => ({
      key: k,
      label: k,
      node: formatCustomValue(undefined, v),
    }))
  if (strayRows.length) {
    const ung = rendered.find((s) => s.key === UNGROUPED_KEY)
    if (ung) ung.rows.push(...strayRows)
    else
      rendered.unshift({
        key: UNGROUPED_KEY,
        title: "Custom fields",
        collapsed: false,
        fields: [],
        rows: strayRows,
      })
  }

  const visible = rendered.filter((s) => s.rows.length > 0)
  if (visible.length === 0) return null

  // Card layout: each group becomes a titled KvCard table, matching the other
  // detail-page cards so custom fields sit in the card grid, not a bottom strip.
  if (layout === "cards") {
    return (
      <>
        {visible.map((s) => (
          <KvCard
            key={s.key}
            title={s.title}
            rows={s.rows.map((r) => ({ label: r.label, value: r.node }))}
          />
        ))}
      </>
    )
  }

  return (
    <section className="shrink-0 space-y-4 border-b border-border px-6 py-4">
      {visible.map((s) => (
        <CustomFieldSectionView
          key={s.key}
          title={s.title}
          rows={s.rows}
          collapsible={s.key !== UNGROUPED_KEY}
          defaultCollapsed={s.collapsed}
        />
      ))}
    </section>
  )
}

function FieldGrid({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-[13px] sm:grid-cols-3 lg:grid-cols-4">
      {rows.map((r) => (
        <div key={r.key}>
          <dt className="text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
            {r.label}
          </dt>
          <dd className="mt-0.5">{r.node}</dd>
        </div>
      ))}
    </dl>
  )
}

function CustomFieldSectionView({
  title,
  rows,
  collapsible,
  defaultCollapsed,
}: {
  title: string
  rows: Row[]
  collapsible: boolean
  defaultCollapsed: boolean
}) {
  const [open, setOpen] = useState(!defaultCollapsed)
  if (!collapsible) {
    return (
      <div>
        <h2 className="mb-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h2>
        <FieldGrid rows={rows} />
      </div>
    )
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
      >
        <ChevronDown
          className={cn("size-3 transition-transform", !open && "-rotate-90")}
        />
        {title}
        <span className="text-muted-foreground/70">({rows.length})</span>
      </button>
      {open && <FieldGrid rows={rows} />}
    </div>
  )
}
