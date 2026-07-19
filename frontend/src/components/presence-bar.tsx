import { type PresentUser } from "@/lib/api"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)
  return chars.toUpperCase()
}

// A discreet "who else is here" row for the global top bar. Overlapping
// initial-pucks; an editing user gets a brand-colored ring and the label turns
// brand with a live pulsing dot, so "someone is changing this" catches the eye
// without leaning on an off-palette warning color or a decorative icon.
// Renders nothing when you're alone.
export function PresenceBar({
  present,
  className,
}: {
  present: PresentUser[]
  className?: string
}) {
  if (present.length === 0) return null
  const editing = present.filter((p) => p.mode === "editing")
  const isEditing = editing.length > 0
  const label = isEditing
    ? `${editing[0].name}${editing.length > 1 ? ` +${editing.length - 1}` : ""} editing`
    : `${present.length} viewing`

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="flex -space-x-1.5">
        {present.slice(0, 5).map((p) => (
          <Tooltip key={p.user_id}>
            <TooltipTrigger asChild>
              <Avatar
                className={cn(
                  "h-6 w-6 ring-2 ring-background",
                  p.mode === "editing" && "ring-primary"
                )}
              >
                <AvatarFallback
                  className={cn(
                    "text-[9px] font-medium",
                    p.mode === "editing"
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {initials(p.name)}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span className="font-medium">{p.name}</span>
              <span className="text-muted-foreground">
                {" "}
                · {p.mode === "editing" ? "editing — form open" : "viewing"}
              </span>
            </TooltipContent>
          </Tooltip>
        ))}
        {present.length > 5 && (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-2 ring-background">
            +{present.length - 5}
          </span>
        )}
      </div>
      <span
        className={cn(
          "flex items-center gap-1.5 text-[11px] whitespace-nowrap",
          isEditing ? "font-medium text-primary" : "text-muted-foreground"
        )}
      >
        {label}
      </span>
    </div>
  )
}
