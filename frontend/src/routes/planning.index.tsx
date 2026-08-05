import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api, type Paginated, type PlanningBoard } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { FormText } from "@/components/forms"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/planning/")({
  component: BoardListPage,
})

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
}

function BoardListPage() {
  const { canDo } = useMe()
  const canAdd = canDo("board", "add")
  const [creating, setCreating] = useState(false)

  const q = useQuery({
    queryKey: ["planning-boards"],
    queryFn: () => api<Paginated<PlanningBoard>>("/api/planning/boards/"),
  })
  const rows = q.data?.results ?? []

  const columns = useMemo<ColumnDef<PlanningBoard>[]>(
    () => [
      {
        id: "name",
        header: "Board",
        cell: ({ row }) => (
          <Link
            to="/planning/$boardId"
            params={{ boardId: row.original.id }}
            className="font-medium text-primary hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.description || "—"}
          </span>
        ),
      },
      {
        id: "tasks",
        header: "Tasks",
        cell: ({ row }) => row.original.task_count,
      },
    ],
    []
  )

  return (
    <ListPageShell
      title="Planning"
      count={rows.length}
      query={q}
      actions={
        canAdd && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New board
          </Button>
        )
      }
    >
      {rows.length === 0 ? (
        <EmptyState title="No boards yet.">
          A board is a kanban surface for a team or a project — "DC migration",
          "Daily ops". Tasks on it can link straight to devices, prefixes,
          circuits and anything else Danbyte knows about.
        </EmptyState>
      ) : (
        <DataTable data={rows} columns={columns} tableId="planning-boards" />
      )}
      {creating && (
        <CreateBoardDialog open={creating} onOpenChange={setCreating} />
      )}
    </ListPageShell>
  )
}

function CreateBoardDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")

  const create = useMutation({
    mutationFn: () =>
      api<PlanningBoard>("/api/planning/boards/", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          slug: slugify(name),
          description,
        }),
      }),
    onSuccess: () => {
      toast.success("Board created")
      qc.invalidateQueries({ queryKey: ["planning-boards"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New board</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            required
            placeholder="DC migration"
          />
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="optional"
          />
          <p className="text-[11px] text-muted-foreground">
            New boards start with Backlog, To do, In progress and Done — rename,
            recolor or replace them under Statuses.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
