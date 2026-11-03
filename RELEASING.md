# Releasing Thinai

Thinai uses one shared version number per release train:

| Artifact | Source version | Published version |
| --- | --- | --- |
| `thinai-language`, `thinai-cli` | `0.1.N-alpha.N` | Same version, published under npm tag `alpha`; `latest` is moved only intentionally |
| VS Code extension source / Open VSX | `0.1.N-alpha.N` | Open VSX keeps the source version |
| VS Code Marketplace | — | `0.1.N` marked pre-release |

Marketplace versions are `major.minor.patch` only. The GitHub workflow removes
the semver pre-release suffix and publishes with `--pre-release`. For example,
source `0.1.5-alpha.5` is published to Marketplace as **`0.1.5` pre-release**,
while npm and Open VSX keep `0.1.5-alpha.5`.

The alpha counter is shared by npm, the extension source, Open VSX, and release
notes. The Marketplace base version advances with every extension publish
because Marketplace versions are immutable and only accept
`major.minor.patch`. The current `0.1.4-alpha.1` extension release predates this
policy; from `0.1.5` onward the extension source suffix tracks the shared alpha
number.

## Publishing workflows

- `.github/workflows/publish-npm.yml`
  - Trigger: `npm-v*` tag or manual dispatch.
  - Uses npm trusted publishing through GitHub OIDC; no npm token is stored in
    the repository.
  - Builds and tests, packs both packages once, publishes `thinai-language`
    before `thinai-cli`, then verifies both versions.
  - Manual dispatch supports a `dry_run` input to validate build, packaging, and
    version checks without publishing.
- `.github/workflows/publish-extension.yml`
  - Trigger: `v*` tag or manual dispatch.
  - Uses `@vscode/vsce publish --oidc`; no Marketplace PAT is stored.
  - Verifies that the tag matches the extension source version.
  - Manual dispatch supports a `dry_run` input to build and test without publishing.
- `.github/workflows/publish-openvsx.yml`
  - Manual dispatch; enter `publish` to confirm.
  - Requires the `openvsx` GitHub environment and an `OVSX_PAT` secret.
  - Pre-release versions are marked at package time
    (`vsce package --pre-release`). The `ovsx publish --pre-release` flag is
    ignored for an already-packaged VSIX.
- Documentation deploys separately from `thinai-lang.github.io` on `main`.

## One-time setup

1. **npm trusted publishing**
   - Configure a trusted publisher for both `thinai-language` and `thinai-cli`
     on npmjs.com.
   - Repository: `thinai-lang/thinai`
   - Workflow: `publish-npm.yml`
   - Environment: leave empty unless the workflow is changed to use one.
2. **Marketplace**
   - The existing OIDC publisher workflow is already configured.
   - No local `vsce login` or publisher PAT is needed.
3. **Open VSX**
   - The `thinai-lang` namespace claim is complete
     (`EclipseFdn/open-vsx.org#14952`).
   - The `openvsx` GitHub environment and the `OVSX_PAT` environment secret are
     configured.
   - Required reviewers are not available for private repositories below GitHub
     Enterprise, so the environment has no protection rule. The manual dispatch
     plus the `confirm=publish` input is the intended gate.

## Release steps

1. Prepare the release on `main`:
   - advance the npm package versions and the CLI `thinai-language` dependency;
   - advance the extension version and changelog;
   - update the alpha notes and any version-specific documentation;
   - run `npm ci`, `npm run build`, and `npm test`.
2. Create both tags on the same commit:

   ```bash
   git tag v0.1.5-alpha.5
   git tag npm-v0.1.5-alpha.5
   git push origin v0.1.5-alpha.5 npm-v0.1.5-alpha.5
   ```

3. Watch the workflows:

   ```bash
   gh run list -R thinai-lang/thinai --workflow publish-extension.yml
   gh run list -R thinai-lang/thinai --workflow publish-npm.yml
   ```

4. Verify the published artifacts:

   ```bash
   npm view thinai-language@0.1.5-alpha.5 version
   npm view thinai-cli@0.1.5-alpha.5 version
   npx @vscode/vsce show thinai-lang.vscode-thinai --json
   curl -s https://open-vsx.org/api/thinai-lang/vscode-thinai/pre-release \
     | jq '{version, preRelease, verified}'
   ```

5. Publish to Open VSX from the release tag, so the extension payload matches
   npm and Marketplace:

   - GitHub Actions → **Publish to Open VSX** → **Run workflow**
   - Choose the release tag as the ref, enter `publish`, and run.
   - Dispatch on the tag, not on `main`: the tag and `main` may differ by
     documentation or CI commits.

   ```bash
   gh workflow run publish-openvsx.yml -R thinai-lang/thinai \
     --ref v0.1.5-alpha.5 -f confirm=publish
   ```

## Retrying

- If npm language succeeds and CLI fails, fix the cause and rerun only the npm
  workflow. npm versions cannot be overwritten, so advance the version rather
  than retrying the same version.
- If Marketplace fails, rerun the Marketplace workflow with
  `workflow_dispatch`; it will rebuild from `main`.
- Open VSX versions are immutable. Deleting a version does **not** free the
  version number: the identity stays reserved and the same version cannot be
  republished. Only an Open VSX administrator can purge it. If a version must
  be replaced, prefer advancing the version; use a purge request only when the
  release train requires the same number.
- Do not publish from a developer machine for a normal release. Local publishing
  is reserved for emergency recovery and requires the appropriate credentials.
