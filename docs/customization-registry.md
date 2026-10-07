# WACRM customization registry

This repository is the maintained WACRM fork at `https://github.com/imumang/wacrm.git`. Canonical upstream is `https://github.com/ArnasDon/wacrm.git`; the initial locked baseline is `80c3f9a1aecdaf21b98311f230fdaaaec7d85f7d`, tagged `wacrm-upstream-80c3f9a`.

Git is authoritative for exact changes. The human/AI-readable intent, dependency, risk, and upstream-review registry is maintained as an Obsidian vault at:

`D:\AI-Skills-Vault\Projects\WACRM_Customizations`

The registry contains core patch records, fork-owned module records, migration history, architecture decisions, the permanent upgrade procedure, and upgrade-report templates. It is external to this repository, so this file and [`upstream-baseline.md`](./upstream-baseline.md) remain the durable discovery points in a fresh clone.

## Upgrade policy

Upstream updates happen on dedicated reviewed upgrade branches. Review the old baseline against a chosen candidate upstream commit, cross-reference upstream-changed paths against the Core Patch Registry, reconcile every overlap, run the full verification matrix, and write an Upgrade Report. Never replace customized files blindly or move the baseline marker before acceptance.

## Documentation completion rule

Any task that changes an upstream-owned file, integration seam, database migration, or documented architecture decision must update the corresponding customization registry record before the task is complete. Record the relevant commit SHA after it exists, update tests and risk where necessary, and refresh the registry index. Trivial generated files and formatting-only changes are exempt.

