import { toast } from "sonner"

/** What an SVG's parts take from classes and the snapshot needs. */
const SVG_PAINT = [
  "fill",
  "stroke",
  "fill-opacity",
  "stroke-opacity",
  "opacity",
  "font-weight",
] as const

/** Snapshot an element to a PNG and download it as `fileName` - the rack
 * elevation's and the cabinet plate's export. html-to-image, loaded on first
 * use, draws it at twice the screen's pixels over the theme's page colour,
 * so a dark page exports dark. */
export async function downloadPng(
  el: HTMLElement,
  fileName: string
): Promise<void> {
  try {
    const { toPng } = await import("html-to-image")
    const dark = document.documentElement.classList.contains("dark")
    const url = await withSvgPaint(el, () =>
      toPng(el, {
        backgroundColor: dark ? "#09090b" : "#ffffff",
        pixelRatio: 2,
        // A centred element's margins would push it off its own picture.
        style: { margin: "0" },
      })
    )
    const a = document.createElement("a")
    a.href = url
    a.download = fileName
    a.click()
  } catch {
    toast.error("Couldn't make the PNG")
  }
}

/** html-to-image copies an `<svg>` as its markup, without the page's
 * stylesheet, so a fill or a stroke its parts take from a class would come
 * out black or not at all. While `run` takes its snapshot, each part carries
 * its computed paint in its own style; afterwards that comes out again -
 * only what was not set inline already, so React's own styles stay as they
 * are. */
export async function withSvgPaint<T>(
  el: Element,
  run: () => Promise<T>
): Promise<T> {
  const added: [SVGElement, string][] = []
  for (const part of el.querySelectorAll<SVGElement>("svg *")) {
    const computed = getComputedStyle(part)
    for (const prop of SVG_PAINT) {
      if (part.style.getPropertyValue(prop)) continue
      const value = computed.getPropertyValue(prop)
      if (!value) continue
      part.style.setProperty(prop, value)
      added.push([part, prop])
    }
  }
  try {
    return await run()
  } finally {
    for (const [part, prop] of added) part.style.removeProperty(prop)
  }
}
