"""Daily rollups never stored spikes (#271). Fill each daily row's from the
spikes of its UTC day's hourly rows, which are kept 30 days; a day with
none of them is left as it is. One set-based UPDATE that only touches the
rows it changes, so running it again changes nothing."""

from django.db import migrations

FILL_DAILY_SPIKES = """
UPDATE monitoring_checkrollupdaily AS d
   SET spikes = h.spikes
  FROM (
        SELECT tenant_id, target_ip_id, template_id,
               date_trunc('day', bucket AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day,
               SUM(spikes) AS spikes
          FROM monitoring_checkrolluphourly
         WHERE spikes > 0 AND target_ip_id IS NOT NULL AND template_id IS NOT NULL
         GROUP BY 1, 2, 3, 4
       ) AS h
 WHERE d.tenant_id = h.tenant_id
   AND d.target_ip_id = h.target_ip_id
   AND d.template_id = h.template_id
   AND d.bucket = h.day
   AND d.spikes <> h.spikes
"""


class Migration(migrations.Migration):

    dependencies = [
        ("monitoring", "0104_rollup_blind_incidents"),
    ]

    operations = [
        migrations.RunSQL(FILL_DAILY_SPIKES, migrations.RunSQL.noop),
    ]
