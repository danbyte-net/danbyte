"""Re-save stored photos that still carry EXIF, XMP or other metadata (#291).

0.17.0-dev3 stored photos under 2000 px as uploaded, metadata included, and
device type photos are served without a login. Uploads strip it again
(``api.images``); this re-saves the photos stored in the meantime and removes
the old files. A photo without metadata is left alone, so it is safe to run
again. The old file goes only once the new one has been read back and found
clean, decodable and with every frame of the old one (#309).
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


def _timeline(img) -> tuple[int, int]:
    """The frame count of ``img`` and the sum of its frame durations."""
    from PIL import ImageSequence

    count = total = 0
    for frame in ImageSequence.Iterator(img):
        frame.load()  # a WebP frame's timing is read with its pixels
        count += 1
        total += frame.info.get("duration") or 0
    img.seek(0)
    return count, total


def _unfit(storage, name: str, before: tuple[int, int]) -> str:
    """Why the photo stored under ``name`` is no replacement - it does not
    decode, still carries metadata, or lost frames against the old file's
    ``before`` timeline - or '' when fit. Fewer frames are fine only when
    the running time is the same: the writers merge identical neighbours."""
    from PIL import Image

    from api.images import carries_metadata

    try:
        with storage.open(name, "rb") as fh:
            data = fh.read()
        img = Image.open(BytesIO(data))
        img.load()
        after = _timeline(img)
    except Exception as exc:  # noqa: BLE001 - anything unreadable disqualifies
        return f"not readable: {exc}"
    if carries_metadata(img, data):
        return "still carries metadata"
    frames, total = before
    if after[0] > frames or (after[0] < frames and (not total or after[1] != total)):
        return "lost frames"
    return ""


class Command(BaseCommand):
    help = "Re-save stored photos that still carry EXIF, XMP or other metadata, without it."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true",
                            help="list the photos without changing them")

    def handle(self, *args, dry_run=False, **options):
        from django.apps import apps
        from PIL import Image

        from api.images import carries_metadata, downscale_image

        found = kept = 0
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
                    if not carries_metadata(img, data):
                        continue
                    found += 1
                    old = field.name
                    if dry_run:
                        self.stdout.write(f"would strip {old}")
                        continue
                    try:
                        before = _timeline(img)
                        clean = downscale_image(ContentFile(data, name=os.path.basename(old)))
                        field.save(os.path.basename(old), clean, save=False)
                    except Exception as exc:  # noqa: BLE001 - one bad photo stops none
                        setattr(obj, name, old)
                        kept += 1
                        self.stderr.write(f"kept {old}: not re-saved: {exc}")
                        continue
                    new = field.name
                    problem = _unfit(field.storage, new, before)
                    if problem:
                        if new != old:
                            field.storage.delete(new)
                        setattr(obj, name, old)
                        kept += 1
                        self.stderr.write(f"kept {old}: {problem}")
                        continue
                    model.objects.filter(pk=obj.pk).update(**{name: new})
                    if new != old:
                        field.storage.delete(old)
                    self.stdout.write(f"stripped {new}")
        verb = "carry" if dry_run else "carried"
        self.stdout.write(f"{found} photo(s) {verb} metadata.")
        if kept:
            self.stdout.write(f"{kept} kept as stored: the replacement did not verify.")
