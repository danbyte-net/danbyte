import type { ReactNode } from "react"

import { useMe } from "@/lib/use-me"

/** The bare, centred card the signed-out password pages sit in: the
 * deployment name, one line under it, then the card. */
export function AuthCard({
  subtitle,
  children,
}: {
  subtitle: string
  children: ReactNode
}) {
  const { me } = useMe()
  return (
    <main className="flex min-h-svh items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            {me.deployment_name?.trim() || "Danbyte"}
          </h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          {children}
        </div>
      </div>
    </main>
  )
}
