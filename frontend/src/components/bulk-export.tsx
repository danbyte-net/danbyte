import { Download } from "lucide-react"

import { ioExportUrl, type IOFormat } from "@/lib/api"
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
 * "Export selected" for a bulk-action bar — round-trip export of just the
 * selected rows (`/api/io/<slug>/export/?ids=…`). Drop into any bulk bar with
 * the rows' object slug + ids.
 */
export function BulkExport({ ioType, ids }: { ioType: string; ids: string[] }) {
  if (ids.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2">
          <Download className="mr-1 h-3 w-3" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {FMTS.map(([fmt, label]) => (
          <DropdownMenuItem key={fmt} asChild>
            <a href={ioExportUrl(ioType, { fmt, ids })} download>
              {label}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
