import { useCallback, useState } from "react"

import { sbomFile } from "@/lib/api"
import type { SbomFilter } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { downloadBlob } from "@/lib/table-export"
import type { ExtraExport } from "@/components/table-io"
import { useVulnSettings } from "@/components/vulnerabilities/use-vuln-settings"

function useSbomDownload(
  filter: () => SbomFilter | Promise<SbomFilter>,
  vex: boolean
) {
  const [busy, setBusy] = useState(false)
  const run = useCallback(async () => {
    setBusy(true)
    try {
      const f = await filter()
      const { blob, filename } = await sbomFile(vex ? { ...f, vex: true } : f)
      downloadBlob(filename, blob.type, blob)
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(false)
    }
  }, [filter, vex])
  return { busy, run }
}

/**
 * The "SBOM (CycloneDX)" entry for a list's Import / Export menu: downloads
 * the CycloneDX SBOM of the hosts the list shows now. `filter` is read on
 * click, so it follows the list's current filters; a server-paged list
 * answers it asynchronously, with every matching id.
 */
export function useSbomExport(
  filter: () => SbomFilter | Promise<SbomFilter>,
  disabled = false
): ExtraExport {
  const { busy, run } = useSbomDownload(filter, false)
  return {
    key: "sbom",
    label: busy ? "Exporting…" : "SBOM (CycloneDX)",
    disabled: disabled || busy,
    onSelect: () => void run(),
  }
}

/**
 * "SBOM with vulnerabilities": the same document with its CycloneDX
 * `vulnerabilities` section (`?vex=1`, #451) - the open matches of the same
 * hosts and installs. Null while vulnerability data is off.
 */
export function useSbomVexExport(
  filter: () => SbomFilter | Promise<SbomFilter>,
  disabled = false
): ExtraExport | null {
  const { enabled } = useVulnSettings()
  const { busy, run } = useSbomDownload(filter, true)
  if (!enabled) return null
  return {
    key: "sbom-vex",
    label: busy ? "Exporting…" : "SBOM with vulnerabilities",
    disabled: disabled || busy,
    onSelect: () => void run(),
  }
}
