import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DeviceCoverage, DeviceCoverageContract } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { Badge } from "@/components/ui/badge"
import { Section } from "@/components/ui/section"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { QueryError } from "@/components/query-error"
import { dash } from "@/components/cells/dash"
import {
  ContractStateBadge,
  CoverageBadge,
} from "@/components/cells/coverage-cell"

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

/** The status pill and the end date - the overview's "Support coverage" row. */
export function CoverageSummary({
  status,
  end,
}: {
  status: DeviceCoverage["status"] | undefined
  end: string | null | undefined
}) {
  const { formatDate } = useDateFormat()
  if (!status) return dash
  return (
    <span className="inline-flex items-center gap-2">
      <CoverageBadge status={status} />
      {end && (
        <span className="num text-xs text-muted-foreground">
          until {formatDate(end)}
        </span>
      )}
    </span>
  )
}

export function DeviceCoverageCard({ deviceId }: { deviceId: string }) {
  const q = useDeviceCoverage(deviceId)
  const { formatDate } = useDateFormat()
  if (q.isError) return <QueryError error={q.error} />
  const d = q.data
  if (!d || (d.contracts.length === 0 && d.hidden_contracts === 0)) return null

  const columns: SimpleColumn<DeviceCoverageContract>[] = [
    {
      id: "contract",
      header: "Contract",
      flex: true,
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
      align: "right",
      cell: (c) => <ContractStateBadge state={c.state} />,
    },
  ]

  return (
    <Section
      title="Support contracts"
      count={d.contracts.length + d.hidden_contracts}
      badge={
        d.flags.length > 0 ? (
          <span className="inline-flex flex-wrap gap-1">
            {d.flags.map((f) => (
              <Badge key={f.code} variant="warning">
                {f.label}
              </Badge>
            ))}
          </span>
        ) : undefined
      }
    >
      <SimpleTable
        columns={columns}
        data={d.contracts}
        getRowKey={(c) => c.id}
        empty="No contracts you can view."
      />
      {d.hidden_contracts > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          +{d.hidden_contracts} hidden
        </p>
      )}
    </Section>
  )
}
