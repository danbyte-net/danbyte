import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"

import type {
  ModelPackCheck,
  ModelPackDetail,
  ModelPackImport,
  ModelPackNeed,
  ModelPackOutcome,
  ModelPackSection,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DataTable } from "@/components/data-table"
import { FormCheckbox } from "@/components/forms/checkbox"
import {
  buildModelPackFindingColumns,
  buildModelPackTypeColumns,
  packLabel,
} from "@/components/columns/model-pack-columns"

// What a pack's or a bundle's check found, and what its install did: shared
// by the install dialog and the pack's page (docs/dcim/model-packs.md).

/** One pack's check and dry run: counts, the types, the findings. */
export function PackCheckReport({
  heading,
  license,
  check,
  dry,
  installed,
}: {
  heading?: string
  license?: string
  check: ModelPackCheck
  dry: ModelPackImport | null
  installed?: { version: string } | null
}) {
  const typeColumns = useMemo(() => buildModelPackTypeColumns(), [])
  const findingColumns = useMemo(() => buildModelPackFindingColumns(), [])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {heading && <span className="font-medium">{heading}</span>}
        {license && <Badge variant="secondary">{license}</Badge>}
        {dry && <Badge variant="secondary">{dry.created} to create</Badge>}
        {dry && <Badge variant="secondary">{dry.matched} to update</Badge>}
        <CheckCounts check={check} />
        {installed && (
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            Installed: {installed.version}
          </span>
        )}
      </div>
      {dry && dry.types.length > 0 && (
        <DataTable
          data={dry.types}
          columns={typeColumns}
          tableId="model-pack-types"
          flexColumn="notes"
          autoColumns={false}
        />
      )}
      {check.findings.length > 0 && (
        <DataTable
          data={check.findings}
          columns={findingColumns}
          tableId="model-pack-findings"
          flexColumn="message"
          autoColumns={false}
        />
      )}
    </div>
  )
}

function CheckCounts({ check }: { check: ModelPackCheck }) {
  return (
    <>
      {check.errors > 0 && (
        <Badge variant="destructive">
          {check.errors} error{check.errors === 1 ? "" : "s"}
        </Badge>
      )}
      {check.warnings > 0 && (
        <Badge variant="warning">
          {check.warnings} warning{check.warnings === 1 ? "" : "s"}
        </Badge>
      )}
    </>
  )
}

/** The check's outcome of a lone pack. */
export function ModelPackReport({ pack }: { pack: ModelPackDetail }) {
  const check = pack.report.check
  const dry = pack.report.import
  if (pack.report.refusals?.length)
    return <Refusals items={pack.report.refusals} />
  if (!check || !dry) return null
  return (
    <PackCheckReport
      heading={`${packLabel(pack)} ${pack.version}`.trim()}
      license={pack.license}
      check={check}
      dry={dry}
      installed={pack.report.installed}
    />
  )
}

function Refusals({ items }: { items: string[] }) {
  return (
    <ul className="space-y-0.5 text-sm text-destructive">
      {items.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  )
}

const SECTION_STATUS = {
  ready: { label: "Ready", variant: "success" },
  errors: { label: "Errors", variant: "destructive" },
  installed: { label: "Installed", variant: "secondary" },
  update: { label: "Update", variant: "info" },
} as const

export function SectionStatusBadge({
  status,
}: {
  status: ModelPackSection["status"]
}) {
  const s = SECTION_STATUS[status]
  return <Badge variant={s.variant}>{s.label}</Badge>
}

/** What a pack needs: each required pack and where it stands. A missing
 * one the pack catalog offers takes an "Install with it" tick when
 * ``onWith`` is given. */
export function NeedsLine({
  needs,
  withPacks,
  onWith,
  label = true,
}: {
  needs: ModelPackNeed[]
  withPacks?: string[]
  onWith?: (id: string, on: boolean) => void
  /** Off where the row already says "Needs". */
  label?: boolean
}) {
  if (!needs.length) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {label && (
        <span className="whitespace-nowrap text-muted-foreground">Needs</span>
      )}
      {needs.map((n) => (
        <span
          key={n.id}
          className="inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          <span className="font-mono">{n.id}</span>
          {n.state === "bundle" ? (
            <Badge variant="secondary">In bundle</Badge>
          ) : n.state === "installed" ? (
            <Badge variant="success">Installed {n.installed}</Badge>
          ) : (
            <>
              <Badge variant="warning">Missing</Badge>
              {n.available && onWith ? (
                <FormCheckbox
                  label={`Install with it (${n.available.version})`}
                  checked={!!withPacks?.includes(n.id)}
                  onChange={(on) => onWith(n.id, on)}
                />
              ) : n.zip ? (
                <span className="text-muted-foreground">Get {n.zip}</span>
              ) : null}
            </>
          )}
        </span>
      ))}
    </div>
  )
}

