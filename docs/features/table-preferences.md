---
icon: lucide/table
---

# Table columns

Every list in Danbyte lets you choose which columns to show and in what order.
Your layout is remembered per table, and an administrator can publish a shared
default for everyone.

## Customizing a table

Open the **Columns** menu in the table's toolbar. It has two parts:

- **Shown** - the columns on screen, in table order. Drag a column by its grip
  to move it; untick it to hide it.
- **Available** - everything else the table can show, in sections, each sorted
  alphabetically. Tick one and it joins the end of **Shown**.

Press **Save** to keep the layout. Closing the menu without saving discards
your changes. **Reset** (when you have a saved layout) goes back to the tenant
default. A long list gets a search box at the top; while you type, dragging is
off.

!!! note
    A few columns (like the row-select checkbox and the row-actions menu) always
    stay in place and can't be moved or hidden.

## Every field is a column

A table is not limited to the columns its page was designed with. The
**Available** part lists:

| Section | What is in it |
|---|---|
| **Columns** | The table's own columns you have hidden. |
| **Fields** | Every other field the list's rows carry - a device's asset tag, airflow, rack position, created date. |
| **Related** | Linked objects, including one step further out: a device's **Region** (its site's region), location, rack, platform, primary / secondary / OOB IP, config template. An interface's **Link peer** reads as the far device and port (`sw1 · Gi1/0/1`). |
| **Custom fields** | Every custom field defined for that object type. |

These columns start hidden, so a table looks the same until you tick one. They
sort when you click their header (numbers by value, text in natural order,
empty cells last), and they are included in [exports](exporting-tables.md).

The list is built from what the list's rows actually contain (see
`GET /api/list-fields/` in the [API reference](../reference/api.md)), so a field
added to a list later appears here on its own - nobody maintains a list of
columns per table. It never adds data: you only see fields the list already
sends to you. Device fields an administrator has switched off (**Settings →
Device fields**, e.g. airflow and cluster) are not offered, and neither are
fields with nothing to show in a cell - internal flags, sets of figures, and
counts the detail page computes for one object only.

!!! tip "Filtering by one of these columns"
    The filter rail keeps its designed facets. To filter on any other field,
    use the advanced filter expression (for example `location.name = "Hall A"`,
    `site.region = "Nordics"` or `custom_fields.owner = "noc"`).

## Sorting

Click a column header to sort by it; click it again to reverse. Text sorts in
natural order, the way you count: `DIMM 1, DIMM 2 … DIMM 10, DIMM 11`, and
`Ethernet1/2` before `Ethernet1/10`, with case ignored. Numbers and dates sort
by value. The order is the same whatever language your browser uses. Before
you click anything, a list shows rows in the order the server sends them,
which is the same natural order by name.

## Selecting rows

On a list with checkboxes, the header checkbox ticks the rows on the current
page. When the list runs to more pages, **Select all N** appears beside the
count above the table and ticks every row the filters show; **Clear** undoes
it. A tick belongs to the object, not to its row position, so sorting,
filtering or a refresh never moves it onto another row. A row that leaves the
list - filtered away or deleted - leaves the selection too, so the count only
ever covers rows you can see.

## Where your settings live

Manage all your saved table layouts in one place under **User → Preferences**,
where each table shows its current state with a **Reset** option. Tabs on
detail pages remember their layout too, but are left out of that list.

## Shared defaults (administrators)

If you can manage users, you can publish a starting layout for your whole tenant
under **Settings → Table layouts**:

| Action | Effect |
|---|---|
| **Publish** | Makes your current layout of that table the tenant default. |
| **Lock** | Forces that default - everyone uses it and can't change their own. |
| **Unlock** | Lets people customize again, starting from the default. |
| **Clear** | Removes the tenant default entirely. |

!!! note "How a layout is chosen"
    Danbyte shows the most specific layout that applies: a **locked** tenant
    default wins over everything; otherwise **your own** saved layout; otherwise
    the tenant default; otherwise the table's natural order. When a table is
    locked, its column controls are disabled and a lock icon appears. A
    column added to Danbyte since the lock takes its default, as in any saved
    layout: a new built-in column is shown, fields and custom fields stay
    hidden until the administrator publishes a layout that shows them.

!!! note "What a saved layout records"
    A layout remembers the columns it knew about and which of them were
    hidden. A column you ticked stays shown; a column added to Danbyte after
    you saved takes its default - shown for new built-in columns (in their
    designed place), hidden for fields and custom fields.

## Related

- [Exporting tables](exporting-tables.md) - exports follow your visible columns.
- [Tags & custom fields](tags-and-custom-fields.md) - custom fields as columns.
