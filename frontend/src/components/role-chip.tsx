import {
  Anchor,
  ArrowRight,
  Copy,
  Crown,
  Key,
  Link2,
  Network,
  Radio,
  RadioTower,
  Router,
  Satellite,
  Server,
  Shield,
  ShieldCheck,
  ShieldX,
  Waves,
  Workflow,
  type LucideIcon,
} from "lucide-react"

import type { IPRoleMini } from "@/lib/api"
import { readableText } from "@/components/cells/color-badge"

// Closed registry — mirrors api/templatetags/api_extras.py:ROLE_ICONS.
// CrownOff and Broadcast aren't in lucide-react so they fall back to
// their nearest semantic neighbour (Crown stays for the master, Radio for
// the broadcast role).
const ICONS: Record<string, LucideIcon> = {
  crown: Crown,
  "crown-off": Crown,
  router: Router,
  network: Network,
  server: Server,
  "shield-check": ShieldCheck,
  "shield-x": ShieldX,
  shield: Shield,
  "arrow-right": ArrowRight,
  anchor: Anchor,
  copy: Copy,
  link: Link2,
  key: Key,
  workflow: Workflow,
  waves: Waves,
  satellite: Satellite,
  broadcast: RadioTower,
  radio: Radio,
}

interface RoleChipProps {
  role: Pick<IPRoleMini, "name" | "color" | "text_color" | "icon"> | null
  showVirtualTag?: boolean
  isVirtual?: boolean
}

export function RoleChip({ role, showVirtualTag, isVirtual }: RoleChipProps) {
  if (!role) return <span className="text-muted-foreground">—</span>
  const Icon = ICONS[(role.icon || "").trim().toLowerCase()]
  const style = role.color
    ? {
        backgroundColor: role.color,
        color: role.text_color || readableText(role.color),
      }
    : undefined
  const cls = role.color
    ? "inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium"
    : "inline-flex items-center gap-1 rounded-[5px] bg-muted text-foreground px-1.5 py-0.5 text-[11px] font-medium"
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cls} style={style}>
        {Icon && <Icon className="h-3 w-3" />}
        {role.name}
      </span>
      {showVirtualTag && isVirtual && (
        <span className="rounded-[5px] bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
          virtual
        </span>
      )}
    </span>
  )
}
