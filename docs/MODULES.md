# Modules

The source package includes the financial foundation and all add-ons. They share one release version, authentication model, database and posting engine.

The foundation covers ledger/reporting, invoices and bills, bank workflows, tax, FX, imports, budgets, automation, portal and AI/MCP infrastructure. Optional external services remain disabled until configured.

Add-ons: **PAYROLL**, **RECORDS**, **CRM**, **ESIGN**, **PROJECT**, **OPS**, **SRED**. Project connects revenue, costs, invoices and payments; Payroll provides Canadian federal/BC calculations; Operations connects assets, inventory and production to the books. Operations and SR&ED require Payroll in the assembly selection.

## Build selection

The default source includes all add-ons. To create a separate source assembly:

```sh
npm run modules:assemble -- --modules base --out build/assembled/base
npm run modules:assemble -- --modules PROJECT,PAYROLL,OPS --out build/assembled/project-payroll-ops
```

Run each command with a new output directory; existing output is never overwritten. Enter the selected output, install from its lockfile, configure its environment and build. `--build` can request the assembly's build step. Database migration selection follows the assembly manifest; do not manually remove SQL files.

Build exclusion is different from enabling modules for a company or granting a user access. Configure the company's modules and user grants within the application too. A hidden navigation item alone is not a deployment boundary.

## Boundary policy

The original 0.0.1 package inherited an unrecorded dependency: `invoice_template_snapshot_frozen -> PROJECT`. The CI repair explicitly corrects Banyan's initial baseline to accept this already shipped relation. This expands the accepted set by that one relation; it does not remove the underlying runtime coupling. The no-growth ratchet applies after this one-time correction, and other unrecorded dependencies remain rejected.

Default full-source behavior and selective assemblies have different verification scope. Treat selective assembly as preview functionality and validate the selection you intend to deploy. See [CI repair](CI_REPAIR.md).
