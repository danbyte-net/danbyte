import type { ColumnDef } from "@tanstack/react-table"

import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { useDcimChoices } from "@/lib/use-dcim-choices"

// Canonical "how is this hardware cooled" cell + column (#434), for the
// device, device-type and module-type lists. A cooling method is a plain
// vocabulary, not a coloured catalog object: it reads as text.
//
//   <CoolingMethodText value="liquid" />           → Liquid
//   coolingMethodColumn<Device>({ get: (d) => d.effective_cooling_method })

/** A cooling method's or a rack capability's label: "Liquid" for `liquid`.
 * The API's lists label each value with the word capitalised, so this reads
 * the same before they load and where no hook can run (facets, exports). */
export function coolingLabel(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : ""
}

/** A cooling method - or, with `list`, a rack's capability - as the API's
 * choice list names it; a dash when blank. */
export function CoolingMethodText({
  value,
  list = "cooling_method",
  className,
}: {
  value: string | null | undefined
  list?: "cooling_method" | "cooling_capability"
  className?: string
}) {
  const choices = useDcimChoices()
  if (!value) return dash
  const known = choices[list].find((c) => c.value === value)
  return (
    <span className={className}>{known?.label ?? coolingLabel(value)}</span>
  )
}

export interface CoolingMethodColumnOpts<T> {
  id?: string
  header?: string
  get: (row: T) => string | null | undefined
  /** The row keys it shows, so the Columns menu does not offer them twice. */
  field?: string | string[]
}

/** The **Cooling** column: hidden until ticked, sorted and faceted by the
 * method (the facet keeps out of the rail while every row reads the same). */
export function coolingMethodColumn<T>(
  opts: CoolingMethodColumnOpts<T>
): ColumnDef<T, unknown> {
  const header = opts.header ?? "Cooling"
  return {
    id: opts.id ?? "cooling",
    accessorFn: (r) => opts.get(r) ?? "",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <CoolingMethodText value={opts.get(row.original)} className="text-xs" />
    ),
    meta: {
      label: header,
      defaultHidden: true,
      field: opts.field,
      export: { value: (r: T) => coolingLabel(opts.get(r) ?? "") },
      facet: {
        kind: "enum",
        label: header,
        get: (r: T) => opts.get(r) || "__none__",
        formatValue: (v) => ({
          label: v === "__none__" ? "Not set" : coolingLabel(v),
        }),
        hideWhenSingle: true,
      },
    },
  }
}
