import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { ChevronDown, ChevronRight, Pencil, Trash2 } from "lucide-react"

import type {
  CheckStatus,
  DependencyTree,
  DependencyTreeEdge,
  DependencyTreeNode,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/status-badge"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { DependencyMediumBadge } from "@/components/dependency-medium-badge"

/** Which way a tree reads from its root: up to what the device depends
 * on, or down to what depends on it. */
export type TreeDirection = "up" | "down"

export interface EdgeActions {
  onEdit?: (edge: DependencyTreeEdge) => void
  onDelete?: (edge: DependencyTreeEdge) => void
}

/** The child edges of ``node`` in ``direction``, with the node at their
 * far end. */
export function childrenOf(
  tree: DependencyTree,
  node: string,
  direction: TreeDirection
): DependencyTreeEdge[] {
  return tree.edges.filter(
    (e) =>
      e.kind === "dependency" &&
      (direction === "up" ? e.downstream === node : e.upstream === node)
  )
}

function NodeLabel({ node }: { node: DependencyTreeNode | undefined }) {
  if (!node || node.hidden)
    return <span className="text-[13px] text-muted-foreground">Hidden</span>
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Link
        to="/devices/$id"
        params={{ id: node.id }}
        className="link truncate text-[13px] font-medium"
      >
        {node.name}
      </Link>
      {node.status && <StatusBadge status={node.status} />}
      {node.check && <CheckStatusBadge status={node.check as CheckStatus} />}
    </span>
  )
}

/** One edge's facts: its medium pill and its redundancy group. */
export function EdgeFacts({ edge }: { edge: DependencyTreeEdge }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {edge.medium && <DependencyMediumBadge medium={edge.medium} />}
      {edge.redundancy_group && (
        <Badge variant="outline" className="font-mono">
          {edge.redundancy_group}
        </Badge>
      )}
    </span>
  )
}

export function EdgeButtons({
  edge,
  actions,
}: {
  edge: DependencyTreeEdge
  actions: EdgeActions
}) {
  return (
    <span className="ml-auto inline-flex shrink-0 items-center">
      {actions.onEdit && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Edit dependency"
          onClick={() => actions.onEdit!(edge)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
      {actions.onDelete && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-destructive hover:text-destructive"
          aria-label="Delete dependency"
          onClick={() => actions.onDelete!(edge)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </span>
  )
}

function Branch({
  tree,
  nodes,
  edge,
  direction,
  path,
  actions,
}: {
  tree: DependencyTree
  nodes: Map<string, DependencyTreeNode>
  edge: DependencyTreeEdge
  direction: TreeDirection
  path: Set<string>
  actions: EdgeActions
}) {
  const [open, setOpen] = useState(true)
  const id = direction === "up" ? edge.upstream : edge.downstream
  // A device already on this path ends the branch: the walk never loops.
  const kids = path.has(id) ? [] : childrenOf(tree, id, direction)
  const next = new Set(path).add(id)
  return (
    <li data-node={nodes.get(id)?.name ?? "Hidden"}>
      <div className="flex min-h-9 items-center gap-2 px-2 py-1">
        {kids.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={open ? "Collapse" : "Expand"}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </Button>
        ) : (
          <span className="size-6 shrink-0" />
        )}
        <NodeLabel node={nodes.get(id)} />
        <EdgeFacts edge={edge} />
        <EdgeButtons edge={edge} actions={actions} />
      </div>
      {open && kids.length > 0 && (
        <ul className="ml-5 border-l border-border pl-2">
          {kids.map((k) => (
            <Branch
              key={k.id}
              tree={tree}
              nodes={nodes}
              edge={k}
              direction={direction}
              path={next}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/** The dependencies of ``tree.root`` in one direction, as a collapsible
 * tree: each device linked with its status and live check, each edge with
 * its medium and redundancy group. */
export function DependencyTreeView({
  tree,
  direction,
  actions,
}: {
  tree: DependencyTree
  direction: TreeDirection
  actions: EdgeActions
}) {
  const nodes = new Map(
    [tree.root, ...tree.nodes].map((n) => [n.id, n] as const)
  )
  const top = childrenOf(tree, tree.root.id, direction)
  if (top.length === 0) return null
  return (
    <ul className="rounded-lg border border-border py-1">
      {top.map((e) => (
        <Branch
          key={e.id}
          tree={tree}
          nodes={nodes}
          edge={e}
          direction={direction}
          path={new Set([tree.root.id])}
          actions={actions}
        />
      ))}
    </ul>
  )
}
