# Release

The package, the command, the skill and the repository are named `autokast`. The name
`autocast` belongs to another package on npm.

## One-time setup

1. **Trusted publisher.** On npmjs.com, open the package, then Settings, then Trusted
   publisher, and add GitHub Actions with owner `jtpio`, repository `autokast` and workflow
   `release.yml`. After this, the workflow publishes without a token.
2. **Publishing access.** In the same settings, select "Require two-factor authentication and
   disallow tokens". Then only the workflow can publish.
3. **Public repository.** npm adds provenance only for a public repository, and
   `npx skills add jtpio/autokast` needs one too.

## Make a release

1. Check that the CI workflow is green on the default branch.
2. On GitHub, open Actions, then Release, then "Run workflow". Keep the branch `main` and give
   the version: `patch`, `minor`, `major`, or an exact version such as `0.1.0`.

The Release workflow (`.github/workflows/release.yml`) then sets the version in `package.json`,
builds the package, publishes it to npm, pushes the version commit and the tag `vX.Y.Z`, and
creates the GitHub release with generated notes.

A version with a hyphen, such as `0.2.0-rc.0`, goes to the npm dist-tag `next` and becomes a
GitHub prerelease.

## The skill

The skill is the directory `skills/autokast`. `npx skills add jtpio/autokast` reads it from the
default branch, so it has no release step: a push to the default branch updates it. The skill
is also part of the npm package.

## Checks

- `npm pack --dry-run` lists the files that go into the package.
- `npm test` needs Chromium (`npx playwright install chromium`) and `ffmpeg`. The JupyterLab
  test runs only when a server answers on port 8888.
- The Release workflow does not run the tests. Release only a commit that CI has checked.

## If a release fails

- **A step before the push fails.** The repository did not change. Correct the cause and run
  the workflow again.
- **npm refuses the version.** A version can be published only once. Run the workflow again
  with a new version.
- **The publish step has no permission.** Check the trusted publisher settings on npmjs.com:
  the workflow file name must be `release.yml`.
- **The push is refused.** The branch got a new commit during the release, or the tag exists.
  The workflow checks this immediately before the publication, so nothing was published.
