import { Link } from "@tanstack/react-router"

import type { PackageAdvisoryState } from "@/lib/api"
import { TimeCell } from "@/components/cells/time-ago"
import { InfoTip } from "@/components/ui/info-tip"

// Why a host's packages show no CVEs yet (#451): the vulnerability store
// has no advisory data for packages read after its last fetch. Says what to
// do in each update mode: Browser - sync now; Upload - import an OSV file;
// Server - the fetch is queued. Nothing once a fetch covers them.

export function AdvisoryNote({
  value,
}: {
  value?: PackageAdvisoryState | null
}) {
  if (!value || value.state === "fetched") return null
  let text: string
  let action: React.ReactNode = null
  if (value.state === "running") {
    text = "Vulnerability data is updating"
  } else if (value.mode === "server") {
    text = "Advisory fetch queued"
  } else if (value.mode === "browser") {
    text = "Vulnerability data for these packages has not been fetched"
    if (value.can_sync)
      action = (
        <Link to="/settings/vulnerabilities/sync" className="link">
          Sync now
        </Link>
      )
  } else {
    text = "Vulnerability data for these packages has not been imported"
    if (value.can_sync)
      action = (
        <Link to="/settings/admin" className="link">
          Import OSV file
        </Link>
      )
  }
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      role="status"
    >
      <span className="whitespace-nowrap text-foreground">{text}</span>
      {action}
      <span className="flex items-center gap-1 whitespace-nowrap">
        {value.last_fetch ? (
          <>
            Last fetch <TimeCell iso={value.last_fetch} />
          </>
        ) : (
          "Never fetched"
        )}
        <InfoTip>
          Packages read after the last advisory fetch have no CVE data yet.
          {value.mode === "upload"
            ? " Upload an OSV export under Settings → Vulnerability data."
            : value.mode === "browser"
              ? " A deployment admin runs Sync now from their browser."
              : " The server fetches new packages after each read and daily."}
        </InfoTip>
      </span>
    </p>
  )
}
