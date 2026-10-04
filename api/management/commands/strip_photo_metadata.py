"""Re-save stored photos that still carry EXIF, XMP or other metadata (#291).

0.17.0-dev3 stored photos under 2000 px as uploaded, metadata included, and
device type photos are served without a login. Uploads strip it again
(``api.images``); this re-saves the photos stored in the meantime and removes
the old files. A photo without metadata is left alone, so it is safe to run
again.
"""
from __future__ import annotations

import os
from io import BytesIO

from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand

# The photos uploads pass through api.images: device type faces and image
# attachments.
PHOTO_FIELDS = (
    ("api.DeviceType", ("front_image", "rear_image")),
    ("api.ImageAttachment", ("image",)),
)


class Command(BaseCommand):
    help = "Re-save stored photos that still carry EXIF, XMP or other metadata, without it."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true",
                            help="list the photos without changing them")

    def handle(self, *args, dry_run=False, **options):
        from django.apps import apps
        from PIL import Image

        from api.images import carries_metadata, downscale_image

        found = 0
        for label, fields in PHOTO_FIELDS:
            model = apps.get_model(label)
            for obj in model.objects.all().iterator():
                for name in fields:
                    field = getattr(obj, name)
                    if not field or not field.name:
                        continue
                    try:
                        with field.open("rb") as fh:
                            data = fh.read()
                        img = Image.open(BytesIO(data))
                        img.load()
                    except Exception:  # noqa: BLE001 - missing or not an image
                        continue
                    if not carries_metadata(img):
                        continue
                    found += 1
                    old = field.name
                    if dry_run:
                        self.stdout.write(f"would strip {old}")
                        continue
                    clean = downscale_image(ContentFile(data, name=os.path.basename(old)))
                    field.save(os.path.basename(old), clean, save=False)
                    model.objects.filter(pk=obj.pk).update(**{name: field.name})
                    if field.name != old:
                        field.storage.delete(old)
                    self.stdout.write(f"stripped {field.name}")
        verb = "carry" if dry_run else "carried"
        self.stdout.write(f"{found} photo(s) {verb} metadata.")
