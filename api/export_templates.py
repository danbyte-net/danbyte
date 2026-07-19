"""Export-template rendering — Jinja2 in a sandbox.

Renders every object of a template's ``object_type`` (in the active tenant) with
the user-authored template. Uses Jinja's SandboxedEnvironment so a template
can't reach attributes/methods that would execute code or mutate data.
"""
from __future__ import annotations


def _objects_for(template, tenant):
    from auth_api.object_types import model_for

    model = model_for(template.object_type)
    if model is None:
        return None
    qs = model.objects.all()
    if any(f.name == "tenant" for f in model._meta.concrete_fields):
        qs = qs.filter(tenant=tenant)
    return list(qs)


def render_export_template(template, tenant) -> str:
    """Render the template against its object type. Raises ``ValueError`` on a
    bad object type and ``jinja2.TemplateError`` on a template problem."""
    from jinja2.sandbox import SandboxedEnvironment

    objects = _objects_for(template, tenant)
    if objects is None:
        raise ValueError(f"Unknown object type: {template.object_type}")

    env = SandboxedEnvironment(
        trim_blocks=True, lstrip_blocks=True, autoescape=False
    )
    tmpl = env.from_string(template.template_code or "")
    return tmpl.render(objects=objects, queryset=objects, count=len(objects))


def render_device_config(template, device, tenant) -> str:
    """Render an export template for a single device — the per-device
    intended-config generator. Context: ``device``, its merged ``config_context``,
    ``interfaces``, ``ip_addresses`` (and ``objects``/``count`` for parity)."""
    from jinja2.sandbox import SandboxedEnvironment

    from .config_context import render_config_context

    env = SandboxedEnvironment(
        trim_blocks=True, lstrip_blocks=True, autoescape=False
    )
    tmpl = env.from_string(template.template_code or "")
    return tmpl.render(
        device=device,
        config_context=render_config_context(device)["rendered"],
        interfaces=list(device.interfaces.all()),
        ip_addresses=list(device.ip_addresses.all()),
        objects=[device],
        count=1,
    )


def render_vm_config(template, vm, tenant) -> str:
    """Render an export template for a single virtual machine — the per-VM
    generator behind the Terraform-for-VMs flow (the template author writes
    tfvars/HCL). Context mirrors the device renderer: ``vm`` (also exposed as
    ``device`` for template parity), merged ``config_context``, ``interfaces``,
    ``ip_addresses``."""
    from jinja2.sandbox import SandboxedEnvironment

    from .config_context import render_config_context

    env = SandboxedEnvironment(
        trim_blocks=True, lstrip_blocks=True, autoescape=False
    )
    tmpl = env.from_string(template.template_code or "")
    return tmpl.render(
        vm=vm,
        device=vm,  # parity: templates can use the same `device.*` accessor
        config_context=render_config_context(vm)["rendered"],
        interfaces=list(vm.interfaces.all()),
        ip_addresses=list(vm.ip_addresses.all()),
        objects=[vm],
        count=1,
    )
