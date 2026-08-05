import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

interface LabelHit {
  id: string
  label: string
  route: string | null
}

/** Resolve a generic (model slug, object id) to a human label + deep link via
 * the customization object-labels endpoint — the same primitive custom-field
 * object references use. */
export function ObjectChip({
  slug,
  id,
  className,
}: {
  slug: string
  id: string
  className?: string
}) {
  const q = useQuery({
    queryKey: ["object-label", slug, id],
    queryFn: () =>
      api<{ results: LabelHit[] }>(
        `/api/customization/object-labels/?model=${slug}&ids=${id}`
      ),
    staleTime: 60_000,
  })
  const hit = q.data?.results?.[0]
  const label = hit?.label ?? "…"
  const cls =
    className ??
    "inline-flex items-center rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[12px]"
  if (hit?.route) {
    const to = hit.route.replace("$id", id)
    return (
      <Link to={to} className={`${cls} text-primary hover:underline`}>
        {label}
      </Link>
    )
  }
  return <span className={cls}>{label}</span>
}

/** "api.device" → the customization registry slug ("device"). */
export function slugFromObjectType(objectType: string): string {
  return objectType.includes(".") ? objectType.split(".")[1] : objectType
}
