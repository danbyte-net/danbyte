import type {
  ComplianceExpr,
  ComplianceField,
  ComplianceRef,
  StatusMini,
} from "@/lib/api"
import { OP_LABELS, isListExpr } from "@/lib/filter-expr"
import { ColorBadge } from "@/components/cells/color-badge"
import { StatusBadge } from "@/components/status-badge"
import { typeName } from "@/components/compliance/compliance-shared"
import { cn } from "@/lib/utils"

/** A rule's scope or conditions drawn read-only as the builder draws them:
 * the same groups, catalog rows as their pills. */
export function ExpressionView({
  expr,
  refs = {},
  fields = [],
  empty = "-",
}: {
  expr: ComplianceExpr | null | undefined
  refs?: Record<string, ComplianceRef>
  fields?: ComplianceField[]
  /** What an empty expression reads as. */
  empty?: string
}) {
  if (!expr) return <span className="text-muted-foreground">{empty}</span>
  return <Node expr={expr} refs={refs} fields={fields} root />
}

function Node({
  expr,
  refs,
  fields,
  root,
}: {
  expr: ComplianceExpr
  refs: Record<string, ComplianceRef>
  fields: ComplianceField[]
  root?: boolean
}) {
  if (expr.kind === "group")
    return (
      <div
        className={cn(
          "space-y-1",
          !root && "rounded-md border border-border px-2 py-1.5"
        )}
      >
        <div className="text-[11px] text-muted-foreground">
          {expr.op === "and" ? "All of" : "Any of"}
        </div>
        {expr.terms.map((t, i) => (
          <Node key={i} expr={t} refs={refs} fields={fields} />
        ))}
      </div>
    )
  const field = fields.find((f) => f.key === expr.field)
  const label = field?.label ?? expr.field
  if (expr.kind === "empty")
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {OP_LABELS[expr.negated ? "not_empty" : "empty"]}
        </span>
      </div>
    )
  if (isListExpr(expr)) {
    const status = field?.ref?.badge === "status"
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
        <span>{label}</span>
        <span className="text-muted-foreground">{OP_LABELS[expr.cmp]}</span>
        {expr.values.map((v) => {
          const ref = refs[v] as ComplianceRef | undefined
          const choice = field?.choices.find((c) => c.value === v)
          const name = ref
            ? ref.hidden
              ? "Hidden"
              : ref.missing
                ? "Deleted"
                : (ref.name ?? v)
            : (choice?.label ?? typeName(v))
          return status ? (
            <StatusBadge
              key={v}
              status={{ id: v, name, color: ref?.color ?? "" } as StatusMini}
            />
          ) : (
            <ColorBadge key={v} name={name} color={ref?.color || undefined} />
          )
        })}
      </div>
    )
  }
  const scalar = expr
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
      <span>{label}</span>
      <span className="text-muted-foreground">{OP_LABELS[scalar.cmp]}</span>
      <span className="font-mono text-[12px]">{scalar.value}</span>
    </div>
  )
}
