"""Per-VM render endpoint — the Terraform-for-VMs pull surface.

A user authors an ExportTemplate (object_type=virtualmachine) whose body is
tfvars/HCL, and a Terraform workspace pulls the rendered output for one VM from
here — the same "Danbyte renders intended state, the runner applies it" pattern
as the Ansible inventory + device render. Standalone view (not a viewset action)
so it lives independently of the VM CRUD viewset.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from jinja2 import TemplateError
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status as drf_status

from auth_api import rbac

from .export_templates import render_vm_config
from .models import ExportTemplate, VirtualMachine
from .views import _get_active_tenant


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def vm_render_view(request, pk):
    """GET /api/virtual-machines/<id>/render/?template=<export-template-id>
    → {output, template}. Tenant-scoped; template must be object_type=virtualmachine.
    """
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."},
                        status=drf_status.HTTP_400_BAD_REQUEST)
    # The render merges config-context (may hold secrets), so fetch through the
    # RBAC row filter — a VM outside the caller's view grant / site scope 404s
    # here rather than leaking its existence (#59). restrict_queryset honours
    # ObjectPermission.sites, so a Site-A-scoped viewer can't render a Site-B VM.
    vm = (
        rbac.restrict_queryset(
            VirtualMachine.objects.filter(tenant=tenant),
            request.user, tenant, "virtualmachine", "view",
        )
        .filter(id=pk)
        .first()
    )
    if vm is None:
        return Response({"detail": "Unknown virtual machine."},
                        status=drf_status.HTTP_404_NOT_FOUND)
    tid = request.query_params.get("template")
    try:
        tmpl = ExportTemplate.objects.filter(
            id=tid, tenant=tenant
        ).first() if tid else None
    except (ValueError, ValidationError):
        tmpl = None  # malformed template id → treat as unknown
    if tmpl is None:
        return Response({"detail": "Unknown template."},
                        status=drf_status.HTTP_400_BAD_REQUEST)
    try:
        output = render_vm_config(tmpl, vm, tenant)
    except (TemplateError, ValueError) as exc:
        return Response({"detail": str(exc)},
                        status=drf_status.HTTP_400_BAD_REQUEST)
    return Response({"output": output, "template": tmpl.name})
