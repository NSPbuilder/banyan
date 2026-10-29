# Original release checks — Banyan 0.0.1

This is the historical preparation record. Its full battery ran on the richer staging tree; it did not detect the seven source files omitted by Git ignore rules. The later public CI exposed MV4 and N12. See [CI repair](CI_REPAIR.md) for the correction and archive-based qualification procedure.

Qualification date: 2026-10-28. Source base: FigTree `ed0e3a351ac7a8ff6f020487f6cf6f3dfe2a6596`. All application/test data was synthetic, in fresh owned loopback PostgreSQL resources. Production was not accessed.

| Check | Observed result |
|---|---|
| Clean dependency installation | `npm ci` succeeded; lockfile dependency entries preserved |
| Lint | Exit 0; two inherited unused-variable warnings (`later` and `sameDayLater`) in `verify-receipts.ts` |
| Type generation / TypeScript | Exit 0 |
| Production build | Exit 0 |
| Configured full battery | 81 entries; one non-green entry, `db:verify-modules` (MV4) |
| Verification assertions | 2,995 verify PASS lines; this does not count distinct requirements or skipped paths |
| Receipt/supporting tests | 49 receipt checks and 53 supporting-attachment checks passed, including shared Project/Income files, deletion and combined PDF behavior |
| Migration / dependency identity | All 159 migration files and all non-root locked package entries unchanged |
| Brand and compatibility | Banyan name/version/icon verified; backup/audit/encryption/MCP identity markers retained |
| Browser | Password sign-in observed; company workspace, Income, invoice, journal, financial statements and payroll rendered with synthetic data |
| Layout | Original/Banyan desk bounds compared at 1920×1200 and 390×844; no brand/tab overlap, document-width overflow, broken images or invalid visible SVG viewBoxes in measured views |
| CI setup | Fresh observed-empty setup and four unsafe-target refusals exercised locally; hosted GitHub Actions was not run |
| Security | Fresh-source secret scan, synthetic-secret rejection probe, dependency policy and pinned-patch checks passed |

Environment: Node.js 26.12.0, npm 11.20.0, PostgreSQL 17 on macOS. This is source-package qualification, not a claim of full cross-platform/provider/printer acceptance. The initial full battery exposed stale brand assertions and a client-logo fixture dependency; those package defects were corrected and the full configured battery rerun.

**Known failure:** MV4 reports `invoice_template_snapshot_frozen -> PROJECT`. The suite still exits 1 and the check has not been disabled or reclassified. The inherited small-JPEG pooled-buffer issue on Node.js 26 is documented in [Known limitations](KNOWN-LIMITATIONS.md); a valid larger synthetic JPEG is used for the general branding fixture and PNG is recommended for small logos.

The published ZIP also has an internal path/hash manifest and an external SHA-256 checksum. The exact archive is extracted and checked separately before delivery; external package verification records accompany the delivery. Historical mutation reference text is not presented as a new test run. Native print dialogs and live third-party services were not accepted here.
