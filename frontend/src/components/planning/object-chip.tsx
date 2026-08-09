import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowDownUp,
  Bookmark,
  Boxes,
  Building2,
  Contact,
  Container,
  Cpu,
  Factory,
  FolderTree,
  GitBranch,
  GitPullRequestArrow,
  Globe,
  Link2,
  Locate,
  MonitorSmartphone,
  Network,
  Server,
  SquareCheckBig,
  Tag,
  User,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

interface LabelHit {
  id: string
  label: string
  route: string | null
}

// One icon per registered reference model, mirroring the sidebar's nav icons so
// a device reads as a device wherever it appears. Unknown slugs fall back to a
// generic link glyph rather than inventing a new visual.
const ICONS: Record<string, LucideIcon> = {
  device: Server,
  devicetype: ArrowDownUp,
  moduletype: ArrowDownUp,
  devicerole: Tag,
  platform: Cpu,
  manufacturer: Factory,
  rack: Container,
  site: Building2,
  location: FolderTree,
  region: Globe,
  tenant: Users,
  vlan: Bookmark,
  vrf: GitBranch,
  prefix: Network,
  ipaddress: Locate,
  interface: Workflow,
  cluster: Boxes,
  virtualmachine: MonitorSmartphone,
  contact: Contact,
  provider: Factory,
  circuit: GitPullRequestArrow,
  task: SquareCheckBig,
  user: User,
  group: Users,
}

export function objectIcon(slug: string): LucideIcon {
  return ICONS[slug] ?? Link2
}

/** Resolve a generic (model slug, object id) to its label + deep link via the
 * customization object-labels endpoint — the same primitive custom-field object
 * references use. Cached per (slug, id), so the same device costs one request
 * no matter how many cards show it. */
export function useObjectLabel(slug: string, id: string) {
  const q = useQuery({
    queryKey: ["object-label", slug, id],
    queryFn: () =>
      api<{ results: LabelHit[] }>(
        `/api/customization/object-labels/?model=${slug}&ids=${id}`
      ),
    staleTime: 60_000,
  })
  const hit = q.data?.results?.[0]
  return {
    label: hit?.label ?? null,
    route: hit?.route ? hit.route.replace("$id", id) : null,
    isLoading: q.isLoading,
  }
}

/** Compact linked-object chip for task cards: type icon + object name, deep
 * linking to the object when the registry knows a route. */
export function ObjectChip({
  slug,
  id,
  className,
}: {
  slug: string
  id: string
  className?: string
}) {
  const { label, route, isLoading } = useObjectLabel(slug, id)
  const Icon = objectIcon(slug)
  const cls = cn(
    "inline-flex max-w-[11rem] items-center gap-1 rounded-[5px] border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium",
    className
  )
  const body = (
    <>
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">
        {label ?? (isLoading ? "Loading..." : "Unavailable")}
      </span>
    </>
  )
  if (route)
    return (
      <Link to={route} className={cn(cls, "hover:border-primary/50")}>
        {body}
      </Link>
    )
  return <span className={cls}>{body}</span>
}

/** Full-width linked-object row for the task sheet: icon tile, name, and the
 * inventory detail (site, address, status) the object itself reports. */
export function ObjectRow({
  slug,
  id,
  typeLabel,
  note,
  action,
}: {
  slug: string
  id: string
  typeLabel: string
  note?: string
  action?: React.ReactNode
}) {
  const { label, route, isLoading } = useObjectLabel(slug, id)
  const Icon = objectIcon(slug)
  const name = label ?? (isLoading ? "Loading..." : "Unavailable")

  return (
    <div className="group flex items-center gap-3 px-3 py-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        {route ? (
          <Link
            to={route}
            className="block truncate text-[13px] font-medium text-primary hover:underline"
          >
            {name}
          </Link>
        ) : (
          <span className="block truncate text-[13px] font-medium">{name}</span>
        )}
        <span className="block truncate text-[11px] text-muted-foreground">
          {note ? `${typeLabel} · ${note}` : typeLabel}
        </span>
      </div>
      {action}
    </div>
  )
}

/** "api.device" → the customization registry slug ("device"). */
export function slugFromObjectType(objectType: string): string {
  return objectType.includes(".") ? objectType.split(".")[1] : objectType
}