/** A bundle's check: its own problems, then a row per pack with a tick,
 * its status, what it needs and, unfolded, its check and dry run. Without
 * ``onPick`` the rows are read-only. */
export function BundleReport({
  pack,
  picked,
  onPick,
  withPacks,
  onWith,
}: {
  pack: ModelPackDetail
  picked?: string[]
  onPick?: (id: string, on: boolean) => void
  withPacks?: string[]
  onWith?: (id: string, on: boolean) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  if (pack.report.refusals?.length)
    return <Refusals items={pack.report.refusals} />
  const sections = pack.report.packs ?? []
  const problems = pack.report.problems ?? []
  return (
    <div className="space-y-3">
      {pack.report.bundle?.description && (
        <p className="text-sm text-muted-foreground">
          {pack.report.bundle.description}
        </p>
      )}
      {problems.length > 0 && (
        <ul className="space-y-1 text-sm">
          {problems.map((p, i) => (
            <li key={i} className="flex items-start gap-2">
              <Badge variant={p.level === "error" ? "destructive" : "warning"}>
                {p.level === "error" ? "Error" : "Warning"}
              </Badge>
              <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}
      {pack.report.catalog_error && (
        <p className="text-xs text-muted-foreground">
          Pack catalog: {pack.report.catalog_error}
        </p>
      )}
      <div className="divide-y rounded-md border">
        {sections.map((s) => {
          const unfolded = open === s.id
          return (
            <div key={s.id} className="space-y-2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                {onPick && (
                  <Checkbox
                    checked={s.installable && !!picked?.includes(s.id)}
                    disabled={!s.installable}
                    onCheckedChange={(v) => onPick(s.id, !!v)}
                    aria-label={`Install ${s.name}`}
                  />
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setOpen(unfolded ? null : s.id)}
                  aria-expanded={unfolded}
                  aria-label={unfolded ? "Fold" : "Unfold"}
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      unfolded && "rotate-90"
                    )}
                  />
                </Button>
                <span className="font-medium whitespace-nowrap">{s.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {s.version}
                </span>
                <SectionStatusBadge status={s.status} />
                {s.import && (
                  <span className="text-xs whitespace-nowrap text-muted-foreground">
                    {s.import.created} to create · {s.import.matched} to update
                  </span>
                )}
                <CheckCounts check={s.check} />
                {s.installed && s.status === "update" && (
                  <span className="text-xs whitespace-nowrap text-muted-foreground">
                    Installed: {s.installed.version}
                  </span>
                )}
              </div>
              <div className="pl-12">
                <NeedsLine
                  needs={s.needs}
                  withPacks={withPacks}
                  onWith={onWith}
                />
              </div>
              {unfolded && (
                <PackCheckReport
                  license={s.license}
                  check={s.check}
                  dry={s.import}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const OUTCOME = {
  installed: { label: "Installed", variant: "success" },
  skipped: { label: "Skipped", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  refused: { label: "Refused", variant: "destructive" },
} as const

/** What an install did with each pack: installed (with a link to its
 * record), skipped or failed, and why. */
export function InstallOutcomes({
  outcomes,
  onOpen,
}: {
  outcomes: ModelPackOutcome[]
  onOpen?: () => void
}) {
  if (!outcomes.length) return null
  return (
    <ul className="divide-y rounded-md border text-sm">
      {outcomes.map((o) => (
        <li
          key={`${o.via ?? ""}${o.id}`}
          className="flex flex-wrap items-center gap-2 px-3 py-2"
        >
          {o.record ? (
            <Link
              to="/settings/device-library/packs/$id"
              params={{ id: o.record }}
              className="link font-medium whitespace-nowrap"
              onClick={onOpen}
            >
              {o.name}
            </Link>
          ) : (
            <span className="font-medium whitespace-nowrap">{o.name}</span>
          )}
          <span className="font-mono text-xs text-muted-foreground">
            {o.version}
          </span>
          <Badge variant={OUTCOME[o.status].variant}>
            {OUTCOME[o.status].label}
          </Badge>
          {o.via === "requires" && <Badge variant="secondary">Required</Badge>}
          {o.status === "installed" && (
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {o.created ?? 0} created · {o.matched ?? 0} updated
            </span>
          )}
          {o.reason && (
            <span className="text-xs text-muted-foreground">{o.reason}</span>
          )}
          {o.superseded?.length ? (
            <span className="text-xs text-muted-foreground">
              Replaces {o.superseded.join(", ")}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
