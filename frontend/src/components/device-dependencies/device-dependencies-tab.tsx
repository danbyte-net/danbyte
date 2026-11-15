import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Plus, WandSparkles } from "lucide-react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  DependencyTree,
  DependencyTreeEdge,
  DeviceDependency,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { FormSelect } from "@/components/forms"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { InfoTip } from "@/components/ui/info-tip"
import { DeviceDependencyDialog } from "@/components/device-dependencies/dependency-dialog"
import type { DependencyDialogMode } from "@/components/device-dependencies/dependency-dialog"
import { DeviceDependencyDeleteDialog } from "@/components/device-dependencies/dependency-delete-dialog"
import {
  DependencyTreeView,
  EdgeButtons,
  EdgeFacts,
  childrenOf,
} from "@/components/device-dependencies/dependency-tree"
import type { EdgeActions } from "@/components/device-dependencies/dependency-tree"
import { DeviceImpactPanel } from "@/components/device-dependencies/impact-panel"
import { SuggestDependenciesDialog } from "@/components/device-dependencies/suggest-dialog"

// A device's Dependencies tab (#450): what it depends on (up) and what
// depends on it (down) as trees to a depth, its peer links, and "What if
// this fails?" - the devices that would go down or lose redundancy.

const DEPTHS = ["1", "2", "3", "5", "10"].map((v) => ({ value: v, label: v }))

type View = "tree" | "impact"

/** The ids of the dependency rows at either end of a device, for its
 * Change log (live rows only), or [] without the grant. */
export function useDeviceDependencyIds(deviceId: string, enabled: boolean) {
  const q = useQuery({
    queryKey: ["device-dependencies", "ids", deviceId],
    queryFn: () =>
      apiAll<DeviceDependency>(`/api/device-dependencies/?device=${deviceId}`),
    enabled,
  })
  return (q.data?.results ?? []).map((r) => r.id)
}

export function treeQueryOptions(id: string, depth: string) {
  return {
    queryKey: ["device-dependency-tree", id, depth],
    queryFn: () =>
      api<DependencyTree>(`/api/devices/${id}/dependencies/?depth=${depth}`),
  }
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string
  count: number
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">
          {title}
          <span className="num ml-1.5 font-normal">{count}</span>
        </h3>
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  )
}

