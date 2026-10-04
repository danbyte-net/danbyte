// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Plus, Trash2 } from "lucide-react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  BarButton,
  BarIconButton,
  BarMenuTrigger,
  BarTip,
  BarToggle,
} from "./map-toolbar"

afterEach(cleanup)

// Radix measures the tooltip arrow; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

/** Radix opens a tooltip on keyboard focus; that is enough to read it. */
async function tipOf(el: HTMLElement) {
  fireEvent.focus(el)
  return await screen.findByRole("tooltip")
}

describe("BarButton", () => {
  it("is an outline h-7 text-xs button", () => {
    render(
      <BarButton>
        <Plus /> Add
      </BarButton>
    )
    const b = screen.getByRole("button", { name: "Add" })
    expect(b.dataset.variant).toBe("outline")
    expect(b.className).toContain("h-7")
    expect(b.className).toContain("text-xs")
    expect(b.className).not.toContain("h-8")
  })

  it("sizes icons whose lucide class holds an 'h-' too", () => {
    render(
      <BarIconButton label="Delete view" destructive>
        <Trash2 />
      </BarIconButton>
    )
    // `lucide-trash-2` matches [class*='h-'], which the primitive's icon
    // rule skips; the bar's catch-all rule must still reach it.
    const b = screen.getByRole("button", { name: "Delete view" })
    expect(b.querySelector("svg")?.getAttribute("class")).toContain("h-")
    expect(b.className).toContain("[&_svg:not([class*='size-'])]:size-3")
  })

  it("drops unsized icons to size-3, replacing the primitive's size-4", () => {
    render(
      <BarButton>
        <Plus /> Add
      </BarButton>
    )
    const cls = screen.getByRole("button").className
    expect(cls).toContain(
      "[&_svg:not([class*='size-']):not([class*='h-'])]:size-3"
    )
    expect(cls).not.toContain(
      "[&_svg:not([class*='size-']):not([class*='h-'])]:size-4"
    )
  })
})

describe("BarTip", () => {
  it("is the plain chip tooltip under the control", async () => {
    render(
      <BarTip tip="Filters">
        <button>f</button>
      </BarTip>
    )
    const tip = await tipOf(screen.getByRole("button"))
    expect(tip.textContent).toBe("Filters")
    const content = document.querySelector('[data-slot="tooltip-content"]')!
    expect(content.getAttribute("data-side")).toBe("bottom")
    // The default chip, not the bordered panel.
    expect(content.className).toContain("bg-foreground")
    expect(content.className).not.toContain("bg-popover")
  })

  it("shows a shortcut as a key", async () => {
    render(
      <BarTip tip="Save" shortcut="Ctrl+S">
        <button>s</button>
      </BarTip>
    )
    await tipOf(screen.getByRole("button"))
    const kbd = document.querySelector(
      '[data-slot="tooltip-content"] [data-slot="kbd"]'
    )
    expect(kbd?.textContent).toBe("Ctrl+S")
  })
})

describe("BarIconButton", () => {
  it("uses its label as both the aria-label and the tooltip", async () => {
    render(
      <BarIconButton label="New view">
        <Plus />
      </BarIconButton>
    )
    const b = screen.getByRole("button", { name: "New view" })
    expect(b.className).toContain("size-7")
    expect(b.dataset.variant).toBe("outline")
    expect((await tipOf(b)).textContent).toBe("New view")
  })

  it("is a quiet ghost button when destructive", () => {
    const onClick = vi.fn()
    render(
      <BarIconButton label="Delete view" destructive onClick={onClick}>
        <Trash2 />
      </BarIconButton>
    )
    const b = screen.getByRole("button", { name: "Delete view" })
    expect(b.dataset.variant).toBe("ghost")
    expect(b.className).toContain("text-destructive")
    fireEvent.click(b)
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe("BarToggle", () => {
  it("carries its state in aria-pressed and goes muted when off", () => {
    const onClick = vi.fn()
    const { rerender } = render(
      <BarToggle pressed={false} onClick={onClick}>
        Objects
      </BarToggle>
    )
    const b = screen.getByRole("button", { name: "Objects" })
    expect(b.getAttribute("aria-pressed")).toBe("false")
    expect(b.className).toContain("text-muted-foreground")
    fireEvent.click(b)
    expect(onClick).toHaveBeenCalledOnce()

    rerender(
      <BarToggle pressed onClick={onClick}>
        Objects
      </BarToggle>
    )
    expect(b.getAttribute("aria-pressed")).toBe("true")
    expect(b.className).not.toContain("text-muted-foreground")
  })
})

describe("BarMenuTrigger", () => {
  it("is a labelled trigger with a trailing chevron and no tooltip", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <BarMenuTrigger>
            <Plus /> Add
          </BarMenuTrigger>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Band</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
    const b = screen.getByRole("button", { name: "Add" })
    expect(b.getAttribute("aria-haspopup")).toBe("menu")
    expect(b.className).toContain("h-7")
    const icons = b.querySelectorAll("svg")
    expect(icons[icons.length - 1].getAttribute("class")).toContain(
      "lucide-chevron-down"
    )
    expect(icons[icons.length - 1].getAttribute("data-icon")).toBe("inline-end")
    fireEvent.focus(b)
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})
