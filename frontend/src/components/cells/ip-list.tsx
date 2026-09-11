import { Link } from "@tanstack/react-router"

import { dash } from "@/components/cells/dash"

/** The addresses on one interface, in a table cell (#149).
 *
 * Separated by a divider rather than by whitespace: several addresses set
 * side by side read as one run of digits, and the first thing anyone does is
 * count the dots to work out where one ends and the next begins.
 *
 * The divider trails its address instead of leading the next one, so a
 * wrapped line ends "10.0.0.1 |" and reads as continuing - a line that opens
 * with a bare "|" looks like a stray mark. Wrapping, rather than one address
 * per line, keeps the rows of a table the same height, which is what makes a
 * long interface list scannable.
 */
export function IpListCell({
  ips,
}: {
  ips: { id: string; ip_address: string }[]
}) {
  if (ips.length === 0) return dash
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {ips.map((ip, i) => (
        <span key={ip.id} className="inline-flex items-center gap-x-1.5">
          <Link
            to="/ips/$id"
            params={{ id: ip.id }}
            className="link font-mono text-xs"
          >
            {ip.ip_address}
          </Link>
          {i < ips.length - 1 && (
            <span aria-hidden className="text-muted-foreground/40 select-none">
              |
            </span>
          )}
        </span>
      ))}
    </div>
  )
}
