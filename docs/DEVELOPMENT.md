# Development and verification

Use Node.js 26, npm and PostgreSQL 17. The application is Next.js App Router / React / TypeScript with Drizzle and postgres.js. Amounts use integer minor units; preserve posting and database guards.

```sh
npm ci
npm run lint
npm run typecheck
```

## Isolated database tests

Database tests reset their target. Use a fresh, isolated PostgreSQL cluster with two empty databases: an application database and a distinct disposable test database matching `figtree_*_test`. Set `DATABASE_URL`, `TEST_DATABASE_URL`, exact `TEST_DATABASE_CONFIRMATION`, and separate APP/TEST attachment and Project directories. Never use everyday books or original-document storage for these commands.

Some suites additionally require current isolation evidence: actual database/role/port identity, observation that both databases started empty, and the SHA-256/mode-600 path of the current environment file. Historical proof files are deliberately not shipped. The included `scripts/ci-env.ts` generates this evidence for a fresh loopback CI environment with `CI=true`; inspect it and the workflow before use. It refuses nonempty or unsafe targets. Apply application migrations only after proof generation.

```sh
npm run db:migrate -- --database YOUR_EXACT_APPLICATION_DATABASE
npm run db:suites
```

The battery runs database suites, classifier checks, type generation and a production build. It records actual results in `docs/evidence/suites.md` and preserves failures. Individual commands and fault-injection tools are listed in `package.json`; inspect prerequisites before running them. Browser and PDF checks may require Playwright Chromium and Poppler (`pdftotext`, `pdftoppm`). GitHub Actions installs these tools as configured in its workflow.

The original package's MV4 initial-baseline mismatch and N12 source omission are described in [CI repair](CI_REPAIR.md). Preserve the no-growth ratchet after the documented one-time initial-baseline correction. Historical `docs/evidence/mutations.md` is a sanitized reference input for coverage reporting, not proof of a Banyan 0.0.1 test run.

## Synthetic demo

`npm run db:example` intentionally writes **the application database**, creating the fictional Maple Demo Consulting Ltd. and synthetic transactions. Use it only in a dedicated demo instance, after migrations. It refuses to duplicate an existing demo. It is not a production initialization step. Account setup remains separate.

## Source layout

- `src/app`: pages, server actions and HTTP routes
- `src/lib`: financial rules, authentication and shared infrastructure
- `src/modules`: add-on manifests and implementations
- `db`: ordered SQL migrations
- `scripts`: migration, verification, assembly and operations helpers
- `ops`: service / backup examples
- `vendor`: the pinned braces patch, its source and MIT notice

Dependency versions and integrity values are locked. The braces archive's legacy FigTree filename is intentional. Preserve technical namespaces described in [Provenance](PROVENANCE.md); changing a display brand does not justify rewriting sealed credentials or persisted formats.
