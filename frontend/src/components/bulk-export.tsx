import { useState } from "react"
import { Download } from "lucide-react"

import { ioExportFile, type IOFormat } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { downloadBlob } from "@/lib/table-export"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const FMTS: [IOFormat, string][] = [
  ["csv", "CSV (.csv)"],
  ["xlsx", "Excel (.xlsx)"],
  ["json", "JSON (.json)"],
]

/**
 * "Export selected" for a bulk-action bar - round-trip export of just the
 * selected rows. The ids are POSTed, not put in a link: "Select all N" makes
 * a selection of thousands one click away, far past what a URL can hold.
 * Drop into any bulk bar with the rows' object slug + ids.
 */
export function BulkExport({ ioType, ids }: { ioType: string; ids: string[] }) {
  const [busy, setBusy] = useState(false)
  if (ids.length === 0) return null
  const run = async (fmt: IOFormat) => {
    setBusy(true)
    try {
      const { blob, filename } = await ioExportFile(ioType, { fmt, ids })
      downloadBlob(filename, blob.type, blob)
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2" disabled={busy}>
          <Download className="mr-1 h-3 w-3" />
          {busy ? "Exporting…" : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {FMTS.map(([fmt, label]) => (
          <DropdownMenuItem key={fmt} onSelect={() => void run(fmt)}>
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
