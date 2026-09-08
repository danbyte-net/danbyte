---
icon: lucide/braces
---

# Script SDK reference

Everything a [script](../features/scripts.md) can import. The package is
`danbyte_sdk`; it needs nothing installed and works the same in a
sandboxed and a trusted run.

```python
from danbyte_sdk import db, run
```

## `db` - the data

`db` talks to the Danbyte API with the run's token, so every call is scoped
to the account the run belongs to and shows up in the change log under that
name. Object types are the API's own names; `"device"` and `"devices"` both
work.

| Call | Does |
|---|---|
| `db.list(type, **filters)` | Every matching object, following pagination. Filters are the query parameters the UI uses, e.g. `db.list("devices", site="aarhus", status="active")`. `limit=` caps the result. |
| `db.get(type, id)` | One object by id. |
| `db.create(type, data)` | Create, returning the new object. |
| `db.update(type, id, data)` | Partial update, returning the object. |
| `db.delete(type, id)` | Delete. |
| `db.search(q, type=, limit=)` | The global search, same ranking as the palette. |
| `db.request(method, path, params=, data=)` | Any other endpoint, for the things the helpers do not cover. |

A failed call raises `ApiError` with `status` and `detail`:

```python
from danbyte_sdk import ApiError, db, run

try:
    db.create("devices", {"name": "sw-01"})
except ApiError as exc:
    if exc.status == 403:
        run.fail("This script's account cannot create devices.")
    raise
```

## `run` - the run

| Call | Does |
|---|---|
| `run.params` | Every parameter as a dict. |
| `run.param(name, default=None)` | One parameter. |
| `run.log(*parts)` | A timestamped line in the run log, flushed at once. Plain `print` works too. |
| `run.fail(message)` | End the run as failed with that message, no traceback. |
| `run.output(name, content)` | Write a file for download. Text or bytes. |
| `run.output_csv(name, rows, fields=None)` | A CSV from dicts or sequences. The header comes from `fields`, or the first row's keys. |
| `run.output_json(name, data)` | A JSON file, pretty-printed. |
| `run.id` | This run's id. |

Output names are reduced to a plain filename, so a script cannot write
outside its own run directory.

## `orm` - trusted scripts only

```python
from danbyte_sdk import orm
```

Importing it in a sandboxed run raises with a message pointing back at
`db`.

| Call | Does |
|---|---|
| `orm.objects(slug)` | A queryset of that type, already restricted to what the run-as account may view, and filtered to the run's tenant. |
| `orm.model(slug)` | The model class itself. No scoping - it is the whole table. |

## Limits

| Limit | Value |
|---|---|
| Wall-clock timeout | The script's own setting, five minutes by default, an hour at most |
| Memory | 1 GB of address space |
| Log kept | 512 KB, then truncated with a note |
| Output files | 200 files, 64 MB in total |

Exceeding the log or file limits truncates rather than failing the run;
exceeding time or memory stops it.

## Running one outside Danbyte

The same package works from a terminal against any install, which is handy
while writing:

```bash
export DANBYTE_URL=https://danbyte.example.com
export DANBYTE_TOKEN=dbt_…        # a normal API token
python my_script.py
```

`run.output_*` needs a run directory, so set `DANBYTE_OUTPUT_DIR` to a
folder you can write, or leave the output calls out while testing.
