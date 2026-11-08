"""Name and slug checks for the tenant catalogs (platforms, roles, groups,
manufacturers, RIRs, ...): one rule on create and on update.

- A name another row of the catalog has (case aside) is refused on create
  and on a rename, with the error on ``name``. An update that keeps the name
  is never refused for it, so rows that already share a name stay editable.
- An update without a slug and without a rename keeps the row's slug; a
  rename without a slug takes the new name's.
- A slug another row has is refused: on ``slug`` when the client sent one,
  else on ``name`` (the slug came from the name).
"""
from __future__ import annotations

from django.utils.text import slugify
from rest_framework.exceptions import ValidationError

IN_USE = "Name already in use."


def check_name_and_slug(
    serializer, tenant, model, *, message: str = IN_USE, empty: str = ""
) -> None:
    """``empty``: refuse a name with no letters or digits, with this."""
    data = serializer.validated_data
    inst = serializer.instance
    name = data.get("name", inst.name if inst else "")
    renamed = inst is None or name != inst.name
    given = data.get("slug")
    if given:
        slug = given
    elif not renamed:
        slug = inst.slug
    else:
        slug = slugify(name)
    if empty and not slug:
        raise ValidationError({"name": empty})
    data["slug"] = slug
    others = model.objects.filter(tenant=tenant)
    if inst is not None:
        others = others.exclude(pk=inst.pk)
    if renamed and name and others.filter(name__iexact=name).exists():
        raise ValidationError({"name": message})
    if others.filter(slug=slug).exists():
        raise ValidationError({"slug": "Slug already in use."} if given else {"name": message})
