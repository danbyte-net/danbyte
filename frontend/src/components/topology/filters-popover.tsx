import { Filter } from "lucide-react"

import { BarMenuTrigger } from "@/components/map-toolbar"
import { Badge } from "@/components/ui/badge"
import { Combobox } from "@/components/ui/combobox"
import type { ComboboxOption } from "@/components/ui/combobox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/** The header's filters; "all" is the Any row. */
export interface TopologyFilterValues {
  site: string
  role: string
  status: string
  tag: string
}

/** A catalog row as the picker endpoints send it. */
export interface FilterCatalogRow {
  id: string
  name: string
  color?: string | null
}

/** A labelled row inside the header's Filters / Display popovers. */
export function PopoverField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <span className="text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  )
}

/** Searchable filter select ("all" ↔ the combobox's Any row) - the option
 * lists here (41 sites and counting) want type-to-filter. */
function FilterSelect({
  value,
  onChange,
  anyLabel,
  options,
}: {
  value: string
  onChange: (v: string) => void
  anyLabel: string
  options: ComboboxOption[]
}) {
  return (
    <Combobox
      value={value === "all" ? null : value}
      onChange={(v) => onChange(v ?? "all")}
      options={options}
      noneLabel={anyLabel}
      placeholder={anyLabel}
      className="h-8 w-full text-xs"
    />
  )
}

const plain = (rows: readonly FilterCatalogRow[] | undefined) =>
  (rows ?? []).map((r) => ({ value: r.id, label: r.name }))

/** Roles and statuses keep their pills here, as they do in every table. */
const colored = (rows: readonly FilterCatalogRow[] | undefined) =>
  (rows ?? []).map((r) => ({
    value: r.id,
    label: r.name,
    color: r.color || null,
  }))

/**
 * The header's Filters: Site, Role, Status and Tag, each with an Any row.
 * The trigger counts the filters in force.
 */
export function TopologyFilters({
  value,
  onChange,
  sites,
  roles,
  statuses,
  tags,
}: {
  value: TopologyFilterValues
  onChange: (patch: Partial<TopologyFilterValues>) => void
  sites?: readonly FilterCatalogRow[]
  roles?: readonly FilterCatalogRow[]
  statuses?: readonly FilterCatalogRow[]
  /** Tags filter by slug. */
  tags?: readonly { name: string; slug: string }[]
}) {
  const active = [value.site, value.role, value.status, value.tag].filter(
    (v) => v !== "all"
  ).length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BarMenuTrigger>
          <Filter /> Filters
          {active > 0 && (
            <Badge variant="secondary" className="num h-4 px-1 text-[10px]">
              {active}
            </Badge>
          )}
        </BarMenuTrigger>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3 p-3">
        <PopoverField label="Site">
          <FilterSelect
            value={value.site}
            onChange={(v) => onChange({ site: v })}
            anyLabel="Any site"
            options={plain(sites)}
          />
        </PopoverField>
        <PopoverField label="Role">
          <FilterSelect
            value={value.role}
            onChange={(v) => onChange({ role: v })}
            anyLabel="Any role"
            options={colored(roles)}
          />
        </PopoverField>
        <PopoverField label="Status">
          <FilterSelect
            value={value.status}
            onChange={(v) => onChange({ status: v })}
            anyLabel="Any status"
            options={colored(statuses)}
          />
        </PopoverField>
        <PopoverField label="Tag">
          <FilterSelect
            value={value.tag}
            onChange={(v) => onChange({ tag: v })}
            anyLabel="Any tag"
            options={(tags ?? []).map((t) => ({
              value: t.slug,
              label: t.name,
            }))}
          />
        </PopoverField>
      </PopoverContent>
    </Popover>
  )
}
