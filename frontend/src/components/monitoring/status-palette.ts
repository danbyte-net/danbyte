import { useEffect, useSyncExternalStore } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { CheckStatus, CheckStatusLabel, CheckStatusLabels } from "@/lib/api"
import { STATUS_COLOR, STATUS_LABEL, STATUS_TEXT } from "./charts"

type Labels = Partial<Record<CheckStatus, CheckStatusLabel>>

/**
 * What this tenant calls each check state.
 *
 * A check always records one of the six states in `STATUS_LABEL` - that is
 * what alerting, escalation and the Outpost protocol run on. A tenant can put
 * its own name and colour on any of them by claiming it with a Status
 * (`Status.monitoring_state`), and every monitoring surface reads the claims
 * from here so the table, the rollup badge, the filter rail and the charts
 * agree.
 *
 * A plain module store rather than a query per badge: a long IP table renders
 * hundreds of badges, and hundreds of query observers on one cached result is
 * a lot of bookkeeping for six strings. `useLoadStatusLabels` in the app shell
 * does the one fetch; everything else subscribes.
 */
let snapshot: Labels = {}
const listeners = new Set<() => void>()

// SSR renders before any tenant is known, and the module lives for the whole
// server process - so the server always answers with the shipped names and the
// client fills in the tenant's after hydration. Never let one request's labels
// become another's.
const SERVER: Labels = {}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getSnapshot(): Labels {
  return snapshot
}

function getServerSnapshot(): Labels {
  return SERVER
}

function setLabels(next: Labels) {
  snapshot = next
  listeners.forEach((fn) => fn())
}

/** Subscribe a component to the tenant's names. */
export function useStatusLabels(): Labels {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** The one fetch, mounted in the app shell so the names are warm before any
 * list paints. Cached for the session - a rename is rare and a reload picks
 * it up. Skipped while nobody is signed in: the login page has no tenant. */
export function useLoadStatusLabels(enabled = true) {
  const q = useQuery({
    queryKey: ["check-status-labels"],
    queryFn: () =>
      api<CheckStatusLabels>("/api/monitoring/status-labels/"),
    staleTime: 60 * 60_000,
    enabled,
  })
  useEffect(() => {
    if (q.data) setLabels(q.data.labels)
  }, [q.data])
}

// Resolvers. The `labels` argument is what a component gets from
// `useStatusLabels`; leaving it out reads the current snapshot, which is what
// the pure helpers outside React (a column's facet definition) need.
export function statusLabel(s: CheckStatus, labels: Labels = snapshot): string {
  return labels[s]?.name || STATUS_LABEL[s] || s
}

export function statusColor(s: CheckStatus, labels: Labels = snapshot): string {
  return labels[s]?.color || STATUS_COLOR[s] || STATUS_COLOR.unknown
}

export function statusTextColor(
  s: CheckStatus,
  labels: Labels = snapshot
): string {
  // A tenant colour without a readable text colour would be a coin toss, so
  // the server computes one from the same luminance rule the badges use. A
  // status that set no colour of its own is a rename, not a repaint - it keeps
  // the shipped pair, or white text would land on the shipped light zinc.
  const claim = labels[s]
  if (claim?.color) return claim.text_color || "#fff"
  return STATUS_TEXT[s] || "#fff"
}
