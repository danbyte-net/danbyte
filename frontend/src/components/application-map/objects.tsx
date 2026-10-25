import { useMemo } from "react"

import {
  FoldableGroup,
  ObjectRow,
  VisibilityToggle,
} from "@/components/foldable-group"
import {
  ObjectsEmpty,
  ObjectsPanel,
  ObjectsSection,
} from "@/components/objects-panel"

import type { AppCardNode, AppMapGraph, AppMapView } from "./model"

// The Application map's Objects sidebar (#163), the maps' shared one: the
// search box, the hidden row, then the cards by kind - applications and
// hosts in the Tree, each application's flow ends in Flows - each row
// selecting its card and with its eye.

const FOLD_KEY = "app-map:objects-fold"

export function AppMapObjects({
  view,
  graph,
  query,
  onQueryChange,
  matched,
  hidden,
  onHiddenChange,
  onPick,
}: {
  view: AppMapView
  /** The whole map, hidden cards included. */
  graph: AppMapGraph
  query: string
  onQueryChange: (q: string) => void
  matched: Set<string> | null
  hidden: ReadonlySet<string>
  onHiddenChange: (next: Set<string>) => void
  onPick: (node: AppCardNode) => void
}) {
  const groups = useMemo(() => {
    const out = new Map<string, AppCardNode[]>()
    for (const n of graph.nodes) {
      if (matched && !matched.has(n.id)) continue
      const ref = n.data.ref
      const key =
        ref.kind === "application"
          ? "Applications"
          : ref.kind === "host"
            ? "Hosts"
            : ref.application.name
      ;(out.get(key) ?? out.set(key, []).get(key)!).push(n)
    }
    for (const list of out.values())
      list.sort((a, b) =>
        a.data.name.localeCompare(b.data.name, undefined, { numeric: true })
      )
    return [...out.entries()]
  }, [graph.nodes, matched])

  const total = groups.reduce((s, [, l]) => s + l.length, 0)
  const setShown = (ids: readonly string[], shown: boolean) => {
    const next = new Set(hidden)
    for (const id of ids) {
      if (shown) next.delete(id)
      else next.add(id)
    }
    onHiddenChange(next)
  }

  return (
    <ObjectsPanel
      total={total}
      query={query}
      onQueryChange={onQueryChange}
      hiddenCount={graph.nodes.filter((n) => hidden.has(n.id)).length}
      onShowAll={() => onHiddenChange(new Set())}
    >
      {total === 0 ? (
        <ObjectsEmpty filtered={!!matched} />
      ) : (
        <ObjectsSection heading={view === "tree" ? "Cards" : "Flow ends"}>
          {groups.map(([name, list]) => {
            const ids = list.map((n) => n.id)
            const shown = ids.some((id) => !hidden.has(id))
            return (
              <FoldableGroup
                key={name}
                name={name}
                count={list.length}
                storageId={FOLD_KEY}
                visibility={{
                  shown,
                  onChange: (v) => setShown(ids, v),
                  what: name,
                }}
              >
                {list.map((n) => {
                  const off = hidden.has(n.id)
                  return (
                    <ObjectRow
                      key={n.id}
                      onClick={() => onPick(n)}
                      className="pl-6 text-[12px]"
                      trailing={
                        <VisibilityToggle
                          vis={{
                            shown: !off,
                            onChange: (v) => setShown([n.id], v),
                            what: n.data.name,
                          }}
                        />
                      }
                    >
                      <span
                        className={
                          off
                            ? "min-w-0 truncate text-muted-foreground/60"
                            : "min-w-0 truncate"
                        }
                      >
                        {n.data.name}
                      </span>
                      {n.data.input.lines[0] && (
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                          {n.data.ref.kind === "end"
                            ? n.data.input.lines[0].text
                            : ""}
                        </span>
                      )}
                    </ObjectRow>
                  )
                })}
              </FoldableGroup>
            )
          })}
        </ObjectsSection>
      )}
    </ObjectsPanel>
  )
}
