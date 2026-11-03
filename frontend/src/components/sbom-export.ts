import { useCallback, useState } from "react"

import { sbomFile } from "@/lib/api"
import type { SbomFilter } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { downloadBlob } from "@/lib/table-export"
import type { ExtraExport } from "@/components/table-io"

/**
 * The "SBOM (CycloneDX)" entry for a list's Import / Export menu: downloads
 * the CycloneDX SBOM of the hosts the list shows now. `filter` is read on
 * click, so it follows the list's current filters.
 */
export function useSbomExport(
  filter: () => SbomFilter,
  disabled = false
): ExtraExport {
  const [busy, setBusy] = useState(false)
  const run = useCallback(async () => {
    setBusy(true)
    try {
      const { blob, filename } = await sbomFile(filter())
      downloadBlob(filename, blob.type, blob)
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(false)
    }
  }, [filter])
  return {
    key: "sbom",
    label: busy ? "Exporting…" : "SBOM (CycloneDX)",
    disabled: disabled || busy,
    onSelect: () => void run(),
  }
}
