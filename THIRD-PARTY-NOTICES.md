# Third-party notices

Banyan's first-party ELv2 license does not replace dependency licenses.

## Locked dependencies

[DEPENDENCIES.json](docs/DEPENDENCIES.json) inventories every non-root package entry in the lockfile, including development and optional platform packages. The dependency tarballs are downloaded by `npm ci`; `node_modules` is not in the release ZIP. Preserve the licenses delivered with those packages when redistributing an installed or built application.

[NOTICES/dependencies](NOTICES/dependencies) contains license, copyright and notice files available in this qualification host's installed dependency roots. The machine-readable inventory links each copied file. Packages unavailable for this platform may have no copied notice here; consult their resolved package archive. Unspecified license metadata must not be interpreted as permission to relicense.

Notable runtime dependencies include Next.js, React, Drizzle ORM, postgres.js, Zod, PDFKit, pdf-lib, Sharp, ExcelJS, Nodemailer, Stripe, SimpleWebAuthn and the MCP SDK. Their individual package licenses apply.

## Vendored patch

`vendor/braces` and `vendor/figtree-braces-3.0.3-figtree.1.tgz` preserve the pinned braces compatibility/security patch and its MIT license in [vendor/braces/LICENSE](vendor/braces/LICENSE). The legacy filename is part of the lockfile contract.

## Fonts

The application requests Inter, Source Serif 4 and Geist Mono through `next/font/google`. Font files are fetched at build time and self-hosted in the built application. They remain under SIL Open Font License 1.1. Full upstream copyright/license texts are included in [Inter](NOTICES/fonts/inter/OFL.txt), [Source Serif 4](NOTICES/fonts/sourceserif4/OFL.txt) and [Geist Mono](NOTICES/fonts/geistmono/OFL.txt), with source hashes in [FONT-NOTICES.json](docs/FONT-NOTICES.json). No font binaries are shipped in this source archive.

## External data and services

FX workflows use Bank of Canada Valet data. Review the [Bank of Canada terms](https://www.bankofcanada.ca/terms/) and [Valet documentation](https://www.bankofcanada.ca/valet/docs/). The source package's synthetic fixtures are not a bundled production rate database. Third-party services are not covered by the application's first-party license.
