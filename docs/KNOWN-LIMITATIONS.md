# Known limitations — 0.0.1

Banyan 0.0.1 is an early self-hosted preview, derived from the FigTree 0.0.14 source snapshot. It is not represented as a fully qualified general-purpose ERP or a completed statutory filing service.

- Canadian federal and BC workflows are the focus. Payroll, tax, corporate and SR&ED outputs are working information; confirm applicability, rates and filing requirements for the intended period and jurisdiction.
- The configured full verification battery has a known inherited module-ownership failure: **MV4**, `invoice_template_snapshot_frozen -> PROJECT`. It remains visible and is not bypassed. Selective module assemblies require their own acceptance.
- **Payment in stages** is invoice/PDF text only. It creates no payment schedule, balances, due dates, aging rules or postings.
- Attachments in a receipt are appended pages. Supported PDF/image validity and size/page limits apply. Native browser print dialogs, operating-system printers and particular devices need operator acceptance.
- AI, e-sign, SMTP, payment and inbound-message services require their own setup and may process data outside the host. Live provider acceptance is not implied by local checks.
- On Node.js 26, the inherited PDF library can reject some small JPEG logo buffers (the pooled-buffer offset issue). Use PNG for small logos; this package does not alter that PDF library contract. The synthetic JPEG fixture is larger than the pooled-buffer threshold.
- The personal Microsoft 365/Outlook mailbox prototype is excluded.
- Builds fetch npm dependencies and Google Fonts; fully offline builds have not been packaged.
- Recovery depends on database, both document stores, settings and encryption keys. `.fig` company export alone is not a full disaster-recovery backup.
- Persistent technical identifiers retain FigTree for compatibility. They are not unfinished user-facing version numbering.

See `RELEASE_CHECKS.md` for the actual checks completed on this source package and their limits. No historical private client database, receipt, attachment, account, credentials or deployment configuration is distributed.
