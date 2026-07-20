import type { LifecycleInfo } from "@/lib/api"
import { FormDate, FormText } from "@/components/forms"

// Shared "Lifecycle" form section — device types (hardware) and platforms
// (OS) carry the same vendor lifecycle window. The user picks the dates;
// the lifetime bar and state badge derive from them.

export interface LifecycleFormValue {
  release_date: string
  end_of_sale: string
  end_of_security_updates: string
  end_of_support: string
  lifecycle_url: string
}

export function lifecycleFormValue(
  src?: Partial<LifecycleInfo> | null
): LifecycleFormValue {
  return {
    release_date: src?.release_date ?? "",
    end_of_sale: src?.end_of_sale ?? "",
    end_of_security_updates: src?.end_of_security_updates ?? "",
    end_of_support: src?.end_of_support ?? "",
    lifecycle_url: src?.lifecycle_url ?? "",
  }
}

/** Form state → API payload ("" dates become null). */
export function lifecyclePayload(v: LifecycleFormValue) {
  return {
    release_date: v.release_date || null,
    end_of_sale: v.end_of_sale || null,
    end_of_security_updates: v.end_of_security_updates || null,
    end_of_support: v.end_of_support || null,
    lifecycle_url: v.lifecycle_url.trim(),
  }
}

export function LifecycleFormSection({
  value,
  onChange,
  errors = {},
}: {
  value: LifecycleFormValue
  onChange: (v: LifecycleFormValue) => void
  errors?: Record<string, string | undefined>
}) {
  const set = (k: keyof LifecycleFormValue) => (v: string) =>
    onChange({ ...value, [k]: v })
  return (
    <div className="grid gap-3 border-t border-border pt-3">
      <div>
        <div className="text-[11px] tracking-[0.08em] text-zinc-500 uppercase">
          Lifecycle
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          All optional. Release + end of support draw the lifetime bar; the
          worst passed milestone sets the badge.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormDate
          label="Released"
          value={value.release_date}
          onChange={set("release_date")}
          hint="GA / first ship"
          error={errors.release_date}
        />
        <FormDate
          label="End of sale"
          value={value.end_of_sale}
          onChange={set("end_of_sale")}
          error={errors.end_of_sale}
        />
        <FormDate
          label="End of security updates"
          value={value.end_of_security_updates}
          onChange={set("end_of_security_updates")}
          error={errors.end_of_security_updates}
        />
        <FormDate
          label="End of support (EoL)"
          value={value.end_of_support}
          onChange={set("end_of_support")}
          error={errors.end_of_support}
        />
      </div>
      <FormText
        label="Vendor notice URL"
        value={value.lifecycle_url}
        onChange={set("lifecycle_url")}
        placeholder="https://vendor.example.com/eol/…"
        error={errors.lifecycle_url}
      />
    </div>
  )
}
