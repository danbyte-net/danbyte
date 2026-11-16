// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import { PasswordSection } from "@/components/password-section"

// Preferences → Password (#492).

const { me, changePassword } = vi.hoisted(() => ({
  me: { current: { password_source: "local" } as Record<string, unknown> },
  changePassword: vi.fn(),
}))
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ me: me.current }) }))
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>()
  return { ...real, auth: { ...real.auth, changePassword } }
})

afterEach(() => {
  cleanup()
  changePassword.mockReset()
  me.current = { password_source: "local" }
})

function renderCard() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <PasswordSection />
    </QueryClientProvider>
  )
}

function fill(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: current },
  })
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: next },
  })
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: confirm },
  })
}

describe("PasswordSection", () => {
  it("refuses mismatched passwords without calling the server", () => {
    renderCard()
    fill("old", "Brand-New-1", "Brand-New-2")
    fireEvent.click(screen.getByRole("button", { name: "Change password" }))
    expect(changePassword).not.toHaveBeenCalled()
    expect(screen.getByText("The two passwords don't match.")).toBeTruthy()
  })

  it("sends current and new password and shows every rule that failed", async () => {
    changePassword.mockRejectedValue(
      new ApiError(400, {
        new_password: ["This password is too short.", "It is too common."],
      })
    )
    renderCard()
    fill("old", "abc", "abc")
    fireEvent.click(screen.getByRole("button", { name: "Change password" }))
    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith("old", "abc")
    )
    expect(
      await screen.findByText("This password is too short. It is too common.")
    ).toBeTruthy()
  })

  it("shows where a directory password is managed, with no form", () => {
    me.current = { password_source: "ldap" }
    renderCard()
    expect(screen.getByText(/managed by your company directory/)).toBeTruthy()
    expect(screen.queryByLabelText("Current password")).toBeNull()
  })
})
