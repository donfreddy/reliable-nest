# Releasing

Three packages, released in lockstep for now (`@reliable/core`, `@reliable/postgres`, `@reliable/nest`): they are tightly coupled and share one release cadence at this stage. This may move to independent versioning (e.g. via [changesets](https://github.com/changesets/changesets)) once they stop changing together on every release.

## One-time setup, before the first publish ever

1. **Confirm you own the `@reliable` npm scope.** Check with `npm org ls reliable` once logged in, or by visiting `npmjs.com/settings/reliable/packages`. A scope that doesn't match your npm username has to exist as an npm **Organization** before you can publish under it (free for public packages, created at `npmjs.com/org/create`). This has not been verified from this environment: nothing has ever been published under `@reliable/*` (all three names 404 on the registry as of this writing), but that only means the names are free, not that the org exists yet.
2. **Log in**: `npm login` (or `npm adduser`), and enable 2FA on the account if it isn't already, since npm requires it for publishing.
3. **Enable GitHub Actions' npm token**, if you want CI to publish instead of doing it from a laptop: add an `NPM_TOKEN` repo secret (an npm "Automation" token) and a publish job to `.github/workflows/`. Not set up yet; every release so far is manual.

## Every release

1. **Land everything on `main` first.** Don't release from a branch.
2. **Decide the version bump** (semver: patch/minor/major) and set it in all three `packages/*/package.json` at once, since they release in lockstep. There is no automation for this yet: edit the three `"version"` fields by hand.
3. **Update `CHANGELOG.md`** with a new dated section for the version, following the existing format. Do this before tagging, not after: the changelog entry is part of what gets tagged.
4. **Build and verify from a clean state:**

   ```bash
   pnpm install
   pnpm -r build
   pnpm -r typecheck
   pnpm -r test
   ```

   All three must be green. `pnpm -r test` needs Docker running (Testcontainers spins up real Postgres instances).

5. **Dry-run every package before publishing anything for real:**

   ```bash
   pnpm --filter @reliable/core publish --dry-run
   pnpm --filter @reliable/postgres publish --dry-run
   pnpm --filter @reliable/nest publish --dry-run
   ```

   Read the tarball contents list in the output. Confirm `dist/` is populated and current (step 4), that `workspace:^` dependencies resolved to a real version range (`@reliable/postgres`'s dry-run should show `"@reliable/core": "^X.Y.Z"`, not `"workspace:^"`), and that nothing unexpected is in the package (stray `.env`, test fixtures, etc.).

6. **Publish for real, in dependency order** (`core` has no internal dependents to wait on; `postgres` depends on `core`; `nest` depends on both):

   ```bash
   pnpm --filter @reliable/core publish --access public
   pnpm --filter @reliable/postgres publish --access public
   pnpm --filter @reliable/nest publish --access public
   ```

   `--access public` is already set via each package's `publishConfig`, so it's a safety net here, not strictly required. Publishing out of order (e.g. `nest` before `postgres` is live) doesn't break the publish itself, since `workspace:^` was already resolved to a concrete range at pack time, but it does mean `npm install @reliable/nest` would briefly 404 on `@reliable/postgres` for anyone unlucky enough to try in that window.

7. **Tag and push:**

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

8. **Update the README** once the first publish ever succeeds: the "Not yet published to npm" line in the Quick Start section is only true until this point.

## If something goes wrong after publishing

npm allows `npm unpublish` only within 72 hours of publishing a given version, and only if no other package depends on it yet; after that, publish a new patch version instead. Never reuse a version number: once `0.1.0` exists on the registry, a fix ships as `0.1.1`, even if `0.1.0` is unpublished.
