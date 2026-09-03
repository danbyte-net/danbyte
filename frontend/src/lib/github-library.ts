/**
 * Fetch devicetype-library YAML with the browser instead of the server.
 *
 * An air-gapped Danbyte can't reach GitHub, but the operator's browser often
 * can. With "Fetch with my browser" on, the import dialog resolves the pasted
 * links here - a /blob/ or raw file link, or a /tree/ folder listed through
 * the GitHub contents API - and posts the YAML text to the server, exactly as
 * if it had been pasted. Both hosts answer with CORS enabled; the reverse
 * proxy's connect-src must allow them (see the nginx template).
 */

const FILE_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.ya?ml)$/i
const RAW_RE =
  /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+\.ya?ml)$/i
const TREE_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/i

export interface FetchedDoc {
  url: string
  content: string
}

export interface FetchReport {
  docs: FetchedDoc[]
  failures: { url: string; error: string }[]
}

function rawUrl(owner: string, repo: string, ref: string, path: string) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { Accept: "text/plain" } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.text()
}

/** The raw file URLs one pasted link stands for: itself for a file link,
 * every .yaml under the folder for a /tree/ link. */
async function expand(url: string): Promise<string[]> {
  const f = FILE_RE.exec(url)
  if (f) return [rawUrl(f[1], f[2], f[3], f[4])]
  if (RAW_RE.test(url)) return [url]
  const t = TREE_RE.exec(url)
  if (t) {
    const [, owner, repo, ref, path] = t
    const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path.replace(/\/$/, "")}?ref=${ref}`
    const r = await fetch(api, {
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!r.ok) throw new Error(`GitHub listing failed: HTTP ${r.status}`)
    const entries = (await r.json()) as {
      type: string
      path: string
      name: string
    }[]
    return entries
      .filter((e) => e.type === "file" && /\.ya?ml$/i.test(e.name))
      .map((e) => rawUrl(owner, repo, ref, e.path))
  }
  throw new Error("Not a GitHub file, raw or folder link")
}

/** Resolve every link and download its YAML in the browser. Non-URL lines
 * are left to the caller (they are YAML already). */
export async function fetchLibraryDocs(
  urls: string[],
  onProgress?: (done: number, total: number) => void
): Promise<FetchReport> {
  const report: FetchReport = { docs: [], failures: [] }
  const raws: string[] = []
  for (const url of urls) {
    try {
      raws.push(...(await expand(url)))
    } catch (e) {
      report.failures.push({
        url,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  let done = 0
  onProgress?.(0, raws.length)
  // A handful at a time - GitHub's raw host is happy with it, and a big
  // manufacturer folder finishes in seconds instead of minutes.
  const queue = [...raws]
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      try {
        report.docs.push({ url, content: await fetchText(url) })
      } catch (e) {
        report.failures.push({
          url,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      done += 1
      onProgress?.(done, raws.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, raws.length) }, worker))
  return report
}
