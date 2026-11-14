import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { LinkProps } from "@tanstack/react-router"
import {
  ChevronDown,
  CopyPlus,
  Download,
  Ellipsis,
  Pencil,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// ─── The action ribbon (#507) ────────────────────────────────────────────
//
// A page header's buttons, in one order everywhere:
//
//   Add …  ·  Edit  ·  page actions  ·  Export ▾  ·  More ▾  ·  Delete
//
// Add is the solid primary; Edit sits right beside it in the `tinted`
// primary hue, so the two ways to change data read as a pair. Page actions
// are the few an operator uses daily (Connect, Topology, Show on floor plan,
// Run). Outputs - spec sheets, reports, labels, Import / Export - fold into
// Export; rarer verbs (Clone, Sync from type, Move, Plan a change) into
// More. Delete is last and apart. `DetailShell` and `ListPageShell` lay the
// slots out; pages fill them with these parts.

/** Edit, as a link to the edit route or a button that opens a dialog. */
export function EditButton({
  to,
  params,
  search,
  onClick,
  label = "Edit",
  disabled,
}: {
  to?: LinkProps["to"]
  params?: LinkProps["params"]
  search?: LinkProps["search"]
  onClick?: () => void
  label?: string
  disabled?: boolean
}) {
  const body = (
    <>
      <Pencil className="h-3.5 w-3.5" /> {label}
    </>
  )
  if (to && !disabled)
    return (
      <Button variant="tinted" size="sm" asChild>
        <Link to={to} params={params} search={search}>
          {body}
        </Link>
      </Button>
    )
  return (
    <Button variant="tinted" size="sm" onClick={onClick} disabled={disabled}>
      {body}
    </Button>
  )
}

/** Delete - the ribbon's last control. Opens the page's confirm dialog. */
export function DeleteButton({
  onClick,
  label = "Delete",
  disabled,
}: {
  onClick: () => void
  label?: string
  disabled?: boolean
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-destructive hover:text-destructive"
      onClick={onClick}
      disabled={disabled}
    >
      <Trash2 className="h-3.5 w-3.5" /> {label}
    </Button>
  )
}

/**
 * A grouped ribbon menu - Export or More. Children are menu items. A menu
 * whose items all decline to render (no label template, no IO right) says
 * so instead of opening empty.
 */
export function RibbonMenu({
  label,
  icon,
  children,
}: {
  label: string
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {icon}
          {label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        {children}
        <DropdownMenuLabel className="font-normal whitespace-nowrap text-muted-foreground [[role=menu]:has([role=menuitem])_&]:hidden">
          Nothing available
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Outputs: spec sheets, PDF reports, labels and the round-trip data file. */
export function ExportMenu({ children }: { children: ReactNode }) {
  return (
    <RibbonMenu label="Export" icon={<Download className="h-3.5 w-3.5" />}>
      {children}
    </RibbonMenu>
  )
}

/** The rarer verbs: Clone, Sync from type, Move, Plan a change. */
export function MoreMenu({ children }: { children: ReactNode }) {
  return (
    <RibbonMenu label="More" icon={<Ellipsis className="h-3.5 w-3.5" />}>
      {children}
    </RibbonMenu>
  )
}

/** A menu item that navigates - Clone, Floor plan, … */
export function MenuLink({
  to,
  params,
  search,
  icon,
  children,
}: {
  to: LinkProps["to"]
  params?: LinkProps["params"]
  search?: LinkProps["search"]
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <DropdownMenuItem asChild>
      <Link to={to} params={params} search={search}>
        {icon}
        {children}
      </Link>
    </DropdownMenuItem>
  )
}

/** Clone - a new object's form filled from this one. */
export function CloneMenuItem({
  to,
  search,
}: {
  to: LinkProps["to"]
  search: LinkProps["search"]
}) {
  return (
    <MenuLink
      to={to}
      search={search}
      icon={<CopyPlus className="h-3.5 w-3.5" />}
    >
      Clone
    </MenuLink>
  )
}
