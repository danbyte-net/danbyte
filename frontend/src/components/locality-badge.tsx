import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Globe } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface LocalityBadgeProps {
  /** null / undefined means the entry is tenant-wide ("Global"). */
  owningSite: { id: string; name: string } | null | undefined
  className?: string
}

// Scope chip for local/global catalog entries (tags, zones, device types,
// statuses, …). A null owning_site is a tenant-wide entry ("Global"); a set
// one belongs to a single site ("Local — <name>").
export function LocalityBadge({ owningSite, className }: LocalityBadgeProps) {
  if (!owningSite) {
    return (
      <Badge
        variant="secondary"
        className={cn(
          "text-[11px] font-normal text-muted-foreground",
          className
        )}
      >
        Global
      </Badge>
    )
  }
  return (
    <Badge variant="info" className={cn("text-[11px] font-normal", className)}>
      Local — {owningSite.name}
    </Badge>
  )
}

export interface PromoteToGlobalButtonProps {
  /** POST endpoint, e.g. `/api/zones/<id>/promote/`. */
  url: string
  /** Object name, for the success toast. */
  name: string
  /** Query keys to invalidate after promoting. */
  invalidate: readonly (readonly unknown[])[]
}

// "Make this local catalog entry tenant-wide" — the server only allows this
// for tenant-wide editors; callers additionally gate on
// `editableSites === "all"` + the type-level change permission.
export function PromoteToGlobalButton({
  url,
  name,
  invalidate,
}: PromoteToGlobalButtonProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => api<unknown>(url, { method: "POST" }),
    onSuccess: () => {
      for (const key of invalidate)
        qc.invalidateQueries({ queryKey: key as unknown[] })
      toast.success(`${name} is now global`)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      <Globe className="h-3.5 w-3.5" />
      {m.isPending ? "Promoting…" : "Promote to global"}
    </Button>
  )
}
