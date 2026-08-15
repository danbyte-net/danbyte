import { useMemo, useState } from "react"
import { ListFilter, Plus, X } from "lucide-react"

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
          <DialogTitle>Advanced filter</DialogTitle>
          <DialogDescription>
            Build conditions, or type them —{" "}
            <code className="text-[11px]">
              status = active and (site.name ~ cph or tags ~ core)
            </code>
            . Fields come from this list's own columns.
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
            placeholder='e.g. status = active and due_date < 2026-09-01'
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
              onValueChange={(v) =>
                update(i, { cmp: v as BuilderRule["cmp"] })
              }
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
              <>
                <Input
                  value={rule.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                  placeholder="Value"
                  list={samples.length ? `expr-samples-${i}` : undefined}
                  className="h-8 min-w-0 flex-1 text-[12px]"
                />
                {samples.length > 0 && (
                  <datalist id={`expr-samples-${i}`}>
                    {samples.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                )}
              </>
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
