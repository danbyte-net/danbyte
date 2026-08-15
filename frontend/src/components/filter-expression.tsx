import { useMemo, useState } from "react"
import { ChevronDown, Info, ListFilter, Plus, X } from "lucide-react"

import {
  CMP_LABELS,
  discoverFields,
  format,
  fromBuilder,
  parse,
  toBuilder,
  type BuilderRule,
  type Cmp,
  type Expr,
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
 * row-based builder or as text in the same grammar — both edit the same AST,
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
  const [text, setText] = useState(initial)
  const fields = useMemo(() => discoverFields(rows), [rows])

  let ast: Expr | null = null
  let error: string | null = null
  try {
    ast = parse(text)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const builder = error ? null : toBuilder(ast)

  const setFromBuilder = (op: "and" | "or", rules: BuilderRule[]) =>
    setText(format(fromBuilder(op, rules)))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            Advanced filter
            <OperatorsHint />
          </DialogTitle>
          <DialogDescription>
            Build conditions, or type them —{" "}
            <code className="text-[11px]">
              status = active and (site.name ~ cph or tags ~ core)
            </code>
            . Fields and values come from this list's own rows.
          </DialogDescription>
        </DialogHeader>

        {builder ? (
          <BuilderRows
            op={builder.op}
            rules={builder.rules}
            fields={fields}
            onChange={setFromBuilder}
          />
        ) : (
          !error && (
            <p className="text-[12px] text-muted-foreground">
              This expression uses grouping the builder can't show — edit it as
              text below.
            </p>
          )
        )}

        <div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. status = active and due_date < 2026-09-01"
            className="min-h-16 font-mono text-[12.5px]"
          />
          {error && (
            <p className="mt-1 text-[12px] text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!!error}
            onClick={() => onApply(text.trim())}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BuilderRows({
  op,
  rules,
  fields,
  onChange,
}: {
  op: "and" | "or"
  rules: BuilderRule[]
  fields: ReturnType<typeof discoverFields>
  onChange: (op: "and" | "or", rules: BuilderRule[]) => void
}) {
  const update = (i: number, patch: Partial<BuilderRule>) =>
    onChange(
      op,
      rules.map((r, j) => (j === i ? { ...r, ...patch } : r))
    )
  const noValue = (cmp: BuilderRule["cmp"]) =>
    cmp === "empty" || cmp === "not_empty"

  return (
    <div className="space-y-2">
      {rules.map((rule, i) => {
        const samples = fields.find((f) => f.path === rule.field)?.samples ?? []
        return (
          <div key={i} className="flex items-center gap-1.5">
            <Select
              value={rule.field || undefined}
              onValueChange={(v) => update(i, { field: v })}
            >
              <SelectTrigger className="h-8 w-44 shrink-0 text-[12px]">
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
            <Select
              value={rule.cmp}
              onValueChange={(v) => update(i, { cmp: v as BuilderRule["cmp"] })}
            >
              <SelectTrigger className="h-8 w-36 shrink-0 text-[12px]">
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
            {!noValue(rule.cmp) && (
              <ValueField
                value={rule.value}
                onChange={(v) => update(i, { value: v })}
                samples={samples}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
              title="Remove condition"
              onClick={() =>
                onChange(
                  op,
                  rules.filter((_, j) => j !== i)
                )
              }
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )
      })}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange(op, [...rules, { field: "", cmp: "=", value: "" }])
          }
        >
          <Plus className="h-3.5 w-3.5" /> Add condition
        </Button>
        {rules.length > 1 && (
          <Select
            value={op}
            onValueChange={(v) => onChange(v as "and" | "or", rules)}
          >
            <SelectTrigger className="h-7 w-40 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="and">Match all (and)</SelectItem>
              <SelectItem value="or">Match any (or)</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  )
}

/** The value input as a combobox: focusing it opens the values actually
 * present in this list, typing filters them, and free text always wins. */
function ValueField({
  value,
  onChange,
  samples,
}: {
  value: string
  onChange: (v: string) => void
  samples: string[]
}) {
  const [open, setOpen] = useState(false)
  const matches = useMemo(() => {
    const q = value.trim().toLowerCase()
    const hit = q ? samples.filter((s) => s.toLowerCase().includes(q)) : samples
    // An exact pick shouldn't collapse the list to itself.
    return hit.length === 1 && hit[0] === value ? samples : hit
  }, [samples, value])

  if (samples.length === 0)
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Value"
        className="h-8 min-w-0 flex-1 text-[12px]"
      />
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative flex min-w-0 flex-1">
          <Input
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
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
        className="max-h-56 w-60 overflow-y-auto p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {matches.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
            Nothing in this list matches — free text still applies.
          </p>
        ) : (
          matches.map((s) => (
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
          ))
        )}
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
            and a focused trigger opens the card — which made the reference
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
