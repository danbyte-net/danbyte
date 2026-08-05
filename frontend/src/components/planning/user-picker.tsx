import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronsUpDown } from "lucide-react"

import { api, type Paginated, type RBACUser } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Field } from "@/components/forms"

/** Multi-select assignee picker over /api/users/. Value is user ids. */
export function UserPicker({
  label = "Assignees",
  value,
  onChange,
}: {
  label?: string
  value: number[]
  onChange: (ids: number[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const usersQ = useQuery({
    queryKey: ["users", ""],
    queryFn: () => api<Paginated<RBACUser>>("/api/users/"),
    staleTime: 60_000,
  })
  const users = (usersQ.data?.results ?? []).filter(
    (u) =>
      !q ||
      u.username.toLowerCase().includes(q.toLowerCase()) ||
      (u.email ?? "").toLowerCase().includes(q.toLowerCase())
  )
  const selected = new Set(value)
  const summary =
    value.length === 0
      ? "Unassigned"
      : (usersQ.data?.results ?? [])
          .filter((u) => selected.has(u.id))
          .map((u) => u.username)
          .join(", ") || `${value.length} selected`

  const toggle = (id: number) =>
    onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id])

  return (
    <Field label={label}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
          >
            <span className="truncate">{summary}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-2" align="start">
          <Input
            placeholder="Search users…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="mb-2 h-8"
          />
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {users.map((u) => (
              <label
                key={u.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-muted"
              >
                <Checkbox
                  checked={selected.has(u.id)}
                  onCheckedChange={() => toggle(u.id)}
                />
                <span className="truncate">{u.username}</span>
                {u.email && (
                  <span className="ml-auto truncate text-[11px] text-muted-foreground">
                    {u.email}
                  </span>
                )}
              </label>
            ))}
            {users.length === 0 && (
              <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                No users match.
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  )
}
