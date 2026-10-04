import { useQueries } from "@tanstack/react-query"
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react"

import { api } from "@/lib/api"
import type { CustomField, Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * An ordered field list and its "add a field" picker - the editor behind the
 * floor-plan tile popover and the topology card lines.
 *
 * The page owns the list and which scope it belongs to; this draws the rows
 * (up / down / remove) and the grouped chips that add a field. Custom fields
 * ride the generic `cf_<key>` convention: `useCustomFieldMeta` names them from
 * the tenant's own definitions and the page adds them as one more group.
 */

export interface FieldMeta {
  label: string
  hint: string
}

export interface FieldGroup {
  title: string
  keys: string[]
}

/** `cf_<key>` → its label and a hint naming the models it comes from. Each
 * model is its own query (shared with every other custom-field picker), and
 * a field defined on several models lists them all in its hint. */
export function useCustomFieldMeta(
  models: readonly string[],
  opts: { skipHidden?: boolean } = {}
): Partial<Record<string, FieldMeta>> {
  const results = useQueries({
    queries: models.map((model) => ({
      queryKey: ["custom-fields-for", model],
      queryFn: () =>
        api<Paginated<CustomField>>(`/api/custom-fields/?model=${model}`),
    })),
  })
  const out: Partial<Record<string, FieldMeta>> = {}
  models.forEach((where, i) => {
    for (const d of results[i]?.data?.results ?? []) {
      // A hidden field has nothing to show wherever the list is drawn.
      if (opts.skipHidden && d.hidden) continue
      const key = `cf_${d.key}`
      const prev = out[key]
      out[key] = prev
        ? { label: d.label, hint: `${prev.hint} · ${where}` }
        : { label: d.label, hint: `Custom field · ${where}` }
    }
  })
  return out
}

export function FieldListEditor({
  value,
  onChange,
  editable,
  meta,
  groups,
  available,
  insert = "append",
  empty,
  max,
}: {
  value: string[]
  onChange: (next: string[]) => void
  /** Off: a dimmed read-only preview, e.g. a list the scope inherits. */
  editable: boolean
  meta: (key: string) => FieldMeta
  /** The add picker. A key already in the list, or not in `available`, is
   * left out, and a group with nothing left is not drawn. */
  groups: FieldGroup[]
  /** Every key that may be added, in canonical order. */
  available: string[]
  /** Where an added key goes: last, or into `available`'s order (which also
   * sorts the list into that order). */
  insert?: "append" | "canonical"
  /** The row an empty list shows. */
  empty: React.ReactNode
  /** At this many fields the add chips turn off. */
  max?: number
}) {
  const full = max !== undefined && value.length >= max

  const add = (key: string) =>
    onChange(
      insert === "canonical"
        ? available.filter((k) => value.includes(k) || k === key)
        : [...value, key]
    )
  const remove = (key: string) => onChange(value.filter((k) => k !== key))
  const move = (key: string, delta: number) => {
    const next = [...value]
    const i = next.indexOf(key)
    const j = i + delta
    if (i < 0 || j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <>
      <ul className={cn("flex flex-col gap-1", !editable && "opacity-60")}>
        {value.map((key, i) => (
          <li
            key={key}
            className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="text-[13px] font-medium">{meta(key).label}</span>
              {meta(key).hint && (
                <span className="ml-2 text-[11px] text-muted-foreground">
                  {meta(key).hint}
                </span>
              )}
            </span>
            {editable && (
              <span className="flex shrink-0 items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  disabled={i === 0}
                  onClick={() => move(key, -1)}
                  aria-label={`Move ${meta(key).label} up`}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  disabled={i === value.length - 1}
                  onClick={() => move(key, 1)}
                  aria-label={`Move ${meta(key).label} down`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => remove(key)}
                  aria-label={`Remove ${meta(key).label}`}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </span>
            )}
          </li>
        ))}
        {value.length === 0 && (
          <li className="rounded-md border border-dashed border-border px-2 py-3 text-center text-[13px] text-muted-foreground">
            {empty}
          </li>
        )}
      </ul>

      {editable && (
        <div className="mt-4 space-y-3">
          {groups.map((g) => {
            const rest = g.keys.filter(
              (k) => !value.includes(k) && available.includes(k)
            )
            if (!rest.length) return null
            return (
              <div key={g.title}>
                <p className="mb-1.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                  {g.title}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {rest.map((key) => (
                    <AddChip
                      key={key}
                      meta={meta(key)}
                      disabled={full}
                      onClick={() => add(key)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function AddChip({
  meta,
  disabled,
  onClick,
}: {
  meta: FieldMeta
  disabled: boolean
  onClick: () => void
}) {
  const chip = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-[12px] whitespace-nowrap text-muted-foreground hover:border-solid hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <Plus className="h-3 w-3" />
      {meta.label}
    </button>
  )
  if (!meta.hint) return chip
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent variant="default">{meta.hint}</TooltipContent>
    </Tooltip>
  )
}

/** A small caps heading over a group of scopes ("Applies to", "Device
 * roles"). */
export function FieldScopeHeading({
  children,
  first = false,
}: {
  children: React.ReactNode
  /** The list's opening heading, with no gap above it. */
  first?: boolean
}) {
  return (
    <p
      className={cn(
        "mb-1 px-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase",
        !first && "mt-3"
      )}
    >
      {children}
    </p>
  )
}

/** One scope in the list beside the editor: what the list applies to, and a
 * "Custom" badge when that scope has a list of its own. */
export function FieldScopeRow({
  active,
  onSelect,
  badge,
  label,
  custom,
}: {
  active: boolean
  onSelect: () => void
  /** Drawn before the label - the object's own badge. */
  badge?: React.ReactNode
  label: React.ReactNode
  custom: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
        active ? "bg-muted font-medium" : "hover:bg-muted/60"
      )}
    >
      {badge}
      <span className="min-w-0 truncate">{label}</span>
      {custom && (
        <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px]">
          Custom
        </Badge>
      )}
    </button>
  )
}
