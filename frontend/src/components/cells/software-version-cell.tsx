import type { ColumnDef } from "@tanstack/react-table"

import type { SoftwareVersionSource } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// Software version against the platform's target version (#395).
//
//   <SoftwareVersionText version="17.9.4a" target="17.9.5" />  → 17.9.4a · target 17.9.5
//   softwareVersionColumn<Row>({ get: r => r.software_version })
//   softwareTargetColumn<Row>({ target: r => …, version: r => … })
//   <SoftwareVersionSourceText source="snmp" seenAt={…} />          → SNMP

/** "17.9.4a · target 17.9.5", the version alone without a target, nothing
 * when neither is set. */
export function softwareVersionLabel(
  version?: string | null,
  target?: string | null
): string {
  return [version, target ? `target ${target}` : ""].filter(Boolean).join(" · ")
}

export function SoftwareVersionText({
  version,
  target,
}: {
  version?: string | null
  target?: string | null
}) {
  const label = softwareVersionLabel(version, target)
  if (!label) return null
  return (
    <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">
      {label}
    </span>
  )
}

export type KnownVersionSource = Exclude<SoftwareVersionSource, "">

/** Where the version came from (#451), as a word. */
export const SOFTWARE_VERSION_SOURCE_LABELS: Record<
  KnownVersionSource,
  string
> = {
  manual: "Manual",
  snmp: "SNMP",
  virtualization: "Virtualization",
  oxidized: "Oxidized",
  import: "Import",
}

const SOURCE_HINTS: Record<KnownVersionSource, string> = {
  manual: "Typed by hand",
  snmp: "Read from SNMP sysDescr",
  virtualization: "Reported by the virtualization sync",
  oxidized: "Read from the stored configuration",
  import: "Set by a file import",
}

/** The source next to a version: muted, with where it came from (and when
 * an integration last set it) on hover. Nothing without a source. */
export function SoftwareVersionSourceText({
  source,
  seenAt,
}: {
  source?: SoftwareVersionSource | null
  seenAt?: string | null
}) {
  const { formatDateTime } = useDateFormat()
  if (!source) return null
  const hint = SOURCE_HINTS[source]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default text-[11px] whitespace-nowrap text-muted-foreground">
          {SOFTWARE_VERSION_SOURCE_LABELS[source]}
        </span>
      </TooltipTrigger>
      <TooltipContent variant="panel">
        {seenAt ? `${hint} · ${formatDateTime(seenAt)}` : hint}
      </TooltipContent>
    </Tooltip>
  )
}

export type SoftwareTargetState = "on" | "off" | "unknown"

export const SOFTWARE_TARGET_LABELS: Record<SoftwareTargetState, string> = {
  on: "On target",
  off: "Off target",
  unknown: "Unknown",
}

/** Same rule as the API's ?software_target=: unknown without a version or a
 * target. */
export function softwareTargetState(
  version?: string | null,
  target?: string | null
): SoftwareTargetState {
  if (!version || !target) return "unknown"
  return version === target ? "on" : "off"
}

function versionCell(v: string | null | undefined) {
  return v ? <span className="font-mono text-xs">{v}</span> : dash
}

/** The running version, hidden until picked from Columns. */
export function softwareVersionColumn<T>(opts: {
  get: (row: T) => string | null | undefined
}): ColumnDef<T, unknown> {
  return {
    id: "software_version",
    accessorFn: (r) => opts.get(r) ?? "",
    header: ({ column }) => (
      <SortHeader column={column} label="Software version" />
    ),
    cell: ({ row }) => versionCell(opts.get(row.original)),
    meta: {
      label: "Software version",
      defaultHidden: true,
      // `?software_version=<v>` - the Lifecycle Versions view links here.
      facet: {
        kind: "enum",
        label: "Software version",
        get: (r: T) => opts.get(r) || "__none__",
        formatValue: (v: string) => ({
          label: v === "__none__" ? "No version" : v,
        }),
      },
    },
  }
}

/** The platform's target version, hidden until picked from Columns; its
 * facet buckets rows on or off target. */
export function softwareTargetColumn<T>(opts: {
  target: (row: T) => string | null | undefined
  version: (row: T) => string | null | undefined
}): ColumnDef<T, unknown> {
  return {
    id: "software_target",
    accessorFn: (r) => opts.target(r) ?? "",
    header: ({ column }) => <SortHeader column={column} label="Target" />,
    cell: ({ row }) => versionCell(opts.target(row.original)),
    meta: {
      label: "Target",
      defaultHidden: true,
      facet: {
        kind: "enum",
        label: "Software target",
        get: (r: T) => softwareTargetState(opts.version(r), opts.target(r)),
        formatValue: (v: string) => ({
          label:
            (SOFTWARE_TARGET_LABELS as Record<string, string | undefined>)[v] ??
            v,
        }),
      },
    },
  }
}
