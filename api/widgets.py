"""Reusable form widgets.

This module owns small, app-wide UI building blocks for Django forms — the
kind of thing every CRUD page will reach for once the next model is added.
Currently:

  * ``ColorPickerWidget`` — renders the hex input plus a 50-swatch grid and a
    native color wheel. Any model field that stores a hex string can opt in
    by setting ``widget=ColorPickerWidget()`` in its form's ``widgets`` map.
"""

from __future__ import annotations

from django import forms
from django.utils.safestring import mark_safe

from .templatetags.api_extras import lucide_html


# A 50-colour curated palette — every preset has a friendly
# name so the dropdown reads like a tag picker. Hex values are Tailwind
# palette anchors so swatches click into place against the rest of the
# design system. Order matters: this is the order the dropdown shows them
# in, grouped by hue from neutrals through warms to cools.
COLOR_PALETTE: list[tuple[str, str]] = [
    # Neutrals (8)
    ("White",         "#f4f4f5"),
    ("Light grey",    "#e4e4e7"),
    ("Grey",          "#a1a1aa"),
    ("Slate",         "#71717a"),
    ("Dark grey",     "#52525b"),
    ("Charcoal",      "#3f3f46"),
    ("Graphite",      "#27272a"),
    ("Black",         "#18181b"),
    # Reds (3)
    ("Light red",     "#fecaca"),
    ("Red",           "#ef4444"),
    ("Dark red",      "#b91c1c"),
    # Oranges (3)
    ("Light orange",  "#fed7aa"),
    ("Orange",        "#f97316"),
    ("Dark orange",   "#c2410c"),
    # Ambers (3)
    ("Light amber",   "#fde68a"),
    ("Amber",         "#f59e0b"),
    ("Brown",         "#b45309"),
    # Yellows (2)
    ("Light yellow",  "#fef08a"),
    ("Yellow",        "#eab308"),
    # Limes (2)
    ("Light lime",    "#d9f99d"),
    ("Lime",          "#84cc16"),
    # Greens (3)
    ("Light green",   "#bbf7d0"),
    ("Green",         "#22c55e"),
    ("Dark green",    "#15803d"),
    # Emeralds (3)
    ("Light emerald", "#a7f3d0"),
    ("Emerald",       "#10b981"),
    ("Dark emerald",  "#047857"),
    # Teals (2)
    ("Light teal",    "#99f6e4"),
    ("Teal",          "#14b8a6"),
    # Cyans (2)
    ("Light cyan",    "#a5f3fc"),
    ("Cyan",          "#06b6d4"),
    # Skys (2)
    ("Light sky",     "#bae6fd"),
    ("Sky",           "#0ea5e9"),
    # Blues (3)
    ("Light blue",    "#bfdbfe"),
    ("Blue",          "#3b82f6"),
    ("Dark blue",     "#1d4ed8"),
    # Indigos (2)
    ("Light indigo",  "#c7d2fe"),
    ("Indigo",        "#6366f1"),
    # Violets (2)
    ("Light violet",  "#ddd6fe"),
    ("Violet",        "#8b5cf6"),
    # Purples (3)
    ("Light purple",  "#e9d5ff"),
    ("Purple",        "#a855f7"),
    ("Dark purple",   "#6b21a8"),
    # Fuchsias (2)
    ("Light fuchsia", "#f5d0fe"),
    ("Fuchsia",       "#d946ef"),
    # Pinks (3)
    ("Light pink",    "#fbcfe8"),
    ("Pink",          "#ec4899"),
    ("Dark pink",     "#9d174d"),
    # Roses (2)
    ("Light rose",    "#fecdd3"),
    ("Rose",          "#f43f5e"),
]
assert len(COLOR_PALETTE) == 50, len(COLOR_PALETTE)

# Reverse lookup so we can show "Red" next to a hex the user has selected.
COLOR_NAME_BY_HEX: dict[str, str] = {hex_.lower(): name for name, hex_ in COLOR_PALETTE}


_INPUT_CLASSES = (
    "h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 font-mono "
    "text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none "
    "dark:border-zinc-800 dark:bg-zinc-950 dark:focus:border-zinc-600"
)


