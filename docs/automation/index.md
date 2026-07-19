# Automation & integrations

Use Danbyte as the source of truth for your automation — feed config data to
devices, render configs, and notify other systems when things change.

!!! tip "New to this? Start with the orientation"
    Danbyte **never touches your devices** — it stores the intended config and
    hands the work to a runner *you* control. The
    [config-drift guide](../features/iac-runner.md#where-do-i-click-orientation)
    has a "where do I click" map, and **Integrations → Automation targets →
    Guided setup** connects your first runner in three steps.

## In this section

| Page | What it's for |
|---|---|
| [Config contexts](../features/config-contexts.md) | Attach configuration data to devices/VMs by matching site, role, platform, and more. |
| [Export templates](../features/export-templates.md) | Render objects to text (configs, reports) with templates. |
| [Config drift (Ansible/Terraform)](../features/iac-runner.md) | Run an external Ansible/Terraform runner against Danbyte as source of truth; report config drift and sync. |
| [Advanced: custom-field-driven playbook](../features/cf-driven-playbook.md) | Use a per-device boolean custom field as a feature flag a runner reads from the inventory (e.g. install btop when on). |
| [Webhooks](../features/webhooks.md) | Notify external systems on create / update / delete, signed for verification. |
| [Import & export](../features/import-export.md) | Move data in and out as CSV / XLSX. |
