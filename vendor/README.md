# Local braces patch

This MIT fork starts from braces 3.0.3. `PROVENANCE.json` records the
upstream tarball integrity and GHSA-vfj7-8cjw-p6xm. It is a local mitigation,
not an upstream release. Iterative checks bound AST depth and traversal work
before recursive parsing helpers and walkers run; child cycles are rejected.

Normal upstream behavior is checked against 22 fixtures. Adversarial checks
cover nested and incomplete patterns, supplied ASTs, cycles, and work limits.
`npm run security:dependencies` also checks the installed source bytes before
auditing the rest of the dependency tree.

The root dependency and override use the checked-in tarball so `npm ci`
installs a regular package with its dependencies. After changing this fork,
bump its version, update the root tarball filename and the verifier's expected
version, then regenerate the package and lockfile:

```sh
npm pack ./vendor/braces --ignore-scripts --pack-destination vendor
npm install --ignore-scripts
npm run security:patches
```

Include both the source changes and regenerated tarball/lockfile. After
upstream publishes a fix, compare its behavior before retiring this fork.
