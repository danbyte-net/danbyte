from django.db import migrations


def link_by_todays_rule(apps, schema_editor):
    """Preserve exactly what name-matching resolved to, for every existing pair.

    The old rule was "the connection whose name equals the engine's, else the
    first enabled one". Replaying it here means no install changes behaviour on
    upgrade - the guess simply becomes a record of itself, which somebody can
    then correct.
    """
    Connection = apps.get_model("zabbix", "ZabbixConnection")
    Engine = apps.get_model("monitoring", "MonitoringEngine")
    for engine in Engine.objects.filter(kind="zabbix"):
        rows = Connection.objects.filter(tenant_id=engine.tenant_id, enabled=True)
        conn = rows.filter(name=engine.name).first() or rows.order_by("name").first()
        if conn is not None:
            conn.engines.add(engine)


def unlink(apps, schema_editor):
    Connection = apps.get_model("zabbix", "ZabbixConnection")
    for conn in Connection.objects.all():
        conn.engines.clear()


class Migration(migrations.Migration):
    dependencies = [("zabbix", "0007_connection_engines")]
    operations = [migrations.RunPython(link_by_todays_rule, unlink)]
