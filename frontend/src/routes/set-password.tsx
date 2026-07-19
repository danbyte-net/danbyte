import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { Check, KeyRound } from "lucide-react"

import { ApiError, auth } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/set-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    uid: typeof search.uid === "string" ? search.uid : "",
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: SetPasswordPage,
})

function errText(err: unknown): string {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const d = (err.body as { detail?: unknown }).detail
    if (typeof d === "string" && d.trim()) return d
  }
  return (err as Error)?.message ?? "Couldn't set your password."
}

function SetPasswordPage() {
  const nav = useNavigate()
  const { me } = useMe()
  const { uid, token } = Route.useSearch()

  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const validLink = !!uid && !!token

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError("The two passwords don't match.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await auth.setPassword(uid, token, password)
      setDone(true)
      setTimeout(
        () => nav({ to: "/login", search: { redirect: undefined } }),
        1500
      )
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <KeyRound className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {me.deployment_name?.trim() || "Danbyte"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Choose a password for your account
          </p>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          {!validLink ? (
            <p className="text-[13px] text-destructive">
              This link is missing or malformed. Ask an administrator to send a
              new invite.
            </p>
          ) : done ? (
            <div className="flex flex-col items-center gap-2 py-2 text-center">
              <div className="flex size-9 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                <Check className="size-5" />
              </div>
              <p className="text-sm font-medium">Password set</p>
              <p className="text-[13px] text-muted-foreground">
                Taking you to sign in…
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="pw" className="text-xs">
                  New password
                </Label>
                <Input
                  id="pw"
                  type="password"
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="pw2" className="text-xs">
                  Confirm password
                </Label>
                <Input
                  id="pw2"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              {error && <p className="text-[13px] text-destructive">{error}</p>}
              <Button
                type="submit"
                disabled={busy || !password || !confirm}
                className="w-full"
              >
                {busy && <Spinner className="size-4" />}
                Set password
              </Button>
            </form>
          )}
        </div>
      </div>
    </main>
  )
}
