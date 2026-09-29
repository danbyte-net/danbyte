// A port renders on one side of its card - the side facing its neighbour -
// and its React Flow handle id is the port name plus a side suffix, which
// the edge names too. Left is the bare name, so an edge without a side
// still resolves. The Hierarchy's port chips and the site and location
// cards' four sides use it.

export type PortSide = "L" | "R" | "T" | "B"

const SUFFIX: Record<PortSide, string> = { L: "", R: "~r", T: "~t", B: "~b" }

export function handleId(name: string, side: PortSide): string {
  return name + SUFFIX[side]
}
