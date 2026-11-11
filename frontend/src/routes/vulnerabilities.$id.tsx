import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"

import { api } from "@/lib/api"
import type { VulnRecordDetail } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { useUrlTab } from "@/lib/use-url-tab"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { recordUrl } from "@/components/columns/vulnerability-match-columns"
import {
  KevBadge,
  PriorityBadge,
  SeverityBadge,
  formatEpss,
  toNumber,
} from "@/components/vulnerabilities/badges"
import { useVulnSettings } from "@/components/vulnerabilities/use-vuln-settings"
import { VulnerabilitiesTab } from "@/components/vulnerabilities/vulnerabilities-tab"
import {
  RecordExceptions,
  useRecordExceptions,
} from "@/components/vulnerabilities/record-exceptions"

// One vulnerability record (#451): what it is (Overview) and what in the
// tenant it affects (Affected - devices, VMs and installs, with the version
// tested, the confidence, the mapping it came through and when it appeared;
// resolved history one tick away) and the exceptions made for it. Records
// are public data and not change-logged, so there is no Journal or Change
// log tab.

export const Route = createFileRoute("/vulnerabilities/$id")({
  component: VulnerabilityDetail,
})

type Tab = "overview" | "affected" | "exceptions"
const TABS: readonly Tab[] = ["overview", "affected", "exceptions"]

function VulnerabilityDetail() {
  const { id } = Route.useParams()
  const settings = useVulnSettings()
  const q = useQuery({
    queryKey: ["vulnerability", id],
    queryFn: () =>
      api<VulnRecordDetail>(`/api/vulnerabilities/${encodeURIComponent(id)}/`),
    enabled: settings.enabled,
  })
  if (settings.isLoading || (settings.enabled && q.isLoading))
    return <Loading />
  if (!settings.enabled)
    return (
      <div className="p-6">
        <EmptyState title="Vulnerability data is off" />
      </div>
    )
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body record={q.data} />
}

/** CWE-79 → its MITRE page; anything else reads as itself. */
export function cweUrl(cwe: string): string | null {
  const m = /^CWE-(\d+)$/.exec(cwe)
  return m ? `https://cwe.mitre.org/data/definitions/${m[1]}.html` : null
}

function OutLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="link inline-flex items-center gap-1 break-all"
    >
      {children}
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
    </a>
  )
}

const ATTACK_VECTORS: Record<string, string> = {
  network: "Network",
  adjacent: "Adjacent",
  local: "Local",
  physical: "Physical",
}

const SOURCES: Record<string, string> = {
  nvd_api: "NVD API",
  nvd_feed: "NVD feed",
  browser: "Browser sync",
  osv: "OSV",
}

