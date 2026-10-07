# Upstream baseline

- Canonical upstream: `https://github.com/ArnasDon/wacrm.git`
- Maintained fork: `https://github.com/imumang/wacrm.git`
- Upstream baseline commit: `80c3f9a1aecdaf21b98311f230fdaaaec7d85f7d`
- Immutable baseline tag: `wacrm-upstream-80c3f9a`

This fork was established from a clone of the canonical upstream at the baseline commit above. At the time of the fork audit, the WACRM customizations existed as uncommitted tracked modifications and untracked product files in the working tree. They were preserved in a verified pre-change filesystem checkpoint before being organized into reviewable commits.

The permanent remote topology is:

- `origin` points to the maintained fork and is the normal push target.
- `upstream` points to the canonical upstream and is used only for comparison and explicitly planned integration work.

To compare future upstream changes without merging them, fetch the upstream refs and review the range from the immutable baseline, for example:

```bash
git fetch upstream
git log --oneline wacrm-upstream-80c3f9a..upstream/main
git diff --stat wacrm-upstream-80c3f9a..upstream/main
```

Fetching for comparison does not authorize merging or rebasing upstream changes into this fork.

## Customization and upgrade registry

Git remains authoritative for exact code changes. The maintained intent and update-safety registry is described in [`docs/customization-registry.md`](./customization-registry.md) and stored locally at `D:\AI-Skills-Vault\Projects\WACRM_Customizations`.

Upstream integration must use a dedicated reviewed upgrade branch. Cross-reference upstream-changed paths against the registry, reconcile every affected customization, run the complete verification matrix, and produce an Upgrade Report before moving this baseline marker.
