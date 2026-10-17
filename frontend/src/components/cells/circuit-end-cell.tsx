import { Link } from "@tanstack/react-router"

import { dash } from "@/components/cells/dash"

/** The circuit end landing on an interface (#432): the circuit, linked, and
 * which side of it this is. */
export function CircuitEndCell({
  end,
}: {
  end:
    | { id: string; side: string; circuit: { id: string; cid: string } }
    | null
    | undefined
}) {
  if (!end) return dash
  return (
    <span className="whitespace-nowrap">
      <Link
        to="/circuits/$id"
        params={{ id: end.circuit.id }}
        className="link font-mono text-xs"
      >
        {end.circuit.cid}
      </Link>{" "}
      <span className="text-[11px] text-muted-foreground">{end.side} side</span>
    </span>
  )
}