function Body({ record: r }: { record: VulnRecordDetail }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const { formatDate, formatDateTime } = useDateFormat()
  const date = (v: string | null) => (v ? formatDate(v) : dash)
  const score = toNumber(r.cvss_score)
  const exceptions = useRecordExceptions(r.vuln_id)

  const record: KvRow[] = [
    { label: "Id", value: mono(r.vuln_id), copy: r.vuln_id },
    ...(r.aliases.length
      ? [
          {
            label: "Aliases",
            value: (
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {r.aliases.map((a) => (
                  <OutLink key={a} href={recordUrl(a)}>
                    {a}
                  </OutLink>
                ))}
              </span>
            ),
          },
        ]
      : []),
    { label: "Priority", value: <PriorityBadge value={r.priority} /> },
    { label: "Published", value: date(r.published) },
    { label: "Modified", value: date(r.last_modified) },
    {
      label: "Status",
      value: r.rejected ? (
        <Badge variant="outline">Rejected</Badge>
      ) : !r.analysed ? (
        "Not analysed by NVD yet"
      ) : (
        r.vuln_status || dash
      ),
    },
    {
      label: "Source",
      value: (
        <span>
          {SOURCES[r.source] ?? (r.source || dash)}
          {r.fetched_at && (
            <span className="text-muted-foreground">
              {" "}
              · {formatDateTime(r.fetched_at)}
            </span>
          )}
        </span>
      ),
    },
  ]

  const cvss: KvRow[] = [
    {
      label: "Score",
      value:
        score === null ? (
          dash
        ) : (
          <span className="inline-flex items-center gap-2">
            <span className="num font-medium">{score.toFixed(1)}</span>
            <SeverityBadge value={r.cvss_severity} />
          </span>
        ),
    },
    { label: "Version", value: r.cvss_version || dash },
    {
      label: "Vector",
      value: r.cvss_vector ? mono(r.cvss_vector) : dash,
      copy: r.cvss_vector || undefined,
    },
    {
      label: "Verified",
      value: r.cvss_verified ? "Recomputed from the vector" : "As published",
    },
    {
      label: "Attack vector",
      value: ATTACK_VECTORS[r.attack_vector] ?? (r.attack_vector || dash),
    },
    {
      label: "CWE",
      value: r.cwes.length ? (
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {r.cwes.map((c) => {
            const href = cweUrl(c)
            return href ? (
              <OutLink key={c} href={href}>
                {c}
              </OutLink>
            ) : (
              <span key={c}>{c}</span>
            )
          })}
        </span>
      ) : (
        dash
      ),
    },
  ]

  const exploitation: KvRow[] = [
    {
      label: "CISA KEV",
      value: r.kev ? (
        <KevBadge added={r.kev_added} due={r.kev_due} />
      ) : (
        "Not listed"
      ),
    },
    ...(r.kev
      ? [
          { label: "Added", value: date(r.kev_added) },
          { label: "Due", value: date(r.kev_due) },
          { label: "Action", value: r.kev_action || dash },
          {
            label: "Ransomware",
            value:
              r.kev_ransomware === "known"
                ? "Known use"
                : r.kev_ransomware
                  ? "Unknown"
                  : dash,
          },
        ]
      : []),
    {
      label: "EPSS",
      value:
        r.epss === null ? (
          dash
        ) : (
          <span>
            <span className="num">{formatEpss(r.epss)}</span>
            {r.epss_percentile !== null && (
              <span className="text-muted-foreground">
                {" "}
                · percentile {formatEpss(r.epss_percentile)}
              </span>
            )}
          </span>
        ),
    },
    { label: "EPSS date", value: date(r.epss_date) },
  ]

  const fixed: KvRow[] = [
    ...r.fixed_in.map((f) => ({
      label: [f.vendor, f.product].filter(Boolean).join(" ") || "Product",
      value: mono(f.version),
    })),
    ...r.osv_fixed_in.map((f) => ({
      label: `${f.ecosystem} ${f.name}`,
      value: mono(f.version),
    })),
    // Microsoft's fixed builds (and KBs) per Windows release.
    ...(r.msrc_fixed_in ?? [])
      .filter((f) => f.fixed.length > 0)
      .map((f) => ({
        label: f.product,
        value: mono(
          f.fixed.join(", ") +
            (f.kbs.length ? ` (KB${f.kbs.join(", KB")})` : "")
        ),
      })),
  ]

  return (
    <DetailShell
      backTo="/vulnerabilities"
      backLabel="Vulnerabilities"
      title={r.vuln_id}
      actions={
        <Button variant="outline" size="sm" asChild>
          <a
            href={recordUrl(r.vuln_id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {r.vuln_id.startsWith("CVE-") ? "NVD" : "OSV"}
          </a>
        </Button>
      }
      hero={
        <DetailHero
          title={r.vuln_id}
          mono
          badges={
            <>
              <PriorityBadge value={r.priority} />
              <SeverityBadge value={r.cvss_severity} />
              {r.kev && <KevBadge added={r.kev_added} due={r.kev_due} />}
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "affected", label: "Affected", count: r.affected_count },
        {
          value: "exceptions",
          label: "Exceptions",
          count: exceptions.data?.count,
        },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <div className="space-y-4">
          {r.summary && (
            <section>
              <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
                Description
              </h2>
              <p className="max-w-3xl text-sm whitespace-pre-line">
                {r.summary}
              </p>
            </section>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <KvCard title="Record" rows={record} />
            <KvCard title="CVSS" rows={cvss} />
            <KvCard title="Exploitation" rows={exploitation} />
            {fixed.length > 0 && <KvCard title="Fixed in" rows={fixed} />}
          </div>
          {r.references.length > 0 && (
            <section>
              <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
                References
              </h2>
              <ul className="space-y-1 text-sm">
                {r.references.map((ref) => (
                  <li
                    key={ref.url}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <OutLink href={ref.url}>{ref.url}</OutLink>
                    {(ref.tags ?? []).map((t) => (
                      <Badge key={t} variant="outline">
                        {t}
                      </Badge>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </DetailTab>
      <DetailTab value="affected">
        <VulnerabilitiesTab kind="record" id={r.vuln_id} />
      </DetailTab>
      <DetailTab value="exceptions">
        <RecordExceptions vulnId={r.vuln_id} />
      </DetailTab>
    </DetailShell>
  )
}