class ColorPickerWidget(forms.TextInput):
    """Hex text input + 50-swatch palette + native color wheel.

    The hex text field is the source of truth — swatches and the wheel just
    write into it. That keeps form validation, server-side cleaning and the
    existing ``_ColorMixin.clean_color`` validator working unchanged.
    """

    def __init__(self, attrs=None, *, placeholder: str = "#10b981"):
        merged = {"class": _INPUT_CLASSES, "placeholder": placeholder}
        if attrs:
            merged.update(attrs)
        super().__init__(attrs=merged)

    def render(self, name, value, attrs=None, renderer=None):  # noqa: D401
        text_html = super().render(name, value, attrs=attrs, renderer=renderer)
        current = (value or "").strip() or ""
        current_lc = current.lower()
        current_name = COLOR_NAME_BY_HEX.get(current_lc, "")

        # Named-preset list. Lives inside a <details> popover —
        # closed by default, anchored under the "Palette" trigger.
        items = []
        for label, hex_value in COLOR_PALETTE:
            is_selected = hex_value.lower() == current_lc
            check = (
                lucide_html("check", "ml-auto h-3.5 w-3.5 text-zinc-700 dark:text-zinc-200")
                if is_selected else ""
            )
            items.append(
                f'<button type="button" data-hex="{hex_value}" '
                f'class="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[13px] hover:bg-zinc-50 dark:hover:bg-zinc-900">'
                f'<span class="h-4 w-4 flex-shrink-0 rounded-sm ring-1 ring-inset ring-black/10 dark:ring-white/10" style="background-color: {hex_value};"></span>'
                f'<span class="text-zinc-800 dark:text-zinc-200">{label}</span>'
                f'<span class="ml-2 font-mono text-[11px] text-zinc-400">{hex_value}</span>'
                f'{check}'
                f'</button>'
            )
        items_html = "\n".join(items)

        wheel_value = current if current else "#10b981"
        preview_bg = current if current else "transparent"
        empty_class = "" if current else "color-picker-empty"

        # Trigger label: "Red — #ef4444" when a named preset is active,
        # plain "Palette" otherwise. Keeps the dropdown discoverable without
        # screaming for attention.
        trigger_text = current_name if current_name else "Palette"
        html = f"""
<div class="color-picker" data-color-picker data-field="{name}">
  <!-- Single row: leading preview tile (native-wheel trigger) · hex text ·
       "Palette ▾" dropdown · ✕ clear. Compact, one line, no chunky tray. -->
  <div class="flex items-center gap-1.5">
    <label class="relative flex h-9 w-9 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-zinc-200 bg-[image:linear-gradient(45deg,#eee_25%,transparent_25%),linear-gradient(-45deg,#eee_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#eee_75%),linear-gradient(-45deg,transparent_75%,#eee_75%)] bg-[length:8px_8px] bg-[position:0_0,0_4px,4px_-4px,-4px_0] dark:border-zinc-800 dark:bg-[image:linear-gradient(45deg,#27272a_25%,transparent_25%),linear-gradient(-45deg,#27272a_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#27272a_75%),linear-gradient(-45deg,transparent_75%,#27272a_75%)]"
           title="Open color wheel"
           data-color-preview>
      <span class="absolute inset-0 rounded-[5px] {empty_class}" style="background-color: {preview_bg};" data-color-preview-fill></span>
      <input type="color" value="{wheel_value}" aria-label="Color wheel"
             class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
             data-color-wheel />
    </label>
    <div class="flex-1">{text_html}</div>
    <details class="relative" data-color-dropdown>
      <summary class="inline-flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900">
        <span data-color-trigger-label>{trigger_text}</span>
        {lucide_html("chevron-down", "caret h-3 w-3 text-zinc-400 transition-transform")}
      </summary>
      <div class="absolute right-0 top-full z-30 mt-1 w-64 rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
        <div class="max-h-72 overflow-y-auto" data-color-swatches>
          {items_html}
        </div>
      </div>
    </details>
    <button type="button" data-color-clear aria-label="Clear color" title="Clear"
            class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
      {lucide_html("x", "h-3.5 w-3.5")}
    </button>
  </div>
</div>
<script>
(function () {{
  // Idempotent — one initializer regardless of how many pickers are on the
  // page. All wiring uses event delegation so future pickers (e.g. inside a
  // bulk-edit modal) Just Work without a re-init.
  if (window.__danbyteColorPickerInit) return;
  window.__danbyteColorPickerInit = true;

  // Hex → friendly name lookup, built from the items the server rendered.
  // Lets us update the dropdown trigger label when the user picks a swatch,
  // types a known hex, or spins the colour wheel onto a preset.
  function nameLookup(box) {{
    if (box.__nameLookup) return box.__nameLookup;
    var lookup = {{}};
    box.querySelectorAll('[data-hex]').forEach(function (item) {{
      var hex = item.dataset.hex.toLowerCase();
      var labelEl = item.querySelector('span:nth-of-type(2)');
      if (labelEl) lookup[hex] = labelEl.textContent.trim();
    }});
    box.__nameLookup = lookup;
    return lookup;
  }}

  function syncPicker(box, hex) {{
    var name = box.dataset.field;
    var input = box.querySelector('input[name="' + name + '"]');
    var wheel = box.querySelector('[data-color-wheel]');
    var fill  = box.querySelector('[data-color-preview-fill]');
    var trig  = box.querySelector('[data-color-trigger-label]');
    if (input && input.value !== hex) {{
      input.value = hex;
      input.dispatchEvent(new Event('input', {{bubbles: true}}));
    }}
    if (wheel && hex) wheel.value = hex;
    if (fill) {{
      fill.style.backgroundColor = hex || 'transparent';
      fill.classList.toggle('color-picker-empty', !hex);
    }}
    if (trig) {{
      var known = nameLookup(box)[(hex || '').toLowerCase()];
      trig.textContent = known || (hex ? hex : 'Palette');
    }}
    // Repaint the ✓ on the matching dropdown row.
    box.querySelectorAll('[data-hex]').forEach(function (s) {{
      var picked = hex && s.dataset.hex.toLowerCase() === hex.toLowerCase();
      var existing = s.querySelector('.cp-check');
      if (picked && !existing) {{
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cp-check ml-auto h-3.5 w-3.5 text-zinc-700 dark:text-zinc-200');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2.5');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.innerHTML = '<path d="M20 6 9 17l-5-5"/>';
        s.appendChild(svg);
      }} else if (!picked && existing) {{
        existing.remove();
      }}
    }});
  }}

  function closeDropdown(box) {{
    var dd = box.querySelector('[data-color-dropdown]');
    if (dd && dd.open) dd.open = false;
  }}

  document.addEventListener('click', function (e) {{
    var swatch = e.target.closest('[data-color-picker] [data-hex]');
    if (swatch) {{
      e.preventDefault();
      var box = swatch.closest('[data-color-picker]');
      syncPicker(box, swatch.dataset.hex);
      closeDropdown(box);
      return;
    }}
    var clearBtn = e.target.closest('[data-color-clear]');
    if (clearBtn) {{
      e.preventDefault();
      syncPicker(clearBtn.closest('[data-color-picker]'), '');
      return;
    }}
    // Click-outside closes any open palette dropdown.
    document.querySelectorAll('[data-color-dropdown][open]').forEach(function (dd) {{
      if (!dd.contains(e.target)) dd.open = false;
    }});
  }});
  document.addEventListener('input', function (e) {{
    var wheel = e.target.closest('[data-color-wheel]');
    if (wheel) syncPicker(wheel.closest('[data-color-picker]'), wheel.value);
    var input = e.target.closest('[data-color-picker] input[type="text"]');
    if (input) syncPicker(input.closest('[data-color-picker]'), input.value.trim());
  }});

  // Existing checkmarks present at first render need the `.cp-check` class
  // so we can find them again on re-sync.
  document.querySelectorAll('[data-color-picker] [data-hex] > svg').forEach(function (s) {{
    s.classList.add('cp-check');
  }});
}})();
</script>
<style>
  /* Empty preview tile shows the checkerboard, not a colour. */
  .color-picker-empty {{ background: transparent !important; }}
</style>
"""
        return mark_safe(html)


