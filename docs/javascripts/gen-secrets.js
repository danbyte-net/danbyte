/*
 * Client-side secret generator for the install guide.
 *
 * The guide's code blocks contain placeholder TOKENS (e.g. GENDJANGOKEY). On
 * load, each token is replaced — in the reader's browser — with a crypto-random
 * value, so two people copying the same guide get different secrets and a
 * "copy-paste the defaults" user still ends up unique. The same token reused
 * across blocks (the DB password in the SQL and in the .env) gets the SAME
 * value, so the blocks stay internally consistent.
 *
 * Tokens are filled in place inside ordinary fenced code blocks, so the theme's
 * own "copy" button copies the generated value — no second, differently-styled
 * copy button. A "↻ Regenerate" button reshuffles.
 *
 * Not a substitute for a secrets manager — just a safer default for a quick
 * install. The guide still tells people they can rotate these.
 */
;(function () {
  const ALNUM =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  // Django SECRET_KEY alphabet (matches get_random_secret_key's character set).
  const DJANGO = ALNUM + "!@#$%^&*(-_=+)"

  // token in the docs → [length, alphabet]. Tokens are ALL-CAPS single words so
  // the syntax highlighter keeps each as one text node (never split on '_').
  const TOKENS = {
    GENDJANGOKEY: [50, DJANGO],
    GENMONITORINGKEY: [50, ALNUM], // url-safe: no shell-special chars to quote
    GENDBPASSWORD: [24, ALNUM],
    GENADMINPASSWORD: [20, ALNUM],
  }
  const NAMES = Object.keys(TOKENS)

  function randString(len, alphabet) {
    const buf = new Uint32Array(len)
    crypto.getRandomValues(buf)
    let out = ""
    for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length]
    return out
  }

  function generate() {
    const out = {}
    NAMES.forEach(function (t) {
      out[t] = randString(TOKENS[t][0], TOKENS[t][1])
    })
    return out
  }

  // Replace each raw token text node with a <span class="gen-secret"> so we can
  // refresh values on Regenerate without re-scanning (the token is gone after
  // the first fill). Runs once.
  function decorate() {
    const rx = new RegExp("(" + NAMES.join("|") + ")", "g")
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    )
    const targets = []
    let node
    while ((node = walker.nextNode())) {
      const p = node.parentElement
      if (p && p.classList && p.classList.contains("gen-secret")) continue
      if (rx.test(node.nodeValue)) targets.push(node)
      rx.lastIndex = 0
    }
    targets.forEach(function (textNode) {
      const frag = document.createDocumentFragment()
      let last = 0
      const s = textNode.nodeValue
      let m
      rx.lastIndex = 0
      while ((m = rx.exec(s))) {
        if (m.index > last)
          frag.appendChild(document.createTextNode(s.slice(last, m.index)))
        const span = document.createElement("span")
        span.className = "gen-secret"
        span.setAttribute("data-gen", m[1])
        frag.appendChild(span)
        last = m.index + m[1].length
      }
      if (last < s.length)
        frag.appendChild(document.createTextNode(s.slice(last)))
      textNode.parentNode.replaceChild(frag, textNode)
    })
    return targets.length > 0
  }

  function fill(secrets) {
    document.querySelectorAll(".gen-secret").forEach(function (el) {
      const t = el.getAttribute("data-gen")
      if (secrets[t] !== undefined) el.textContent = secrets[t]
    })
  }

  function init() {
    if (!document.querySelector("[data-secret-regen]")) return // not the install page
    const found = decorate()
    if (!found && !document.querySelector(".gen-secret")) return
    fill(generate())
    document.querySelectorAll("[data-secret-regen]").forEach(function (btn) {
      if (btn.dataset.wired) return
      btn.dataset.wired = "1"
      btn.addEventListener("click", function () {
        fill(generate())
      })
    })
  }

  // Material's instant navigation swaps page bodies without a full reload, so
  // hook document$ when present; fall back to DOMContentLoaded otherwise.
  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(init)
  } else if (document.readyState !== "loading") {
    init()
  } else {
    document.addEventListener("DOMContentLoaded", init)
  }
})()
