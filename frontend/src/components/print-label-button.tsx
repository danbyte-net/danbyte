import { useQuery } from "@tanstack/react-query"
import { Copy, Printer, Sheet } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { LabelTemplate, Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// Page layouts the PDF endpoint understands. "label" = one label per page sized
// to the label (for a dedicated label printer); "a4"/"letter" = labels tiled at
// true size onto an office sheet, so an ordinary printer prints them at real
// size without an "actual size" toggle (its paper already matches the PDF page).
const PAPERS = [
  { key: "label", label: "Label roll (exact size)" },
  { key: "a4", label: "A4 sheet (tiled)" },
  { key: "letter", label: "Letter sheet (tiled)" },
] as const

/**
 * "Print label" action. Shows only when at least one label template exists for
 * ``objectType`` (automatic placement — no per-page config). Opens a
 * label-sized PDF for the given object ids in a new tab — the browser's PDF
 * viewer previews it and prints it at exact physical size (a browser can't
 * print an HTML page at an exact size — the paper size is dialog-controlled).
 * The paper submenu tiles onto A4/Letter for people without a label printer,
 * and "Copy text" yields the label's plain text for an external label program.
 *
 * When ``deviceTypeId``/``roleId`` are given (a device detail page), only
 * templates that target that device type/role — or carry no restriction — are
 * offered. Several may match, so a device can print more than one label.
 * Used on detail pages (single id) and list bulk bars (many ids).
 */
export function PrintLabelButton({
  objectType,
  ids,
  deviceTypeId,
  roleId,
  label = "Print label",
  size = "sm",
  variant = "outline",
}: {
  objectType: string
  ids: string[]
  deviceTypeId?: string | null
  roleId?: string | null
  label?: string
  size?: "sm" | "icon-sm"
  variant?: "outline" | "ghost"
}) {
  const q = useQuery({
    queryKey: ["label-templates", objectType, deviceTypeId ?? "", roleId ?? ""],
    queryFn: () => {
      const p = new URLSearchParams({
        object_type: objectType,
        page_size: "200",
      })
      if (deviceTypeId) p.set("device_type", deviceTypeId)
      if (roleId) p.set("role", roleId)
      return api<Paginated<LabelTemplate>>(
        `/api/label-templates/?${p.toString()}`
      )
    },
  })
  const templates = q.data?.results ?? []
  if (templates.length === 0 || ids.length === 0) return null

  // Default template first, then by name (the API already orders by name).
  const ordered = [...templates].sort(
    (a, b) => Number(b.is_default) - Number(a.is_default)
  )

  const openPdf = (templateId: string, paper: string) => {
    const params = new URLSearchParams({ ids: ids.join(","), paper })
    window.open(
      `/api/label-templates/${templateId}/pdf/?${params.toString()}`,
      "_blank",
      "noopener"
    )
  }

  const copyText = async (templateId: string) => {
    try {
      const params = new URLSearchParams({ ids: ids.join(",") })
      const r = await api<{ labels: { text: string }[] }>(
        `/api/label-templates/${templateId}/text/?${params.toString()}`
      )
      // One label per block, blank line between — easy to paste row-by-row into
      // an external label program.
      const text = r.labels.map((l) => l.text).join("\n\n")
      await navigator.clipboard.writeText(text)
      toast.success(
        `Copied ${r.labels.length} label${r.labels.length === 1 ? "" : "s"} to the clipboard`
      )
    } catch (e) {
      apiErrorToast(e)
    }
  }

  const exportXlsx = (templateId: string) => {
    const params = new URLSearchParams({ ids: ids.join(",") })
    // A GET to the xlsx endpoint downloads the file (Content-Disposition).
    window.open(
      `/api/label-templates/${templateId}/xlsx/?${params.toString()}`,
      "_blank",
      "noopener"
    )
  }

  const actions = (templateId: string) => (
    <>
      {PAPERS.map((p) => (
        <DropdownMenuItem
          key={p.key}
          onClick={() => openPdf(templateId, p.key)}
        >
          <Printer className="h-3.5 w-3.5" /> {p.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => copyText(templateId)}>
        <Copy className="h-3.5 w-3.5" /> Copy text
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => exportXlsx(templateId)}>
        <Sheet className="h-3.5 w-3.5" /> Export to Excel
      </DropdownMenuItem>
    </>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant={variant}>
          <Printer className="h-3.5 w-3.5" />
          {size !== "icon-sm" && ` ${label}`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ordered.length === 1 ? (
          <>
            <DropdownMenuLabel>Print as</DropdownMenuLabel>
            {actions(ordered[0].id)}
          </>
        ) : (
          ordered.map((t) => (
            <DropdownMenuSub key={t.id}>
              <DropdownMenuSubTrigger>
                {t.name}
                {t.is_default && (
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    default
                  </span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>{actions(t.id)}</DropdownMenuSubContent>
            </DropdownMenuSub>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          Tip: on a normal printer use a sheet layout, or set the print dialog
          to “Actual size”.
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
