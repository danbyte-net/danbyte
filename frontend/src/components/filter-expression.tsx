import { useMemo, useRef, useState } from "react"
import { ChevronDown, Info, ListFilter, Plus, X } from "lucide-react"

import {
  CMP_LABELS,
  discoverFields,
  format,
  fromGroups,
  parse,
  toGroups,
  type BuilderRule,
  type Cmp,
} from "@/lib/filter-expr"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * The advanced filter: one expression per list, written either through the
 * row-based builder or as text in the same grammar - both edit the same AST,
 * so switching between them is lossless (until the text uses nesting the
 * builder can't show, in which case the text editor stays authoritative).
 *
 * Lives at the top of the filter rail on every list, and is captured by saved
 * views exactly like the facet selections.
 */

const OP_OPTIONS: { value: BuilderRule["cmp"]; label: string }[] = [
  ...(Object.entries(CMP_LABELS) as [Cmp, string][]).map(([value, label]) => ({
    value: value as BuilderRule["cmp"],
    label,
  })),
  { value: "empty", label: "is empty" },
  { value: "not_empty", label: "is not empty" },
]

export function ExpressionFilter({
  value,
  onChange,
  rows,
}: {
  /** The committed expression text ("" = off). */
  value: string
  onChange: (next: string) => void
  rows: unknown[]
}) {
  const [open, setOpen] = useState(false)
  const active = value.trim() !== ""

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          Advanced
        </h3>
        {active && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            clear
          </button>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-start gap-1.5 font-normal"
        onClick={() => setOpen(true)}
      >
        <ListFilter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-[12px]">
          {active ? value : "Filter expression…"}
        </span>
      </Button>
      {open && (
        <ExpressionDialog
          initial={value}
          rows={rows}
          onClose={() => setOpen(false)}
          onApply={(next) => {
            onChange(next)
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

function ExpressionDialog({
  initial,
  rows,
  onClose,
  onApply,
}: {
  initial: string
  rows: unknown[]
  onClose: () => void
  onApply: (next: string) => void
}) {
  const [state, setState] = useState<{ text: string; error: string | null }>({
    text: initial,
    error: null,
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            Advanced filter
            <OperatorsHint />
          </DialogTitle>
          <DialogDescription>
            Build conditions, or type them -{" "}
            <code className="text-[11px]">
              status = active and (site.name ~ cph or tags ~ core)
            </code>
            . Fields and values come from this list's own rows.
          </DialogDescription>
        </DialogHeader>

        <ExpressionEditor
          initial={initial}
          rows={rows}
          onChange={(text, error) => setState({ text, error })}
        />

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!!state.error || !state.text.trim()}
            onClick={() => {
              onApply(state.text.trim())
              // Hand off to the SavedViews naming flow (same page, different
              // subtree) - the snapshot it saves includes this expression.
              window.dispatchEvent(new CustomEvent("danbyte:save-view"))
            }}
          >
            Apply &amp; save as view
          </Button>
          <Button
            size="sm"
            disabled={!!state.error}
            onClick={() => onApply(state.text.trim())}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The builder + text pair, reusable outside the list dialog (the saved-filter
 * management page edits stored expressions with no rows to sample). Reports
 * every edit with its parse error so the host can gate its save button. */
export function ExpressionEditor({
  initial,
  rows,
  onChange,
}: {
  initial: string
  rows: unknown[]
  onChange: (text: string, error: string | null) => void
}) {
  const fields = useMemo(() => discoverFields(rows), [rows])

  // Groups are STATE, not a projection of the text: a freshly added blank row
  // isn't part of the expression yet, so deriving rows from text on every
  // keystroke made "+ Add condition" a no-op. Text and groups stay in sync in
  // both directions; groups go null only for nesting deeper than or-of-ands.
  const seed = (t: string) => {
    try {
      const g = toGroups(parse(t))
      return g ? g.map((rules) => (rules.length ? rules : [BLANK()])) : null
    } catch {
      return null
    }
  }
  const [text, setText] = useState(initial)
  const [groups, setGroups] = useState(() => seed(initial))

  let error: string | null = null
  try {
    parse(text)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const onTextEdit = (t: string) => {
    setText(t)
    let err: string | null = null
    try {
      parse(t)
      setGroups(seed(t))
    } catch (e) {
      // Invalid mid-edit text: keep the rows as they were.
      err = e instanceof Error ? e.message : String(e)
    }
    onChange(t, err)
  }

  const setFromGroups = (next: BuilderRule[][]) => {
    setGroups(next)
    const t = format(fromGroups(next))
    setText(t)
    onChange(t, null)
  }

  return (
    <>
      {groups ? (
        <GroupRows groups={groups} fields={fields} onChange={setFromGroups} />
      ) : (
        !error && (
          <p className="text-[12px] text-muted-foreground">
            This expression uses grouping the builder can't show - edit it as
            text below.
          </p>
        )
      )}

      <div>
        <Textarea
          value={text}
          onChange={(e) => onTextEdit(e.target.value)}
          placeholder="e.g. status = active and due_date < 2026-09-01"
          className="min-h-16 font-mono text-[12.5px]"
        />
        {error && <p className="mt-1 text-[12px] text-destructive">{error}</p>}
      </div>
    </>
  )
}

const BLANK = (): BuilderRule => ({ field: "", cmp: "=", value: "" })

/** OR-separated groups of AND-ed rows - matching a group means matching every
 * row in it; matching any group matches the filter. Covers everything up to
 * "a or (b and c)" without asking anyone to think about precedence. */
function GroupRows({
  groups,
  fields,
  onChange,
}: {
  groups: BuilderRule[][]
  fields: ReturnType<typeof discoverFields>
  onChange: (groups: BuilderRule[][]) => void
}) {
  const noValue = (cmp: BuilderRule["cmp"]) =>
    cmp === "empty" || cmp === "not_empty"

  const setGroup = (gi: number, rules: BuilderRule[]) =>
    onChange(groups.map((g, j) => (j === gi ? rules : g)))
  const removeRow = (gi: number, ri: number) => {
    const rest = groups[gi].filter((_, j) => j !== ri)
    if (rest.length > 0) return setGroup(gi, rest)
    // Last row of the group: drop the group, but never all of them.
    const nextGroups = groups.filter((_, j) => j !== gi)
    onChange(nextGroups.length ? nextGroups : [[BLANK()]])
  }

  return (
    <div className="space-y-2">
      {groups.map((rules, gi) => (
        <div key={gi}>
          {gi > 0 && (
            <div className="mb-2 flex items-center gap-2">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                or
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}
          <div className="space-y-2 rounded-lg border border-border p-2.5">
            {rules.map((rule, ri) => {
              const samples =
                fields.find((f) => f.path === rule.field)?.samples ?? []
              const update = (patch: Partial<BuilderRule>) =>
                setGroup(
                  gi,
                  rules.map((r, j) => (j === ri ? { ...r, ...patch } : r))
                )
              return (
                <div
                  key={ri}
                  className="grid grid-cols-[10rem_8.5rem_minmax(0,1fr)_2rem] items-center gap-1.5"
                >
                  {fields.length === 0 ? (
                    <Input
                      value={rule.field}
                      onChange={(e) => update({ field: e.target.value })}
                      placeholder="Field"
                      className="h-8 w-full font-mono text-[12px]"
                    />
                  ) : (
                    <Select
                      value={rule.field || undefined}
                      onValueChange={(v) => update({ field: v })}
                    >
                      <SelectTrigger className="h-8 w-full text-[12px]">
                        <SelectValue placeholder="Field" />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        {fields.map((f) => (
                          <SelectItem key={f.path} value={f.path}>
                            {f.path}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Select
                    value={rule.cmp}
                    onValueChange={(v) =>
                      update({ cmp: v as BuilderRule["cmp"] })
                    }
                  >
                    <SelectTrigger className="h-8 w-full text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OP_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {noValue(rule.cmp) && <div />}
                  {!noValue(rule.cmp) && (
                    <ValueField
                      value={rule.value}
                      onChange={(v) => update({ value: v })}
                      samples={samples}
                      fieldChosen={
                        fields.length === 0 ||
                        fields.some((f) => f.path === rule.field)
                      }
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                    title="Remove condition"
                    onClick={() => removeRow(gi, ri)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )
            })}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setGroup(gi, [...rules, BLANK()])}
            >
              <Plus className="h-3.5 w-3.5" /> And
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onChange([...groups, [BLANK()]])}
      >
        <Plus className="h-3.5 w-3.5" /> Or - add another group
      </Button>
    </div>
  )
}

/** The value input as a combobox: focusing it opens the values actually
 * present in this list, typing narrows them, and free text always wins.
 * Values are per-field, so the box directs to the field picker first. */
function ValueField({
  value,
  onChange,
  samples,
  fieldChosen,
}: {
  value: string
  onChange: (v: string) => void
  samples: string[]
  fieldChosen: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const q = value.trim().toLowerCase()
  const narrowed = q
    ? samples.filter((s) => s.toLowerCase().includes(q))
    : samples
  // Typed text that matches nothing (or exactly one pick) keeps the full list
  // visible - the point of the picker is seeing what exists.
  const exhausted =
    narrowed.length === 0 || (narrowed.length === 1 && narrowed[0] === value)
  const shown = exhausted ? samples : narrowed

  if (!fieldChosen || samples.length === 0)
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={fieldChosen ? "Value" : "Pick a field first"}
        className="h-8 min-w-0 flex-1 text-[12px]"
      />
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="relative flex min-w-0 flex-1">
          <Input
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            // A second click on an already-focused input fires no focus event -
            // pointerdown covers reopening.
            onPointerDown={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false)
            }}
            placeholder="Value"
            className="h-8 min-w-0 flex-1 pr-7 text-[12px]"
          />
          <button
            type="button"
            tabIndex={-1}
            className="absolute inset-y-0 right-1.5 flex items-center text-muted-foreground hover:text-foreground"
            title="Values in this list"
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        // `block`, because PopoverContent is a flex column by default: as its
        // own scroll container the option rows became flex items, and once the
        // list outgrew max-h they shrank to nothing instead of scrolling - an
        // empty panel with a scrollbar (#117).
        className="block max-h-56 w-60 overflow-y-auto p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // The click that focuses the input is "outside" the content - without
        // this guard the popover opens on focus and closes on the same click.
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault()
        }}
      >
        {q && narrowed.length === 0 && (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
            No value contains "{value.trim()}" - free text still applies.
          </p>
        )}
        {shown.map((s) => (
          <button
            key={s}
            type="button"
            className="block w-full truncate rounded-md px-2 py-1 text-left text-[12px] hover:bg-accent"
            onClick={() => {
              onChange(s)
              setOpen(false)
            }}
          >
            {s}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** The grammar on a card, so nobody has to find the docs mid-filter. */
function OperatorsHint() {
  const row = (op: string, what: string) => (
    <>
      <code className="font-mono text-[11px] font-semibold whitespace-nowrap text-foreground">
        {op}
      </code>
      <span className="text-muted-foreground">{what}</span>
    </>
  )
  return (
    <HoverCard openDelay={100}>
      <HoverCardTrigger asChild>
        {/* tabIndex -1: the dialog focuses its first tabbable element on open,
            and a focused trigger opens the card - which made the reference
            cover the dialog before the pointer ever moved. */}
        <button
          type="button"
          tabIndex={-1}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Operator reference"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 text-xs">
        <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5">
          {row("=  !=", "equals / not equals")}
          {row("~  !~", "contains / does not contain (case-insensitive)")}
          {row("<  >  <=  >=", "compare numbers and dates")}
          {row("is empty", "field has no value (is not empty for the reverse)")}
          {row("and  or", "combine conditions; and binds tighter, ( ) group")}
          {row("new line", "one condition per line reads as and")}
          {row("site.name", "dotted paths reach related objects")}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          On list fields like tags, <code className="font-mono">~</code> matches
          any element; <code className="font-mono">!~</code> must hold for all
          of them.
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}
