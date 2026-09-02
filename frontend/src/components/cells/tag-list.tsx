import { type ColumnDef } from "@tanstack/react-table"
import { Badge } from "@/components/ui/badge"
import { SortHeader } from "@/components/data-table"
import { cn, cssColor } from "@/lib/utils"
import { type Tag } from "@/lib/api"

interface TagListProps {
  tags: Tag[]
  /** Slugs currently active in the filter - those badges get a ring. */
  activeSlugs?: Set<string>
  /** Click → toggle in the active set. When omitted, badges are static. */
  onToggle?: (slug: string) => void
  className?: string
  /** Table-cell mode: single-line, horizontal scroll if overflow. Default
   * (false) wraps onto multiple lines - appropriate for page headers and
   * detail panes where vertical space is available. */
  inline?: boolean
}

// A clickable strip of tag chips. Each chip uses the tag's own color
// (falls back to the secondary variant when blank). Clicking a chip
// calls onToggle(slug) - the parent owns the filter state.
// Same component shape works for every table: Prefixes, IPs, Devices,
// Sites, VLANs, VRFs - they all carry the same `Tag[]` shape on the API.
export function TagList({
  tags,
  activeSlugs,
  onToggle,
  className,
  inline,
}: TagListProps) {
  if (tags.length === 0) {
    return <span className="text-muted-foreground">-</span>
  }
  return (
    <div
      className={cn(
        "flex gap-1",
        inline ? "flex-nowrap items-center overflow-hidden" : "flex-wrap",
        className
      )}
    >
      {tags.map((t) => {
        const active = activeSlugs?.has(t.slug)
        const clickable = !!onToggle
        return (
          <Badge
            key={t.id}
            variant="secondary"
            onClick={
              onToggle
                ? (e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    onToggle(t.slug)
                  }
                : undefined
            }
            className={cn(
              clickable && "cursor-pointer hover:brightness-110",
              // Active state: subtle inset ring + brightness bump. Using
              // `ring-inset` (no offset gap) and a translucent
              // foreground tone keeps the chip looking like one solid
              // pill, not a chip wrapped in a floating outline.
              active &&
                "ring-1 ring-foreground/30 brightness-110 saturate-150 ring-inset",
              inline && "shrink-0 whitespace-nowrap"
            )}
            style={
              t.color
                ? { backgroundColor: cssColor(t.color), color: t.text_color || "#fff" }
                : undefined
            }
          >
            {t.name}
          </Badge>
        )
      })}
    </div>
  )
}

interface TagsColumnOpts<T> {
  header?: string
  getTags: (row: T) => Tag[]
  activeSlugs?: Set<string>
  onToggle?: (slug: string) => void
}

// Drop-in tags column. Wires TagList + click handler. Reusable across
// every list page:
//
//   tagsColumn<Prefix>({
//     getTags: (r) => r.tags,
//     activeSlugs: tagFilter,
//     onToggle: (slug) => toggle(tagFilter, slug, setTagFilter),
//   })
export function tagsColumn<T>(opts: TagsColumnOpts<T>): ColumnDef<T, unknown> {
  const label = opts.header ?? "Tags"
  return {
    id: "tags",
    // Sorts by the tag names, so rows sharing a tag land together.
    accessorFn: (r) =>
      opts
        .getTags(r)
        .map((t) => t.name.toLowerCase())
        .sort()
        .join(", "),
    header: ({ column }) => <SortHeader column={column} label={label} />,
    // A chip is always a filter toggle: the explicit handler when the page
    // owns its tag filter, else the auto rail's facet (see useTableFilters).
    cell: ({ row, column }) => {
      const facet = column.columnDef.meta?.tagFacet
      return (
        <TagList
          tags={opts.getTags(row.original)}
          activeSlugs={opts.activeSlugs ?? facet?.active}
          onToggle={opts.onToggle ?? facet?.toggle}
          inline
        />
      )
    },
    meta: {
      facet: {
        kind: "tags",
        label: opts.header ?? "Tags",
        get: (r: T) =>
          opts.getTags(r).map((t) => ({
            slug: t.slug,
            name: t.name,
            color: t.color || undefined,
            text_color: t.text_color || undefined,
          })),
      },
    },
  }
}
