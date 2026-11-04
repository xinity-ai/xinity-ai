# Verifying releases

Every release is signed by the release workflow of the xinity repository, using [Sigstore](https://www.sigstore.dev/) keyless signing. There is no long-lived signing key to leak. A signature proves that a file came out of that workflow on the `main` branch, and Sigstore's public transparency log records every signature it issues.

Two things are signed:

- **`SHASUMS256.txt`**, the list of SHA-256 checksums of every release asset: the CLI and service binaries, the bundles, the database migrations, the install scripts and the SBOM. A valid signature on this list together with a matching checksum proves a file is genuine.
- **Container images** on `ghcr.io/xinity-ai`, signed by digest.

The signer is identified by:

| | |
|---|---|
| Identity | `https://github.com/xinity-ai/xinity-ai/.github/workflows/release.yml@refs/heads/main` |
| Issuer | `https://token.actions.githubusercontent.com` |

## What the CLI checks

`xinity up` and `xinity update` verify the signature of `SHASUMS256.txt` before they use any checksum from it, then compare the downloaded file against its checksum. They stop if the signature is missing or invalid, if a checksum is missing, or if a file does not match. Older releases that were published without a signature are still installed after the checksum check, with a warning.

When installing on a remote host with `--target-host`, the signature is verified on the machine running the CLI, and the remote host checks the downloaded file against the verified checksums.

Verifying needs Sigstore's trust data. The CLI updates it from Sigstore when it can reach the internet and keeps a copy in `~/.cache/xinity/sigstore` (`%LOCALAPPDATA%\xinity\sigstore` on Windows). Without a connection it uses that copy, and without a copy it uses the one built into the CLI, so verification also works on air-gapped machines. Both fallbacks print a warning. Falling back never weakens the check: older trust data can only fail to recognise new Sigstore keys, never accept a forged signature.

If you point the CLI at a fork with `xinity configure githubProjectUrl`, it expects releases signed by that fork's release workflow.

## What the install scripts check

`install.sh` and `install.ps1` compare the downloaded CLI against `SHASUMS256.txt` and refuse to install if the list cannot be fetched, the CLI is not listed or the checksum does not match. They do not verify the signature, because that would require cosign on a machine that has nothing installed yet. Once installed, the CLI verifies every further download itself.

To verify the CLI archive by hand before installing it, use the commands below.

## Verifying by hand

You need [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3 or later. Replace `<version>` with the GitHub release tag, for example `v0.27.0`. Replace `<image-tag>` with the container image tag, which is that version without the leading `v`, for example `0.27.0`.

Checksums and downloaded files:

```bash
base="https://github.com/xinity-ai/xinity-ai/releases/download/<version>"
curl -fSLO "$base/SHASUMS256.txt"
curl -fSLO "$base/SHASUMS256.txt.sigstore.json"
cosign verify-blob SHASUMS256.txt \
  --bundle SHASUMS256.txt.sigstore.json \
  --certificate-identity "https://github.com/xinity-ai/xinity-ai/.github/workflows/release.yml@refs/heads/main" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum -c SHASUMS256.txt --ignore-missing
```

On macOS, use `shasum -a 256 -c SHASUMS256.txt --ignore-missing` for the last step.

Container images:

```bash
cosign verify ghcr.io/xinity-ai/xinity-ai-gateway:<image-tag> \
  --certificate-identity "https://github.com/xinity-ai/xinity-ai/.github/workflows/release.yml@refs/heads/main" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Image signatures use the format of cosign 3. Tools that read the older cosign format, such as the signature policies of podman and skopeo, do not see them.

## Build provenance

The signature shows that `release.yml` on `main` published a checksum list or an image. Provenance shows which commit and which build produced the bytes. Every file listed in `SHASUMS256.txt`, and each container image digest, has [SLSA](https://slsa.dev/) Build Level 3 provenance. GitHub stores the attestations. They are not uploaded to GHCR.

The build and the attestations run in `.github/workflows/release-build.yml`, which `release.yml` calls. Pinning that workflow is what makes the check Build Level 3. A check without `--signer-workflow` only reaches Build Level 2: it shows the file came from this repository, not that this build workflow produced it.

You need the [GitHub CLI](https://cli.github.com/). Verify a file named in `SHASUMS256.txt`, such as a binary archive, a bundle, or `sbom.cdx.json`. The checksum list and `SHASUMS256.txt.sigstore.json` are not themselves provenance subjects; the Cosign signature covers the list. One statement covers every listed file, so verifying any one of them checks that statement. The same signer workflow covers every image.

`<tag>` is the GitHub release tag, the same value as `<version>` above, for example `v0.27.0`. `<image-tag>` is the container image tag on GHCR, for example `0.27.0`.

```bash
gh attestation verify xinity-cli-linux-x64.tar.gz \
  --repo xinity-ai/xinity-ai \
  --signer-workflow xinity-ai/xinity-ai/.github/workflows/release-build.yml
```

```bash
gh attestation verify oci://ghcr.io/xinity-ai/xinity-ai-gateway:<image-tag> \
  --repo xinity-ai/xinity-ai \
  --signer-workflow xinity-ai/xinity-ai/.github/workflows/release-build.yml
```

Repeat the image command for `xinity-ai-dashboard`, `xinity-infoserver`, and `xinity-tether`. `xinity up` and `xinity update` do not run this check. They still verify only the Cosign signature on `SHASUMS256.txt` and the checksums.

Releases published before provenance was added still have signatures and checksums. `gh attestation verify` fails for those files. That is not a failed signature check.

### The commit the provenance names

A release is dispatched on a commit of `main`, and the binaries and images are built from that commit. The workflow then adds one commit on top of it, containing only the version bump, the changelog, and `nix/release.json`, and tags that commit. The provenance names the commit that was built: the parent of the tag, not the tagged commit.

The fetch refspec writes that GitHub release tag into `refs/tags/<tag>` locally. `git rev-parse "<tag>^"` prints the parent of the commit the tag points at. That parent is the commit named in the provenance.

```bash
git fetch origin "refs/tags/<tag>:refs/tags/<tag>"
git rev-parse "<tag>^"
```

Compare that SHA with the source revision from `gh attestation verify --format json`. They are the same commit. The tagged commit's tree is that parent plus the version bump, so a rebuild from the tag that does not apply the same version bump will not reproduce the binaries. The workflow ref in the provenance is `refs/heads/main`, because the release is dispatched on `main`. It is not `refs/tags/<tag>`.

## Software bill of materials

Every release lists the third-party components it is built from in `sbom.cdx.json`, a [CycloneDX](https://cyclonedx.org/) SBOM with name, version, license and package URL for each component. It covers every binary with the npm packages compiled into it and the Bun runtime it embeds, and every container image, identified by digest, with the Debian packages of both architectures and the binary it runs. Its dependency graph records which binary or image contains which package. The binaries hide their dependencies from scanners such as Trivy or Grype, so this file is the record of what is inside. It is listed in `SHASUMS256.txt`, so the signature and checksum checks cover it, and the release-file provenance includes it.

## When verification fails

**`Could not fetch SHASUMS256.txt`** from an install script means the checksum list could not be downloaded. Check that the release exists and that GitHub is reachable, then retry.

**`... is not listed in SHASUMS256.txt`** or **`has no SHASUMS256.txt.sigstore.json`** means the release is incomplete. Do not install it. Pick another release, with `--target-version` for the CLI or `--version` (`-Version` on Windows) for the install scripts.

**`Signature of SHASUMS256.txt is invalid`** or **`SHA256 mismatch`** means a file does not match what the release workflow published. It was altered or damaged on the way. Do not install it. Retry the download, and if the error persists, report it to security@xinity.ai.

**`gh attestation verify` fails**, or the signer workflow is not `release-build.yml`, means the file was not produced by that build. Do not install it. For a release that predates provenance, use the signature and checksum checks on this page instead. If a current release fails, report it to security@xinity.ai.
