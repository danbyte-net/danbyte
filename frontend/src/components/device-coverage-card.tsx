import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DeviceCoverage, DeviceCoverageContract } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { Badge } from "@/components/ui/badge"
import { Section } from "@/components/ui/section"
import { Loading } from "@/components/loading"
import { OverviewTable } from "@/components/overview-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { QueryError } from "@/components/query-error"
import { dash } from "@/components/cells/dash"
import {
  ContractStateBadge,
  CoverageBadge,
} from "@/components/cells/coverage-cell"
import { LifetimeBar } from "@/components/cells/lifecycle-cell"

// Support & warranty coverage on the device overview (#421): the contracts
// covering the device, best first, and the flags from setting its coverage
// next to its hardware's vendor lifecycle.

export function useDeviceCoverage(deviceId: string) {
  return useQuery({
    queryKey: ["device-coverage", deviceId],
    queryFn: () => api<DeviceCoverage>(`/api/devices/${deviceId}/coverage/`),
    staleTime: 60_000,
  })
}

/** The overview's "Support coverage" row: the status pill and the time bar
 * from the governing contract's start to the coverage end, coloured by the
 * tenant's coverage window. An open-ended contract has no end to count to. */
export function CoverageSummary({
  deviceId,
  status,
}: {
  deviceId: string
  /** The device row's status, shown until the coverage detail arrives. */
  status: DeviceCoverage["status"] | undefined
}) {
  const d = useDeviceCoverage(deviceId).data
  const shown = d?.status ?? status
  if (!shown) return dash
  return (
    <span className="inline-flex items-center gap-2">
      <CoverageBadge status={shown} />
      {d && d.status !== "none" && (
        <LifetimeBar
          start={d.start}
          end={d.end}
          warningDays={d.warning_days}
          label="coverage"
          fallback={<Badge variant="secondary">Open-ended</Badge>}
        />
      )}
    </span>
  )
}

export function DeviceCoverageCard({
  deviceId,
  expected,
}: {
  deviceId: string
  /** The device's payload counts contracts: hold the card's place with the
   * loading state while they load. */
  expected?: boolean
}) {
  const q = useDeviceCoverage(deviceId)
  const { formatDate } = useDateFormat()
  if (q.isError) return <QueryError error={q.error} />
  if (q.isPending && expected)
    return (
      <Section title="Support contracts" boxed>
        <Loading />
      </Section>
    )
  const d = q.data
  if (!d || (d.contracts.length === 0 && d.hidden_contracts === 0)) return null

  const columns: SimpleColumn<DeviceCoverageContract>[] = [
    {
      id: "contract",
      header: "Contract",
      cell: (c) => (
        <Link
          to="/support-contracts/$id"
          params={{ id: c.id }}
          className="link font-mono text-xs"
        >
          {c.contract_number}
        </Link>
      ),
    },
    {
      id: "manufacturer",
      header: "Manufacturer",
      cell: (c) => c.manufacturer.name,
    },
    {
      id: "level",
      header: "Service level",
      cell: (c) => c.service_level || dash,
    },
    {
      id: "end",
      header: "Ends",
      cell: (c) =>
        c.end_date ? (
          <span className="num whitespace-nowrap">
            {formatDate(c.end_date)}
          </span>
        ) : (
          dash
        ),
    },
    {
      id: "state",
      header: "State",
      cell: (c) => <ContractStateBadge state={c.state} />,
    },
  ]

  const count = d.contracts.length + d.hidden_contracts
  const badge =
    d.flags.length > 0 ? (
      <span className="inline-flex flex-wrap gap-1">
        {d.flags.map((f) => (
          <Badge key={f.code} variant="warning">
            {f.label}
          </Badge>
        ))}
      </span>
    ) : undefined
  const hidden = d.hidden_contracts > 0 && (
    <span className="text-muted-foreground">+{d.hidden_contracts} hidden</span>
  )

  if (d.contracts.length === 0)
    return (
      <Section title="Support contracts" count={count} badge={badge}>
        <p className="text-sm text-muted-foreground">
          No contracts you can view. {hidden}
        </p>
      </Section>
    )
  return (
    <OverviewTable
      title="Support contracts"
      count={count}
      badge={badge}
      columns={columns}
      data={d.contracts}
      getRowKey={(c) => c.id}
      footer={hidden || undefined}
    />
  )
}
