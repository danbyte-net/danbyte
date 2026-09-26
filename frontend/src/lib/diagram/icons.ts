import type { NoteIcon } from "./types"

// The Lucide icons a diagram note can carry, as Lucide's own icon nodes
// (lucide-react 1.18, ISC licence) so the writers can draw them without
// React. Verbatim copies, not artwork: theme.test.ts holds them equal to the
// installed package. Drawn on Lucide's 24px grid with its stroke settings.

export type IconNode = ["path" | "circle" | "rect", Record<string, string>][]

export const NOTE_ICONS: Record<NoteIcon, IconNode> = {
  cloud: [
    ["path", { d: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" }],
  ],
  globe: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" }],
    ["path", { d: "M2 12h20" }],
  ],
  building: [
    ["path", { d: "M12 10h.01" }],
    ["path", { d: "M12 14h.01" }],
    ["path", { d: "M12 6h.01" }],
    ["path", { d: "M16 10h.01" }],
    ["path", { d: "M16 14h.01" }],
    ["path", { d: "M16 6h.01" }],
    ["path", { d: "M8 10h.01" }],
    ["path", { d: "M8 14h.01" }],
    ["path", { d: "M8 6h.01" }],
    ["path", { d: "M9 22v-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" }],
    ["rect", { x: "4", y: "2", width: "16", height: "20", rx: "2" }],
  ],
}