# ─── Multi-picker (chip-based searchable multi-select) ──────────────────


class MultiPickerWidget(forms.SelectMultiple):
    """Chip-based searchable multi-select.

    Visually: a row of selected items as removable chips, plus a search input;
    focusing the input drops down a filtered list of unpicked options.

    Mechanically: a hidden ``<select multiple>`` is the form's source of
    truth. Without JS the page falls back to the native select (which we
    un-hide via a ``<noscript>`` block).

    Subclass and override ``annotate_option`` to add a per-row color swatch
    (see ``TagPickerWidget`` below).
    """

    def __init__(self, attrs=None, *, placeholder: str = "Search…"):
        super().__init__(attrs=attrs)
        self.placeholder = placeholder

    def annotate_option(self, value, label) -> dict:
        """Return per-option {label, color, text_color} for rendering."""
        return {"label": str(label), "color": "", "text_color": ""}

    def render(self, name, value, attrs=None, renderer=None):
        # Source-of-truth hidden select. Class "sr-only" keeps it invisible
        # but submittable; <noscript> below un-hides it as a fallback.
        merged_attrs = dict(attrs or {})
        existing = merged_attrs.get("class", "")
        merged_attrs["class"] = (existing + " sr-only mp-fallback").strip()
        select_html = super().render(name, value, attrs=merged_attrs, renderer=renderer)

        # Flatten choices to a list and split selected vs available.
        selected_values = {str(v) for v in (value or []) if v}
        all_choices = []
        for val, label in self.choices:
            if val in ("", None):
                continue
            ann = self.annotate_option(val, label)
            all_choices.append({
                "value": str(val),
                "label": ann.get("label", str(label)),
                "color": ann.get("color", ""),
                "text_color": ann.get("text_color", ""),
            })
        selected = [c for c in all_choices if c["value"] in selected_values]
        available = [c for c in all_choices if c["value"] not in selected_values]

        # Build chips for selected items.
        chip_html = "\n".join(self._chip(c) for c in selected) or self._empty_state()
        # Build dropdown rows for available items.
        row_html = "\n".join(self._row(c) for c in available) or (
            '<div class="px-3 py-3 text-center text-[12px] text-zinc-500">'
            'No more options.</div>'
        )

        # Stash the X icon HTML as a data attr so the JS chip-builder can
        # re-use Lucide markup verbatim — keeps icons consistent.
        x_icon_html = lucide_html("x", "h-3 w-3 opacity-60 group-hover:opacity-100")
        x_icon_attr = x_icon_html.replace('"', "&quot;")

        html = f"""
<div class="multi-picker" data-multi-picker data-field="{name}" data-mp-x-icon="{x_icon_attr}">
  <div class="rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
    <!-- Selected chips. Symmetric py-2 so chips sit centered between the
         card top and the search divider, not flush against the bottom. -->
    <div class="flex flex-wrap items-center gap-1 px-2 py-2" data-mp-chips>
      {chip_html}
    </div>
    <!-- Search input -->
    <div class="border-t border-zinc-100 px-2 dark:border-zinc-900">
      <input type="text"
             placeholder="{self.placeholder}"
             class="block h-9 w-full bg-transparent text-sm placeholder:text-zinc-400 focus:outline-none"
             data-mp-search autocomplete="off" />
    </div>
    <!-- Dropdown of unpicked options (hidden until focus / typing) -->
    <div class="hidden border-t border-zinc-100 dark:border-zinc-900" data-mp-dropdown>
      <div class="max-h-56 overflow-y-auto py-1" data-mp-options>
        {row_html}
      </div>
    </div>
  </div>
  {select_html}
  <noscript>
    <p class="mt-1 text-[11px] text-zinc-500">JavaScript is off — use the native multi-select above.</p>
    <style>.mp-fallback {{ position: static !important; width: 100% !important; height: auto !important; clip: auto !important; margin: 0.5rem 0 !important; }} .multi-picker [data-multi-picker] {{ display: none; }}</style>
  </noscript>
</div>
{self._init_script()}
"""
        return mark_safe(html)

    # ── HTML fragments ────────────────────────────────────────────────────

    def _chip(self, c: dict) -> str:
        color = c["color"]
        if color:
            return (
                f'<button type="button" data-mp-pick="{c["value"]}" '
                f'class="group inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium hover:opacity-80" '
                f'style="background-color: {color}; color: {c["text_color"] or "#fff"};">'
                f'<span>{c["label"]}</span>'
                f'{lucide_html("x", "h-3 w-3 opacity-70 group-hover:opacity-100")}'
                '</button>'
            )
        return (
            f'<button type="button" data-mp-pick="{c["value"]}" '
            'class="group inline-flex items-center gap-1 rounded-[5px] bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700">'
            f'<span>{c["label"]}</span>'
            f'{lucide_html("x", "h-3 w-3 opacity-60 group-hover:opacity-100")}'
            '</button>'
        )

    def _row(self, c: dict) -> str:
        swatch = ""
        if c["color"]:
            swatch = (
                f'<span class="h-3 w-3 flex-shrink-0 rounded-sm" '
                f'style="background-color: {c["color"]};"></span>'
            )
        return (
            f'<button type="button" data-mp-pick="{c["value"]}" '
            f'data-mp-search-text="{c["label"].lower()}" '
            'class="mp-row flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-900">'
            f'{swatch}<span>{c["label"]}</span>'
            '</button>'
        )

    def _empty_state(self) -> str:
        return (
            '<span class="px-1 py-0.5 text-[12px] text-zinc-400" data-mp-empty>'
            'Nothing selected'
            '</span>'
        )

    @staticmethod
    def _init_script() -> str:
        # Idempotent — one delegated handler for every picker on the page.
        return """
<script>
(function () {
  if (window.__danbyteMultiPickerInit) return;
  window.__danbyteMultiPickerInit = true;

  function getSelect(box) {
    var name = box.dataset.field;
    return box.querySelector('select[name="' + name + '"]');
  }
  function getOption(select, value) {
    return Array.from(select.options).find(function (o) { return o.value === value; });
  }
  function rerenderChips(box) {
    // After (de)selecting, rebuild the chip row from the underlying select's
    // selected options. Each chip is a button with data-mp-pick=<value>.
    var chips = box.querySelector('[data-mp-chips]');
    var select = getSelect(box);
    var selected = Array.from(select.selectedOptions);
    if (!selected.length) {
      chips.innerHTML = '<span class="px-1 py-0.5 text-[12px] text-zinc-400" data-mp-empty>Nothing selected</span>';
      return;
    }
    // Look up existing rows in the dropdown to copy each option's color (so
    // we don't need a separate server-side render).
    chips.innerHTML = '';
    selected.forEach(function (o) {
      var row = box.querySelector('[data-mp-pick="' + CSS.escape(o.value) + '"][data-mp-search-text]');
      var color = row ? row.querySelector('span[style*="background-color"]') : null;
      var hex = color ? color.style.backgroundColor : '';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.mpPick = o.value;
      if (hex) {
        btn.className = 'group inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium hover:opacity-80';
        btn.style.backgroundColor = hex;
        btn.style.color = '#fff';
      } else {
        btn.className = 'group inline-flex items-center gap-1 rounded-[5px] bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700';
      }
      // X icon is exported on the picker box (data-mp-x-icon) by the server
      // render so the JS chip-builder reuses Lucide rather than hard-coding
      // SVG geometry that would drift from the icon set.
      var xIcon = box.dataset.mpXIcon || '';
      btn.innerHTML = '<span>' + o.textContent + '</span>' + xIcon;
      chips.appendChild(btn);
    });
  }
  function toggle(box, value) {
    var select = getSelect(box);
    var opt = getOption(select, value);
    if (!opt) return;
    opt.selected = !opt.selected;
    // Hide the row from the dropdown if it's now selected; show it if not.
    var row = box.querySelector('.mp-row[data-mp-pick="' + CSS.escape(value) + '"]');
    if (row) row.classList.toggle('hidden', opt.selected);
    rerenderChips(box);
  }

  document.addEventListener('click', function (e) {
    var pickBtn = e.target.closest('[data-mp-pick]');
    if (pickBtn) {
      e.preventDefault();
      toggle(pickBtn.closest('[data-multi-picker]'), pickBtn.dataset.mpPick);
      return;
    }
    // Click outside any picker closes all dropdowns.
    if (!e.target.closest('[data-multi-picker]')) {
      document.querySelectorAll('[data-mp-dropdown]').forEach(function (d) { d.classList.add('hidden'); });
    }
  });
  document.addEventListener('focusin', function (e) {
    var search = e.target.closest('[data-mp-search]');
    if (!search) return;
    var box = search.closest('[data-multi-picker]');
    box.querySelector('[data-mp-dropdown]').classList.remove('hidden');
  });
  document.addEventListener('input', function (e) {
    var search = e.target.closest('[data-mp-search]');
    if (!search) return;
    var box = search.closest('[data-multi-picker]');
    var needle = search.value.trim().toLowerCase();
    box.querySelectorAll('.mp-row').forEach(function (row) {
      var hay = row.dataset.mpSearchText || '';
      var match = !needle || hay.indexOf(needle) >= 0;
      // Don't show rows that are currently selected (they're in chips).
      var select = getSelect(box);
      var opt = getOption(select, row.dataset.mpPick);
      var isSel = opt ? opt.selected : false;
      row.classList.toggle('hidden', !match || isSel);
    });
  });
})();
</script>
"""


