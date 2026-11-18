# Release

The package is `@jtpio/autocast` on npm. The unscoped name `autocast` belongs to another
package. The command and the skill keep the name `autocast`.

## One-time setup

1. **First publication.** npm lets you add a trusted publisher only in the settings of a package
   that exists. So publish the first version from your machine:

   ```sh
   npm ci
   npm publish
   ```

2. **Trusted publisher.** On npmjs.com, open the package, then Settings, then Trusted
   publisher, and add GitHub Actions with owner `jtpio`, repository `autocast` and workflow
   `release.yml`. After this, the workflow publishes without a token.
3. **Public repository.** npm adds provenance only for a public repository, and
   `npx skills add jtpio/autocast` needs one too.

## Make a release

1. Check that the CI workflow is green on the default branch.
2. Set the version. This changes `package.json`, makes a commit and makes the tag `vX.Y.Z`:

   ```sh
   npm version patch   # or minor, or major
   ```

3. Push the commit and the tag:

   ```sh
   git push --follow-tags
   ```

The Release workflow (`.github/workflows/release.yml`) then checks that the tag matches the
version, builds the package, publishes it to npm, and creates the GitHub release with
generated notes.

## The skill

The skill is the directory `skills/autocast`. `npx skills add jtpio/autocast` reads it from the
default branch, so it has no release step: a push to the default branch updates it. The skill
is also part of the npm package.

## Checks

- `npm pack --dry-run` lists the files that go into the package.
- `npm test` needs Chromium (`npx playwright install chromium`) and `ffmpeg`. The JupyterLab
  test runs only when a server answers on port 8888.
- CI does not run on tags. Tag only a commit that CI has checked.

## If a release fails

- **The tag does not match the version.** Delete the tag, correct it, and push again.
- **npm refuses the version.** A version can be published only once. Make a new patch version.
- **The publish step has no permission.** Check the trusted publisher settings on npmjs.com:
  the workflow file name must be `release.yml`.
