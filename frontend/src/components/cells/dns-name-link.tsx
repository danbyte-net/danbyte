import { Link } from "@tanstack/react-router"

import { useDnsEnabled } from "@/components/integrations/dns-records-table"
import { dash } from "@/components/cells/dash"
import { cn } from "@/lib/utils"

/** A DNS name, linked to everything Danbyte knows about it.
 *
 * The single place that decides linked-vs-plain, because a DNS name is rendered
 * in a dozen places and they were all dead text before this existed.
 *
 * The link targets the **name**, not a record row. That is deliberate: the sync
 * keys records on `(zone, name, type, data)` and prunes by the same tuple, so
 * repointing an A record deletes its row and mints a new id - an id-shaped link
 * would break at exactly the moment the record changed. Names outlive values.
 *
 * Stays plain text when there is no name, and when the DNS integration is off
 * entirely - with no zones synced there is nothing on the far side worth a
 * click. */
export function DnsNameLink({
  name,
  className,
  zone,
}: {
  name?: string | null
  /** Optional: narrow the page to one zone, for split-horizon names. */
  zone?: string
  className?: string
}) {
  const dnsOn = useDnsEnabled()
  const clean = (name ?? "").trim()
  if (!clean) return dash
  if (!dnsOn) return <span className={cn("font-mono", className)}>{clean}</span>
  return (
    <Link
      to="/dns-names/$name"
      params={{ name: clean.replace(/\.$/, "") }}
      search={{ zone }}
      className={cn("link font-mono", className)}
    >
      {clean}
    </Link>
  )
}