class TagPickerWidget(MultiPickerWidget):
    """Multi-picker that paints chips and dropdown rows with each tag's color."""

    def __init__(self, attrs=None, *, placeholder: str = "Search tags…"):
        super().__init__(attrs=attrs, placeholder=placeholder)
        self._color_cache: dict[str, tuple[str, str]] = {}

    def render(self, name, value, attrs=None, renderer=None):
        # Warm a small cache so each option doesn't trigger its own query.
        try:
            from core.models import Tag
            self._color_cache = {
                str(t.pk): (t.color, t.text_color) for t in Tag.objects.all()
            }
        except Exception:  # noqa: BLE001
            self._color_cache = {}
        return super().render(name, value, attrs=attrs, renderer=renderer)

    def annotate_option(self, value, label) -> dict:
        color, text_color = self._color_cache.get(str(value), ("", ""))
        return {"label": str(label), "color": color, "text_color": text_color}


# ─── Searchable single-select ─────────────────────────────────────────────


class SearchableSelectWidget(forms.Select):
    """Single-value searchable dropdown — modern button → popover with search.

    Renders a button showing the current selection's label; clicking opens a
    popover with a search input and the filtered options. Picking sets the
    hidden ``<select>``'s value + closes the popover. Without JS, a fallback
    `<noscript>` un-hides the native select.
    """

    def __init__(self, attrs=None, *, placeholder: str = "Search…",
                 empty_label: str = "— pick one —"):
        super().__init__(attrs=attrs)
        self.placeholder = placeholder
        self.empty_label = empty_label

    def render(self, name, value, attrs=None, renderer=None):
        merged_attrs = dict(attrs or {})
        existing = merged_attrs.get("class", "")
        merged_attrs["class"] = (existing + " sr-only ss-fallback").strip()
        select_html = super().render(name, value, attrs=merged_attrs, renderer=renderer)

        choices_list = []
        cur_label = self.empty_label
        for val, label in self.choices:
            if val in ("", None):
                continue
            choices_list.append({"value": str(val), "label": str(label)})
            if str(val) == str(value):
                cur_label = str(label)

        rows = "\n".join(
            f'<button type="button" data-ss-pick="{c["value"]}" '
            f'data-ss-search-text="{c["label"].lower()}" '
            f'class="ss-row flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-900">'
            f'<span>{c["label"]}</span></button>'
            for c in choices_list
        ) or (
            '<div class="px-3 py-3 text-center text-[12px] text-zinc-500">No options.</div>'
        )

        # Container is the positioning context for the popover — `relative`
        # on the box itself and `top-full left-0 right-0` on the popover
        # means it ALWAYS sits exactly under the trigger, exactly the same
        # width, no half-pixel drift, no intermediate wrapper.
        html = f"""
<div class="searchable-select relative" data-ss data-field="{name}">
  <button type="button" data-ss-trigger
          class="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-2.5 text-sm text-zinc-800 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900">
    <span class="truncate" data-ss-label>{cur_label}</span>
    {lucide_html("chevron-down", "h-3.5 w-3.5 flex-shrink-0 text-zinc-400")}
  </button>
  <div class="absolute left-0 right-0 top-full z-30 mt-1 hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-950" data-ss-dropdown>
    <div class="border-b border-zinc-100 px-2 dark:border-zinc-900">
      <input type="text"
             placeholder="{self.placeholder}"
             class="block h-9 w-full bg-transparent text-sm placeholder:text-zinc-400 focus:outline-none"
             data-ss-search autocomplete="off" />
    </div>
    <div class="max-h-56 overflow-y-auto py-1" data-ss-options>
      <button type="button" data-ss-pick="" data-ss-search-text=""
              class="ss-row flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] italic text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-900">
        {self.empty_label}
      </button>
      {rows}
    </div>
  </div>
  {select_html}
  <noscript>
    <style>.ss-fallback {{ position: static !important; width: 100% !important; height: 2.25rem !important; clip: auto !important; }} .searchable-select [data-ss-trigger], .searchable-select [data-ss-dropdown] {{ display: none; }}</style>
  </noscript>
</div>
{self._init_script()}
"""
        return mark_safe(html)

    @staticmethod
    def _init_script() -> str:
        return """
<script>
(function () {
  if (window.__danbyteSearchableSelectInit) return;
  window.__danbyteSearchableSelectInit = true;

  function getSelect(box) {
    var name = box.dataset.field;
    return box.querySelector('select[name="' + name + '"]');
  }
  function close(box) {
    var dd = box.querySelector('[data-ss-dropdown]');
    if (dd) dd.classList.add('hidden');
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-ss-trigger]');
    if (trigger) {
      e.preventDefault();
      var box = trigger.closest('[data-ss]');
      var dd = box.querySelector('[data-ss-dropdown]');
      var nowOpen = dd.classList.contains('hidden');
      // Close any other open dropdown first.
      document.querySelectorAll('[data-ss-dropdown]').forEach(function (d) { d.classList.add('hidden'); });
      if (nowOpen) {
        dd.classList.remove('hidden');
        var search = dd.querySelector('[data-ss-search]');
        if (search) { search.value = ''; search.focus(); }
        // Reset row visibility.
        dd.querySelectorAll('.ss-row').forEach(function (r) { r.classList.remove('hidden'); });
      }
      return;
    }
    var pick = e.target.closest('[data-ss-pick]');
    if (pick) {
      e.preventDefault();
      var box = pick.closest('[data-ss]');
      var select = getSelect(box);
      select.value = pick.dataset.ssPick;
      // Update label.
      var label = box.querySelector('[data-ss-label]');
      var pickedLabel = pick.dataset.ssPick === '' ? label.textContent : pick.textContent.trim();
      if (pick.dataset.ssPick === '') {
        // Reset to the empty placeholder text the server rendered.
        label.textContent = (box.querySelector('[data-ss-pick=""]').textContent.trim());
      } else {
        label.textContent = pickedLabel;
      }
      // Fire change event so dependent JS / htmx triggers see it.
      select.dispatchEvent(new Event('change', {bubbles: true}));
      close(box);
      return;
    }
    if (!e.target.closest('[data-ss]')) {
      document.querySelectorAll('[data-ss-dropdown]').forEach(function (d) { d.classList.add('hidden'); });
    }
  });
  document.addEventListener('input', function (e) {
    var search = e.target.closest('[data-ss-search]');
    if (!search) return;
    var box = search.closest('[data-ss]');
    var needle = search.value.trim().toLowerCase();
    box.querySelectorAll('.ss-row').forEach(function (row) {
      var hay = row.dataset.ssSearchText || '';
      row.classList.toggle('hidden', needle && hay.indexOf(needle) < 0);
    });
  });
})();
</script>
"""
