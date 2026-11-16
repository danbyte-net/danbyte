import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { CornerDownRight, Plus } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { SuggestInput } from "@/components/ui/suggest-input"
import { FacetHeading } from "@/components/filter-rail"
import { createSearch, freeSizeLabel } from "@/lib/prefix-free"
import type { ListRow } from "@/lib/prefix-free"

/**
 * Free rows in the prefix list (lib/prefix-free): the list's own columns,
 * with every cell of a free row swapped for the free row's few: its block,
 * a dashed Free badge, its size and Create. "+ N more free" rows expand.
 */
export function withFreeCells<T extends ListRow>(
  columns: ColumnDef<T, unknown>[],
  opts: {
    /** May a prefix be created under this parent? */
    canAdd: (parentId: string) => boolean
    onExpand: (parentId: string) => void
  }
): ColumnDef<T, unknown>[] {
  return columns.map((col) => {
    const own = col.cell
    return {
      ...col,
      cell: (ctx) => {
        const mark = ctx.row.original._free
        if (!mark) {
          if (typeof own === "function") return own(ctx)
          return own ?? ctx.getValue()
        }
        return freeCell(col.id ?? "", ctx.row.original, opts)
      },
    }
  })
}

function Indent({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <CornerDownRight
          key={i}
          aria-hidden
          className="h-3 w-3 shrink-0 text-muted-foreground/40"
        />
      ))}
    </>
  )
}

function freeCell(
  id: string,
  row: ListRow,
  opts: {
    /** May a prefix be created under this parent? */
    canAdd: (parentId: string) => boolean
    onExpand: (parentId: string) => void
  }
) {
  const mark = row._free!
  if (mark.kind === "more") {
    if (id !== "cidr") return null
    return (
      <div className="flex items-center gap-0.5">
        <Indent depth={row._depth} />
        {mark.expandable ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs text-muted-foreground"
            onClick={() => opts.onExpand(mark.parentId)}
          >
            + {mark.more!.toLocaleString("en-US")} more free
          </Button>
        ) : (
          <Link
            to="/prefixes/$id"
            params={{ id: mark.parentId }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            + {mark.more!.toLocaleString("en-US")} more free
          </Link>
        )}
      </div>
    )
  }
  switch (id) {
    case "cidr":
      return (
        <div className="flex items-center gap-0.5">
          <Indent depth={row._depth} />
          {opts.canAdd(mark.parentId) ? (
            <Link
              to="/prefixes/new"
              search={createSearch(row)}
              className="font-mono text-muted-foreground hover:text-foreground hover:underline"
            >
              {mark.cidr}
            </Link>
          ) : (
            <span className="font-mono text-muted-foreground">{mark.cidr}</span>
          )}
        </div>
      )
    case "status":
      return (
        <Badge
          variant="outline"
          className="border-dashed text-muted-foreground"
        >
          Free
        </Badge>
      )
    case "description":
      return (
        <span className="text-xs text-muted-foreground">
          {freeSizeLabel(mark.prefixlen, mark.family)}
        </span>
      )
    case "actions":
      return opts.canAdd(mark.parentId) ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            asChild
          >
            <Link to="/prefixes/new" search={createSearch(row)}>
              <Plus className="h-3 w-3" /> Create
            </Link>
          </Button>
        </div>
      ) : null
    default:
      return null
  }
}

/** The free-space controls at the top of the prefix list's rail. */
export function PrefixFreeRail({
  show,
  onShow,
  size,
  onSize,
  sizeError,
  sizes,
  next,
  onNext,
  scope,
  onScope,
  scopeError,
  scopes,
}: {
  show: boolean
  onShow: (v: boolean) => void
  size: string
  onSize: (v: string) => void
  sizeError: string | null
  sizes: string[]
  next: boolean
  onNext: (v: boolean) => void
  scope: string
  onScope: (v: string) => void
  scopeError: string | null
  scopes: string[]
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="-mx-1.5 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
        <Checkbox checked={show} onCheckedChange={(v) => onShow(!!v)} />
        <span>Show free space</span>
      </label>
      {show && (
        <>
          <div>
            <FacetHeading
              label="Free size"
              onClear={size ? () => onSize("") : undefined}
            />
            <SuggestInput
              value={size}
              onChange={onSize}
              suggestions={sizes}
              placeholder="/29"
              aria-label="Free size"
              aria-invalid={!!sizeError}
              className="h-7 font-mono text-xs"
            />
            {sizeError && (
              <p className="mt-1 text-[11px] text-destructive">{sizeError}</p>
            )}
            {size && !sizeError && (
              <label className="-mx-1.5 mt-1 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
                <Checkbox checked={next} onCheckedChange={(v) => onNext(!!v)} />
                <span>Next available</span>
              </label>
            )}
          </div>
          <div>
            <FacetHeading
              label="Scope"
              onClear={scope ? () => onScope("") : undefined}
            />
            {scopes.length ? (
              <SuggestInput
                value={scope}
                onChange={onScope}
                suggestions={scopes}
                placeholder="10.20.0.0/19"
                aria-label="Scope"
                aria-invalid={!!scopeError}
                className="h-7 font-mono text-xs"
              />
            ) : (
              <Input
                value={scope}
                onChange={(e) => onScope(e.target.value)}
                placeholder="10.20.0.0/19"
                aria-label="Scope"
                aria-invalid={!!scopeError}
                className="h-7 font-mono text-xs"
              />
            )}
            {scopeError && (
              <p className="mt-1 text-[11px] text-destructive">{scopeError}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