function every(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

/** Upstreams checked less often than the root-cause hold (#450). */
function SlowUpstreams({ tree }: { tree: DependencyTree }) {
  const slow = tree.slow_upstreams ?? []
  if (slow.length === 0 || !tree.hold_seconds) return null
  return (
    <p className="flex flex-wrap items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
      Checked less often than the {tree.hold_seconds}s hold:{" "}
      {slow.map((s, i) => (
        <span key={s.id}>
          {i > 0 && ", "}
          <Link to="/devices/$id" params={{ id: s.id }} className="link">
            {s.name}
          </Link>{" "}
          ({every(s.interval_seconds)})
        </span>
      ))}
      <InfoTip>
        Root-cause alerting waits this long for an upstream before sending a
        dependent's alert. An upstream checked less often is usually seen down
        after its dependents have alerted; give it a shorter interval or the
        fast lane.
      </InfoTip>
    </p>
  )
}

export function DeviceDependenciesTab({
  device,
}: {
  device: { id: string; name: string }
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAdd = canDo("devicedependency", "add")
  const canEdit = canDo("devicedependency", "change")
  const canDelete = canDo("devicedependency", "delete")
  const [view, setView] = useState<View>("tree")
  const [depth, setDepth] = useState("3")
  const [dialog, setDialog] = useState<DependencyDialogMode | null>(null)
  const [deleting, setDeleting] = useState<DeviceDependency | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const q = useQuery({ ...treeQueryOptions(device.id, depth) })

  /** The full row behind a tree edge, for the edit and delete dialogs. */
  const withRow =
    (then: (d: DeviceDependency) => void) => (e: DependencyTreeEdge) =>
      qc
        .fetchQuery({
          queryKey: ["device-dependencies", "one", e.id],
          queryFn: () =>
            api<DeviceDependency>(`/api/device-dependencies/${e.id}/`),
        })
        .then(then, apiErrorToast)
  const actions: EdgeActions = {
    onEdit: canEdit
      ? withRow((d) => setDialog({ kind: "edit", dependency: d }))
      : undefined,
    onDelete: canDelete ? withRow(setDeleting) : undefined,
  }

  const tree = q.data
  const ups = tree ? childrenOf(tree, tree.root.id, "up").length : 0
  const downs = tree ? childrenOf(tree, tree.root.id, "down").length : 0
  const peers = tree ? tree.edges.filter((e) => e.kind === "peer") : []
  const names = new Map(
    tree ? [tree.root, ...tree.nodes].map((n) => [n.id, n] as const) : []
  )
  const anchor = { id: device.id, name: device.name }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs<View>
          label="Dependency views"
          items={[
            { value: "tree", label: "Dependencies" },
            { value: "impact", label: "What if this fails?" },
          ]}
          value={view}
          onValueChange={setView}
        />
        {view === "tree" && (
          <div className="ml-auto flex items-end gap-2">
            {canAdd && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSuggesting(true)}
              >
                <WandSparkles className="h-3.5 w-3.5" /> Suggest…
              </Button>
            )}
            <div className="w-24">
              <FormSelect
                label="Depth"
                value={depth}
                onChange={(v) => setDepth(v || "3")}
                options={DEPTHS}
              />
            </div>
          </div>
        )}
      </div>

      {view === "impact" ? (
        <DeviceImpactPanel id={device.id} name={device.name} />
      ) : q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : tree ? (
        <div className="space-y-6">
          <Section
            title="Upstream"
            count={ups}
            action={
              canAdd && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDialog({
                      kind: "add",
                      anchor: { device: anchor, as: "downstream" },
                    })
                  }
                >
                  <Plus className="h-3.5 w-3.5" /> Add upstream
                </Button>
              )
            }
          >
            {ups === 0 ? (
              <EmptyState title="Depends on nothing recorded." />
            ) : (
              <DependencyTreeView
                tree={tree}
                direction="up"
                actions={actions}
              />
            )}
            {tree.truncated.up && (
              <p className="text-[11px] text-muted-foreground">
                More beyond depth {tree.depth}.
              </p>
            )}
            <SlowUpstreams tree={tree} />
          </Section>
          <Section
            title="Dependents"
            count={downs}
            action={
              canAdd && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDialog({
                      kind: "add",
                      anchor: { device: anchor, as: "upstream" },
                    })
                  }
                >
                  <Plus className="h-3.5 w-3.5" /> Add dependents
                </Button>
              )
            }
          >
            {downs === 0 ? (
              <EmptyState title="Nothing depends on it." />
            ) : (
              <DependencyTreeView
                tree={tree}
                direction="down"
                actions={actions}
              />
            )}
            {tree.truncated.down && (
              <p className="text-[11px] text-muted-foreground">
                More beyond depth {tree.depth}.
              </p>
            )}
          </Section>
          {peers.length > 0 && (
            <Section title="Peers" count={peers.length}>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {peers.map((e) => {
                  const otherId =
                    e.upstream === device.id ? e.downstream : e.upstream
                  const other = names.get(otherId)
                  return (
                    <li
                      key={e.id}
                      className="flex min-h-9 items-center gap-2 px-3 py-1"
                    >
                      {other && !other.hidden ? (
                        <Link
                          to="/devices/$id"
                          params={{ id: other.id }}
                          className="link text-[13px] font-medium"
                        >
                          {other.name}
                        </Link>
                      ) : (
                        <span className="text-[13px] text-muted-foreground">
                          Hidden
                        </span>
                      )}
                      <EdgeFacts edge={e} />
                      <EdgeButtons edge={e} actions={actions} />
                    </li>
                  )
                })}
              </ul>
            </Section>
          )}
        </div>
      ) : null}

      {dialog && (
        <DeviceDependencyDialog
          mode={dialog}
          open
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
      <SuggestDependenciesDialog
        open={suggesting}
        onOpenChange={setSuggesting}
        core={anchor}
      />
      <DeviceDependencyDeleteDialog
        dependency={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}
