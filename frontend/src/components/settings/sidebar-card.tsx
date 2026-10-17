import { useState } from "react"
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ChevronDown, GripVertical, LayoutDashboard } from "lucide-react"
import { toast } from "sonner"

import {
  useSidebarModel,
  type SidebarEntry,
  type SidebarSection,
} from "@/components/app-sidebar"
import { SettingsCard } from "@/components/settings/settings-card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useUserPrefs } from "@/lib/use-user-prefs"
import {
  orderSections,
  parseLayout,
  resolveSidebar,
  setHidden,
  setItemOrder,
  setSectionOrder,
  type SidebarLayout,
} from "@/lib/sidebar-layout"
import { cn } from "@/lib/utils"

/**
 * Preferences → Sidebar (#285): hide sections or single pages and drag them
 * into your own order, with the result previewed beside the list. Saved to
 * your account, so it follows you to every browser. Hiding only tidies the
 * menu - every page still opens by URL, search and links, and access is
 * unchanged.
 */
export function SidebarCard() {
  const model = useSidebarModel()
  const { values, userSet, setPrefs, saving } = useUserPrefs()
  const saved = parseLayout(values.sidebar)
  // undefined = untouched; the draft is the whole layout once edited.
  const [draft, setDraft] = useState<SidebarLayout | null | undefined>()
  const current = draft === undefined ? saved : draft
  const dirty =
    draft !== undefined && JSON.stringify(draft) !== JSON.stringify(saved)
  const hidden = new Set(current?.hidden ?? [])
  const ordered = orderSections(model, current)
  const preview = resolveSidebar(model, current)
  const [open, setOpen] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )
  const onSectionDrag = (e: DragEndEvent) => {
    const ids = ordered.map((s) => s.id)
    const from = ids.indexOf(String(e.active.id))
    const to = e.over ? ids.indexOf(String(e.over.id)) : -1
    if (from < 0 || to < 0 || from === to) return
    setDraft(setSectionOrder(current, arrayMove(ids, from, to)))
  }
  const onEntryDrag = (section: SidebarSection, cluster: number) => {
    return (e: DragEndEvent) => {
      const ids = section.clusters[cluster].items.map((i) => i.id)
      const from = ids.indexOf(String(e.active.id))
      const to = e.over ? ids.indexOf(String(e.over.id)) : -1
      if (from < 0 || to < 0 || from === to) return
      const moved = arrayMove(ids, from, to)
      // The section's full entry order, with this cluster's run replaced.
      const all = section.clusters.flatMap((c, i) =>
        i === cluster ? moved : c.items.map((it) => it.id)
      )
      setDraft(setItemOrder(current, section.id, all))
    }
  }
  const toggle = (id: string, show: boolean) =>
    setDraft(setHidden(current, id, !show))

  const save = () => setPrefs({ sidebar: current }, () => setDraft(undefined))
  const reset = () =>
    setPrefs({ sidebar: null }, () => {
      setDraft(undefined)
      toast.success("Sidebar reset")
    })

  return (
    <SettingsCard
      title="Sidebar"
      description="Hide and reorder menu sections and pages. Hidden pages still open by link."
      onSave={save}
      dirty={dirty}
      saving={saving}
      footer={
        <Button
          variant="ghost"
          size="sm"
          disabled={saving || !userSet.includes("sidebar")}
          onClick={reset}
        >
          Reset to default
        </Button>
      }
      className="max-w-4xl"
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_15rem]">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onSectionDrag}
        >
          <SortableContext
            items={ordered.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="grid gap-1">
              {ordered.map((section) => (
                <SectionRow
                  key={section.id}
                  section={section}
                  shown={!hidden.has(section.id)}
                  hidden={hidden}
                  expanded={open === section.id}
                  onExpand={() =>
                    setOpen((o) => (o === section.id ? null : section.id))
                  }
                  onToggle={toggle}
                  onEntryDrag={(cluster) => onEntryDrag(section, cluster)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        <SidebarPreview sections={preview} />
      </div>
    </SettingsCard>
  )
}

function SectionRow({
  section,
  shown,
  hidden,
  expanded,
  onExpand,
  onToggle,
  onEntryDrag,
}: {
  section: SidebarSection
  shown: boolean
  hidden: Set<string>
  expanded: boolean
  onExpand: () => void
  onToggle: (id: string, show: boolean) => void
  onEntryDrag: (cluster: number) => (e: DragEndEvent) => void
}) {
  const sortable = useSortable({ id: section.id })
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )
  const entries = section.clusters.flatMap((c) => c.items)
  const shownCount = entries.filter((i) => !hidden.has(i.id)).length
  const Icon = section.icon
  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "rounded-md border border-border bg-card",
        sortable.isDragging && "relative z-10 opacity-60"
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
        <button
          type="button"
          aria-label={`Reorder ${section.label}`}
          className="cursor-grab text-muted-foreground active:cursor-grabbing"
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={expanded}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-left",
            !shown && "text-muted-foreground"
          )}
        >
          <Icon className="size-4 shrink-0 opacity-70" />
          <span className="truncate font-medium whitespace-nowrap">
            {section.label}
          </span>
          <span className="num shrink-0 text-[11px] text-muted-foreground">
            {shownCount}/{entries.length}
          </span>
          <ChevronDown
            className={cn(
              "ml-auto size-3.5 shrink-0 opacity-60 transition-transform",
              !expanded && "-rotate-90"
            )}
          />
        </button>
        <Switch
          checked={shown}
          onCheckedChange={(v) => onToggle(section.id, v)}
          aria-label={`Show ${section.label}`}
        />
      </div>
      {expanded && (
        <div className="grid gap-2 border-t border-border px-2 py-2 pl-7">
          {section.clusters.map((cluster, ci) => (
            <div key={cluster.label ?? ci} className="grid gap-0.5">
              {cluster.label && (
                <div className="px-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {cluster.label}
                </div>
              )}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onEntryDrag(ci)}
              >
                <SortableContext
                  items={cluster.items.map((i) => i.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ul className="grid gap-0.5">
                    {cluster.items.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        shown={!hidden.has(entry.id)}
                        dimmed={!shown}
                        onToggle={onToggle}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}

function EntryRow({
  entry,
  shown,
  dimmed,
  onToggle,
}: {
  entry: SidebarEntry
  shown: boolean
  /** The section is hidden, so the entry is too whatever its own switch. */
  dimmed: boolean
  onToggle: (id: string, show: boolean) => void
}) {
  const sortable = useSortable({ id: entry.id })
  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "flex items-center gap-2 rounded-md bg-card px-1 py-0.5 text-[13px] hover:bg-muted/50",
        sortable.isDragging && "relative z-10 opacity-60"
      )}
    >
      <button
        type="button"
        aria-label={`Reorder ${entry.title}`}
        className="cursor-grab text-muted-foreground active:cursor-grabbing"
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <span
        className={cn(
          "min-w-0 flex-1 truncate whitespace-nowrap",
          (!shown || dimmed) && "text-muted-foreground"
        )}
      >
        {entry.title}
      </span>
      <Switch
        size="sm"
        checked={shown}
        onCheckedChange={(v) => onToggle(entry.id, v)}
        aria-label={`Show ${entry.title}`}
      />
    </li>
  )
}

/** The menu as it will read - section bands and page names, nothing else. */
function SidebarPreview({ sections }: { sections: SidebarSection[] }) {
  return (
    <div className="grid content-start gap-1.5">
      <div className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        Preview
      </div>
      <div
        aria-label="Sidebar preview"
        className="grid max-h-[32rem] content-start gap-1 overflow-y-auto rounded-lg border border-border bg-sidebar p-2 text-sidebar-foreground"
      >
        <PreviewBand icon={LayoutDashboard} label="Dashboard" />
        {sections.map((s) => (
          <div key={s.id} className="grid gap-0.5">
            <PreviewBand icon={s.icon} label={s.label} />
            {s.clusters.map((c, i) => (
              <div key={c.label ?? i} className="grid pl-2">
                {c.label && (
                  <div className="pt-0.5 text-[9px] font-bold tracking-[0.1em] text-primary uppercase">
                    {c.label}
                  </div>
                )}
                {c.items.map((item) => (
                  <div
                    key={item.id}
                    className="truncate py-px text-[12px] whitespace-nowrap"
                  >
                    {item.title}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function PreviewBand({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <div className="flex h-6 items-center gap-1.5 rounded-md bg-sidebar-band px-2 text-[12px] font-semibold">
      <Icon className="size-3.5 shrink-0 opacity-80" />
      <span className="truncate">{label}</span>
    </div>
  )
}
