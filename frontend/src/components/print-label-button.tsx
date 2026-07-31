import { useQuery } from "@tanstack/react-query"
import { Printer } from "lucide-react"

import { api } from "@/lib/api"
import type { LabelTemplate, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * "Print label" action. Shows only when at least one label template exists for
 * ``objectType`` (automatic placement — no per-page config). Picks a template
 * and opens the print sheet for the given object ids in a new tab. Used on
 * detail pages (single id) and list bulk bars (many ids).
 */
export function PrintLabelButton({
  objectType,
  ids,
  label = "Print label",
  size = "sm",
  variant = "outline",
}: {
  objectType: string
  ids: string[]
  label?: string
  size?: "sm" | "icon-sm"
  variant?: "outline" | "ghost"
}) {
  const q = useQuery({
    queryKey: ["label-templates", objectType],
    queryFn: () =>
      api<Paginated<LabelTemplate>>(
        `/api/label-templates/?object_type=${objectType}&page_size=200`
      ),
  })
  const templates = q.data?.results ?? []
  if (templates.length === 0 || ids.length === 0) return null

  // Default template first, then by name (the API already orders by name).
  const ordered = [...templates].sort(
    (a, b) => Number(b.is_default) - Number(a.is_default)
  )

  const open = (templateId: string) => {
    const params = new URLSearchParams({
      template: templateId,
      ids: ids.join(","),
    })
    window.open(`/labels/print?${params.toString()}`, "_blank", "noopener")
  }

  // One template → straight to print; several → let the operator choose.
  if (ordered.length === 1) {
    return (
      <Button size={size} variant={variant} onClick={() => open(ordered[0].id)}>
        <Printer className="h-3.5 w-3.5" />
        {size !== "icon-sm" && ` ${label}`}
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant={variant}>
          <Printer className="h-3.5 w-3.5" />
          {size !== "icon-sm" && ` ${label}`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ordered.map((t) => (
          <DropdownMenuItem key={t.id} onClick={() => open(t.id)}>
            {t.name}
            {t.is_default && (
              <span className="ml-2 text-[11px] text-muted-foreground">
                default
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
