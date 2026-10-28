# Installing Banyan 0.0.1

## Requirements

- Node.js 26 and npm (validated release environment); PostgreSQL 17 server and matching client tools.
- A persistent application database, attachment storage and separate Project storage.
- A host able to run Next.js / React / TypeScript. Linux and macOS operations scripts are included. No Windows or container qualification is claimed.
- Internet access during `npm ci` and build. `next/font` downloads Inter, Source Serif 4 and Geist Mono at build time and serves the resulting fonts locally.

## Fresh local installation

Extract the source ZIP and enter `Banyan-0.0.1`. Install dependencies with `npm ci`, then copy `.env.example` to `.env.local` and restrict it to the service account (`chmod 600 .env.local` on Unix).

Create a dedicated PostgreSQL login and an empty database owned by it using your database administrator's normal procedure. The examples use database `banyan_local`. Do not point a fresh installation at existing business books.

Set in `.env.local`:

```dotenv
DATABASE_URL=postgresql://banyan:YOUR_URL_ENCODED_PASSWORD@127.0.0.1:5432/banyan_local
ATTACHMENTS_DIR=/absolute/persistent/path/banyan/attachments
PROJECT_ATTACHMENTS_DIR=/absolute/persistent/path/banyan/project-attachments
```

Create both storage directories and grant the application account read/write access. They must be separate directories, outside the source folder, and backed up together with PostgreSQL. Replace every example path and password. Percent-encode credentials in connection URLs.

Optional encryption keys must be generated locally, never copied from examples. For example:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))'
```

Use a separate generated key for each configured purpose. `AUTH_MFA_KEY` uses 32 random bytes encoded as base64; `AI_KEY_SECRET` and `INTEGRATION_KEY_SECRET` can use separately generated random 32-byte hex strings. Preserve configured keys securely for future recovery. Review [integration settings](INTEGRATIONS.md); most integrations are disabled by default.

Initialize the exact database selected in `DATABASE_URL`:

```sh
npm run db:migrate -- --database banyan_local
npm run build
npm run start
```

On `http://localhost:3000/first-run`, create the initial administrator and set up a company, accounts and fiscal year. First-run registration closes once a user exists. Keep the application private until that account is created. Development uses `npm run dev`; everyday operation should use the built application.

`TEST_DATABASE_URL` and `TEST_DATABASE_CONFIRMATION` are only needed for verification, which resets its target. Do not use the application database for tests. See [Development](DEVELOPMENT.md).

## Public self-hosting

Serve the application behind an HTTPS reverse proxy. Bind the application port privately, block direct public access to it, and configure the proxy to overwrite any header you explicitly trust. Enable `AUTH_TRUSTED_IP_HEADER` only when the ingress topology enforces that contract. Do not simply trust a header supplied by arbitrary clients.

`ops/banyan.service` is a Linux systemd example using service account `banyan`, source path `/srv/banyan` and `/usr/bin/node`. Adapt these paths and PostgreSQL service dependencies to your host before installing it. It binds Next.js to loopback. Place the mode-600 `.env.local` in the working directory and make persistent storage accessible to the service account. The template is not an installer.

Select the permanent HTTPS origin before enabling passkeys, MCP, a payment portal or provider webhooks. Review [Integrations](INTEGRATIONS.md). Run scheduled automation only when deliberately configured; starting the web process does not replace a worker schedule.

## Updating

Banyan has its own release numbering: this first source package is **0.0.1**, derived from FigTree 0.0.14. It is not a promise that any arbitrary older installation can be upgraded without rehearsal.

Before an update: stop writes, take and verify a complete database plus file backup, preserve encryption keys and environment settings, and rehearse restoration into a separate instance. Install dependencies from the lockfile, run migrations against the exact selected database, build, restart, and verify process/database/storage health. Keep the prior source and backup for rollback. Do not restore an older database dump over the only current copy of your books.
