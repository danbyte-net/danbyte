"""Trigram + accent-folding support for global search.

Both extensions are *trusted* in PostgreSQL 13+, so the application role can
create them without superuser. ``danbyte_fold`` wraps ``lower(unaccent(...))``
as an IMMUTABLE function so it can back an index expression.
"""
from django.contrib.postgres.operations import TrigramExtension, UnaccentExtension
from django.db import migrations

FOLD_SQL = """
CREATE OR REPLACE FUNCTION danbyte_fold(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT lower(unaccent('unaccent'::regdictionary, $1)) $$;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0156_prefix_allocate_from_ranges"),
    ]

    operations = [
        TrigramExtension(),
        UnaccentExtension(),
        migrations.RunSQL(FOLD_SQL, "DROP FUNCTION IF EXISTS danbyte_fold(text);"),
    ]
