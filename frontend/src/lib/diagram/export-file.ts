import { toast } from "sonner"

// What every drawing's Export menu shares - the topology map's
// (components/topology/export/export-menu.tsx) and the rack and cabinet
// drawings' (components/drawing-export-menu.tsx): how a file is named, and
// how a PDF the server made reaches the user, saved or printed.

/** Letters with no accent to strip, as the names people read them by.
 * The server names a PDF the same way (api/drawing_pdf.py `file_slug`). */
const FOLD: Record<string, string> = {
  ø: "o",
  Ø: "o",
  æ: "ae",
  Æ: "ae",
  œ: "oe",
  Œ: "oe",
  ß: "ss",
  đ: "d",
  Đ: "d",
  ð: "d",
  Ð: "d",
  ł: "l",
  Ł: "l",
  þ: "th",
  Þ: "th",
}

/** `DC1 fabric` on 26 Sep 2026 → `dc1-fabric-2026-09-26.<ext>`;
 * `København HQ` → `kobenhavn-hq-…`; `fallback` when no letter is left. */
export function exportFileName(
  name: string,
  ext: string,
  date: Date = new Date(),
  fallback = "topology"
): string {
  const slug =
    name
      .replace(/[øØæÆœŒßđĐðÐłŁþÞ]/g, (c) => FOLD[c])
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || fallback
  const p = (n: number) => String(n).padStart(2, "0")
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
  return `${slug}-${day}.${ext}`
}

/** Save a same-origin file URL (the server names it as an attachment). */
export function saveUrl(url: string, fileName: string) {
  const a = window.document.createElement("a")
  a.href = url
  a.download = fileName
  a.click()
}

/** Print's tab, opened at once, while the click still counts as the
 * user's: a tab opened after the render would be taken for a pop-up. Null
 * when the browser blocks it. */
export function openPrintTab(): Window | null {
  const tab = window.open("", "_blank")
  if (tab)
    try {
      tab.opener = null
      tab.document.title = "Preparing PDF…"
    } catch {
      /* a browser that keeps the blank tab to itself: it still navigates */
    }
  return tab
}

/** A PDF's print link (`?print=1`) delivered: shown in the print tab, where
 * the browser's viewer prints it, or saved - also for a Print whose tab was
 * blocked, which says so. True when it went to the tab. */
export function sendPdf(
  url: string,
  {
    print,
    tab,
    fileName,
  }: { print: boolean; tab: Window | null; fileName: string }
): boolean {
  if (print && tab) {
    tab.location.replace(url)
    return true
  }
  if (print) toast.warning("Pop-ups are blocked, so the PDF was downloaded")
  saveUrl(`${url}?download=1`, fileName)
  return false
}
