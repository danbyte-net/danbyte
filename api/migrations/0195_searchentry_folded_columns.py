"""Store the folded search text in generated columns (#300).

Search matched ``danbyte_fold(title)`` and ``danbyte_fold(body)``, backed by
trigram indexes on those expressions. A term the indexes cannot serve - one
or two characters have no trigram - folded the title and body of every row
in the tenant, several times per row, on every keystroke. ``title_f`` and
``body_f`` hold the folded text, computed by PostgreSQL whenever a row is
written, and the trigram indexes move onto them.

The old expression indexes are dropped first so the table rewrite that
adding the columns causes does not rebuild them, and both columns are added
in one ALTER TABLE, so the table is rewritten once. ANALYZE gives the
planner statistics for the new columns before the first search. A process
still on the previous release inserts without naming the columns, and its
search still runs, without the indexes, until it restarts.

The columns are not model fields: only the search SQL reads them and
PostgreSQL alone writes them, like the expression indexes before them.
"""
from django.db import migrations

FORWARD = [
    'DROP INDEX IF EXISTS "searchentry_title_trgm";',
    'DROP INDEX IF EXISTS "searchentry_body_trgm";',
    'ALTER TABLE "api_searchentry" '
    'ADD COLUMN "title_f" text GENERATED ALWAYS AS (danbyte_fold("title")) STORED, '
    'ADD COLUMN "body_f" text GENERATED ALWAYS AS (danbyte_fold("body")) STORED;',
    'CREATE INDEX "searchentry_title_f_trgm" ON "api_searchentry" '
    'USING gin ("title_f" gin_trgm_ops);',
    'CREATE INDEX "searchentry_body_f_trgm" ON "api_searchentry" '
    'USING gin ("body_f" gin_trgm_ops);',
    'ANALYZE "api_searchentry";',
]

REVERSE = [
    'DROP INDEX IF EXISTS "searchentry_title_f_trgm";',
    'DROP INDEX IF EXISTS "searchentry_body_f_trgm";',
    'ALTER TABLE "api_searchentry" DROP COLUMN IF EXISTS "title_f", '
    'DROP COLUMN IF EXISTS "body_f";',
    'CREATE INDEX "searchentry_title_trgm" ON "api_searchentry" '
    'USING gin (danbyte_fold("title") gin_trgm_ops);',
    'CREATE INDEX "searchentry_body_trgm" ON "api_searchentry" '
    'USING gin (danbyte_fold("body") gin_trgm_ops);',
    'ANALYZE "api_searchentry";',
]


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0194_interface_never_uplink"),
    ]

    operations = [
        migrations.RunSQL(FORWARD, REVERSE),
    ]
