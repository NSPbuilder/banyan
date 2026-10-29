# Banyan 0.0.1 CI repair

The first public run [40786078837](https://github.com/NSPbuilder/banyan/actions/runs/40786078837) at commit `b888c5da8ad773bb4b23900cc4e76d502eba0f30` failed in two checks: **MV4** (an unrecorded existing Project dependency) and **N12** (missing attachment routes).

## Corrections

1. `scripts/module-baseline.json` explicitly adds `invoice invoice_template_snapshot_frozen -> PROJECT` as a one-time correction to Banyan's initial baseline. The accepted dependency set grows by this one already shipped relation; the underlying runtime coupling remains. The no-growth ratchet applies afterward. The checker itself is unchanged and still rejects other unrecorded dependencies.
2. Root-only ignore and export patterns replace the unanchored `attachments` / `node_modules` rules. The old ignore rule also matched `src/.../attachments`, omitting seven authenticated attachment endpoints/redirect pages. The restored files come from the same FigTree source commit `ed0e3a351ac7a8ff6f020487f6cf6f3dfe2a6596`; the only display-string adjustment is Banyan in the upload-origin error.
3. The same ignore-rule correction restores 55 nested third-party notice files already named in the dependency inventory. Dependency versions and licenses are unchanged.

No accounting calculation, posting rule, database migration, permission check, backup format or application version changes. The version remains **0.0.1**. Preserve the original archive/checksum as historical artifacts; use the corrected package or patch for the repository.

## Verification boundary

The preparation record in [RELEASE_CHECKS.md](RELEASE_CHECKS.md) describes the original richer staging tree. It did not qualify the subsequently omitted routes. Repair verification instead creates a fresh Git snapshot, compares every expected upstream source path and copied notice, archives that Git snapshot, extracts it into a new directory, and runs the configured full battery there with fresh isolated APP/TEST identities and current mode-600 isolation evidence. Build/type/lint and actual results are reported with the repair delivery.

The module-check discrimination probe introduces a disposable unrecorded Project-reading trigger and confirms MV4 still rejects it, then removes the probe. Runtime coupling, live provider checks, native printers and selective-assembly acceptance remain separate boundaries. No remote success is claimed until the corrected repository's Actions actually completes.
