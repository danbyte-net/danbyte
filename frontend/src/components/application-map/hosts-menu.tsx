import { Server } from "lucide-react"

import { BarMenuTrigger } from "@/components/map-toolbar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { HOSTS_MODES } from "./model"
import type { HostsMode } from "./model"

// The Tree's Hosts option (#163): none, one row under every application
// (lines from each application to the hosts it runs on), or a small copy
// of each host under every application it runs, with the version
// installed - no long lines at all.

export const HOSTS_LABEL: Record<HostsMode, string> = {
  off: "Off",
  row: "Row",
  under: "Under applications",
}

export function HostsMenu({
  value,
  onChange,
}: {
  value: HostsMode
  onChange: (v: HostsMode) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <BarMenuTrigger
          className={value === "off" ? "text-muted-foreground" : undefined}
        >
          <Server /> Hosts
          <span className="text-muted-foreground">{HOSTS_LABEL[value]}</span>
        </BarMenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => onChange(v as HostsMode)}
        >
          {HOSTS_MODES.map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              {HOSTS_LABEL[m]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
