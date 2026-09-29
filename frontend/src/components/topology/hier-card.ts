import type { TopoNode } from "@/lib/api"
import type { Measure } from "@/lib/diagram/measure"
import { cardContent, withCardLines } from "./diagram/card-fields"
import type { CardContentOptions } from "./diagram/card-fields"
import { cardLayout } from "./diagram/card-layout"
import type { CardBox } from "./diagram/card-layout"

// The Hierarchy card's header: the Diagram's Simple card - the role's
// colour, the name bold, the card lines under it, the status pill in the
// top-left corner - laid out by the same code (card-layout.ts), so the
// two tabs and the exports agree. The port chips hang below it on the
// neutral card body. No React here: the layout sizes cards from it.

/** A Hierarchy card is never narrower than this: its port chips face
 * both ways under the header. */
export const HIER_MIN_W = 190

/** What the sizing reads off a Hierarchy node's data. */
export type HierCardData = { hierCard?: CardBox | null }

/** A device's header box: its card lines (`include=card`, else its
 * primary IP) and room for every pill its field list can show, so a
 * monitoring change never resizes a card. */
export function hierCardBox(
  data: TopoNode["data"],
  opts: Pick<CardContentOptions, "checkLabels"> & { measure?: Measure } = {}
): CardBox {
  const content = cardContent(withCardLines(data), {
    checkLabels: opts.checkLabels,
  })
  return cardLayout(
    {
      name: content.name,
      color: data.role?.color,
      lines: content.lines,
      pillSlot: content.pillSlot,
    },
    null,
    opts.measure
  )
}

/** The header box the build laid the card out with, if it did. */
export function hierBox(d: unknown): CardBox | null {
  return (d as HierCardData | null)?.hierCard ?? null
}
