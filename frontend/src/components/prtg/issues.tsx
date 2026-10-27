import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"

import type { PrtgIssue } from "@/lib/api"

/**
 * Whether applying a planned change writes to PRTG. On since the writes
 * landed; it changes every "planned only" line at once.
 */
export const PRTG_WRITES_LIVE = true

/** The line under the PRTG details on the Monitoring tab, before and after
 * the writes. */
export function prtgPlanFootnote(writesLive: boolean): string {
  return writesLive
    ? "Planned only: nothing is written to PRTG until applied in the Review queue."
    : "Planned only: nothing is written to PRTG yet."
}

export const PRTG_PLAN_FOOTNOTE = prtgPlanFootnote(PRTG_WRITES_LIVE)

type ObjectRef = { kind: "device" | "virtual_machine"; id: string }
/** An issue, or a bare sentence from an older server. */
type IssueLike = Omit<PrtgIssue, "code"> & { code?: PrtgIssue["code"] }

function ObjectLink({
  object,
  tab,
  edit,
  children,
}: {
  object: ObjectRef
  tab?: string
  edit?: boolean
  children: ReactNode
}) {
  if (object.kind === "device")
    return edit ? (
      <Link to="/devices/$id/edit" params={{ id: object.id }} className="link">
        {children}
      </Link>
    ) : (
      <Link
        to="/devices/$id"
        params={{ id: object.id }}
        search={tab ? { tab: tab as "access" } : {}}
        className="link"
      >
        {children}
      </Link>
    )
  return edit ? (
    <Link
      to="/virtual-machines/$id/edit"
      params={{ id: object.id }}
      className="link"
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/virtual-machines/$id"
      params={{ id: object.id }}
      search={tab ? { tab } : {}}
      className="link"
    >
      {children}
    </Link>
  )
}

function PolicyEditLink({ id }: { id: string }) {
  return (
    <Link to="/prtg" search={{ tab: "policies", edit: id }} className="link">
      Edit policy
    </Link>
  )
}

export function ConnectionLink({ label = "Register all" }: { label?: string }) {
  return (
    <Link
      to="/prtg"
      search={{ tab: "overview" }}
      hash="registration"
      className="link"
    >
      {label}
    </Link>
  )
}

function PoliciesLink() {
  return (
    <Link to="/prtg" search={{ tab: "policies" }} className="link">
      Policies
    </Link>
  )
}

/** Where to fix an issue, as links. `object` stands in when the issue does
 * not name one (the Monitoring tab knows its own object). */
export function prtgIssueLinks(
  issue: IssueLike,
  object?: ObjectRef
): ReactNode[] {
  const target = issue.object ?? object
  switch (issue.code) {
    case "no_group":
    case "group_gone":
      return [
        issue.policy ? <PolicyEditLink key="policy" id={issue.policy} /> : null,
        <ConnectionLink key="conn" />,
      ]
    case "no_writes":
      return [<ConnectionLink key="conn" label="Connection" />]
    case "no_match":
      return [
        <PoliciesLink key="policies" />,
        target ? (
          <ObjectLink key="obj" object={target} edit>
            Monitor in PRTG
          </ObjectLink>
        ) : null,
        <ConnectionLink key="conn" />,
      ]
    case "retired":
    case "address_excluded":
    case "excluded":
      return target
        ? [
            <ObjectLink key="obj" object={target} edit>
              Edit {target.kind === "device" ? "device" : "VM"}
            </ObjectLink>,
          ]
        : []
    case "no_snmp":
    case "snmp_scan":
      return target
        ? [
            <ObjectLink
              key="obj"
              object={target}
              tab={target.kind === "device" ? "access" : "snmp"}
            >
              {target.kind === "device" ? "Access" : "SNMP"}
            </ObjectLink>,
          ]
        : []
    case "no_windows":
      return target
        ? [
            <ObjectLink key="obj" object={target} tab="access">
              Access
            </ObjectLink>,
          ]
        : []
    case "no_address":
      return target
        ? [
            <ObjectLink key="ips" object={target} tab="ips">
              Set a primary address
            </ObjectLink>,
            <ObjectLink key="obj" object={target} edit>
              Edit {target.kind === "device" ? "device" : "VM"}
            </ObjectLink>,
          ]
        : []
    default:
      return []
  }
}

/** One issue: its sentence, then the places that fix it. */
export function PrtgIssueLine({
  issue,
  object,
  className = "text-xs text-amber-600 dark:text-amber-400",
}: {
  issue: IssueLike
  object?: ObjectRef
  className?: string
}) {
  const links = prtgIssueLinks(issue, object).filter(Boolean)
  return (
    <p className={className} data-testid="prtg-issue">
      {issue.text}
      {links.length > 0 && (
        <span className="ml-2 inline-flex flex-wrap gap-2 text-foreground">
          {links}
        </span>
      )}
    </p>
  )
}
