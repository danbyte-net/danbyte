import { Link } from "@tanstack/react-router"
import { CalendarClock, Plus } from "lucide-react"

import { OBJECT_DETAIL_ROUTES } from "@/lib/object-routes"
import { isPlanCapable } from "@/lib/save-object"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

/** Component kinds a device can contain that support planning today. Each entry
 *  is a create route that accepts `?device=` plus the plan params. */
const DEVICE_CHILDREN: { label: string; to: string }[] = [
  { label: "interface", to: "/interfaces/new" },
]

/** "Plan a change" for one linked object.
 *
 * Planning is editing: this just navigates to the object's **own** edit form
 * with the plan params attached, so the operator gets every field, the real
 * validation and the familiar layout. Nothing is offered for a type whose form
 * hasn't been migrated onto `useSaveObject` yet — otherwise saving there would
 * write to the live object while the banner promised it wouldn't. */
export function PlanActions({
  objectType,
  objectId,
  taskId,
  boardId,
}: {
  objectType: string
  objectId: string
  taskId: string
  boardId: string
}) {
  const detail = OBJECT_DETAIL_ROUTES[objectType]
  if (!detail || !isPlanCapable(objectType)) return null
  const editUrl = `${detail.replace("$id", objectId)}/edit`
  const search = { plan: taskId, planBoard: boardId }
  const isDevice = objectType === "api.device"

  if (!isDevice) {
    return (
      <Button
        asChild
        size="sm"
        variant="ghost"
        className="shrink-0 whitespace-nowrap"
        title="Open this object's edit form and record what you change"
      >
        <Link to={editUrl} search={search}>
          <CalendarClock className="h-3.5 w-3.5" /> Plan
        </Link>
      </Button>
    )
  }

  // A device can also gain new children, so it gets a menu rather than a button.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 whitespace-nowrap"
        >
          <CalendarClock className="h-3.5 w-3.5" /> Plan
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem asChild>
          <Link to={editUrl} search={search} className="whitespace-nowrap">
            <CalendarClock className="h-3.5 w-3.5" /> Plan a change
          </Link>
        </DropdownMenuItem>
        {DEVICE_CHILDREN.map((child) => (
          <DropdownMenuItem key={child.to} asChild>
            <Link
              to={child.to}
              search={{ ...search, device: objectId }}
              className="whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" /> Plan a new {child.label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
