import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronsUpDown } from "lucide-react"

import {
  api,
  type PlanningAssignableGroup,
  type PlanningAssignableUser,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Field } from "@/components/forms"

/** Multi-select assignee picker. Value is user ids.
 *
 * Reads /api/planning/assignable-users/, not /api/users/ - the latter is gated
 * on `user.view`, so anyone with task rights but no user-administration grant
 * got a 403 and an empty picker, making assignment quietly admin-only.
 *
 * When `onTeamChange` is given, the popover also offers the access groups as
 * a single-select **Team** section (the ITSM assignment group): the queue the
 * task sits in, while the ticked users are the individuals doing it. */
export function UserPicker({
  label = "Assignees",
  value,
  onChange,
  team = null,
  onTeamChange,
  /** Drop the labelled `Field` wrapper and the full-width outline button - for
   *  the task sheet's property list, where the value itself is the control. */
  bare = false,
}: {
  label?: string
  value: number[]
  onChange: (ids: number[]) => void
  team?: number | null
  onTeamChange?: (id: number | null) => void
  bare?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const { me } = useMe()
  const usersQ = useQuery({
    queryKey: ["planning-assignable-users"],
    queryFn: () =>
      api<{ results: PlanningAssignableUser[] }>(
        "/api/planning/assignable-users/"
      ),
    staleTime: 60_000,
  })
  const groupsQ = useQuery({
    queryKey: ["planning-assignable-groups"],
    queryFn: () =>
      api<{ results: PlanningAssignableGroup[] }>(
        "/api/planning/assignable-groups/"
      ),
    staleTime: 60_000,
    enabled: !!onTeamChange,
  })
  const allGroups = groupsQ.data?.results ?? []
  const groups = allGroups.filter(
    (g) => !q || g.name.toLowerCase().includes(q.toLowerCase())
  )
  const all = usersQ.data?.results ?? []
  const users = all.filter(
    (u) =>
      !q ||
      u.username.toLowerCase().includes(q.toLowerCase()) ||
      u.display_name.toLowerCase().includes(q.toLowerCase()) ||
      (u.email ?? "").toLowerCase().includes(q.toLowerCase())
  )
  const selected = new Set(value)
  const teamName = allGroups.find((g) => g.id === team)?.name ?? null
  const names = all
    .filter((u) => selected.has(u.id))
    .map((u) => u.display_name)
    .join(", ")
  const summary =
    value.length === 0
      ? (teamName ?? "Unassigned")
      : teamName
        ? `${teamName} · ${names || `${value.length} selected`}`
        : names || `${value.length} selected`

  const toggle = (id: number) =>
    onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id])

  const self = all.find((u) => u.username === me.username)

  const picker = (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={bare ? "ghost" : "outline"}
            size={bare ? "sm" : "default"}
            className={
              bare
                ? "-ml-1.5 h-7 max-w-full justify-start gap-1 px-1.5 font-normal"
                : "w-full justify-between font-normal"
            }
          >
            <span
              className={
                bare && value.length === 0
                  ? "truncate text-[12px] text-muted-foreground"
                  : "truncate"
              }
            >
              {summary}
            </span>
            {!bare && (
              <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-2" align="start">
          <div className="mb-2 flex items-center gap-2">
            <Input
              placeholder="Search users…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-8"
            />
            {self && !selected.has(self.id) && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="shrink-0"
                onClick={() => toggle(self.id)}
              >
                Me
              </Button>
            )}
          </div>
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {onTeamChange && groups.length > 0 && (
              <>
                <p className="px-2 pt-1 pb-0.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Team
                </p>
                {groups.map((g) => (
                  <label
                    key={`g-${g.id}`}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-muted"
                  >
                    <Checkbox
                      checked={team === g.id}
                      onCheckedChange={() =>
                        onTeamChange(team === g.id ? null : g.id)
                      }
                    />
                    <span className="truncate">{g.name}</span>
                    <span className="num ml-auto text-[11px] text-muted-foreground">
                      {g.member_count}
                    </span>
                  </label>
                ))}
                <p className="px-2 pt-1 pb-0.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
                  People
                </p>
              </>
            )}
            {users.map((u) => (
              <label
                key={u.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-muted"
              >
                <Checkbox
                  checked={selected.has(u.id)}
                  onCheckedChange={() => toggle(u.id)}
                />
                <span className="truncate">{u.display_name}</span>
                {u.email && (
                  <span className="ml-auto truncate text-[11px] text-muted-foreground">
                    {u.email}
                  </span>
                )}
              </label>
            ))}
            {users.length === 0 && (
              <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                {usersQ.isLoading ? "Loading..." : "No users match."}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
  return bare ? picker : <Field label={label}>{picker}</Field>
}
