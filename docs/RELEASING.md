# Releasing Coding Tokens

Coding Tokens ships desktop installers and standalone CLI binaries for macOS, Windows, and Linux from every `v*` tag. macOS builds are automatically signed and notarized when Apple signing secrets are configured, and fall back to unsigned builds when they are not yet set. This guide covers Apple certificate setup, the signing helper script, GitHub secrets, the platform matrix, local signed builds, and the release checklist.

## What you need to do

The workflows are already committed. To enable signed and notarized macOS releases:

1. Create a **Developer ID Application** certificate and export the certificate plus its private key as a `.p12` file. See section 1, or run `bun run setup:signing` on macOS to generate a CSR and guide the upload.
2. Create an app-specific password for your Apple ID. See section 1.
3. Add the seven repository secrets listed in section 2 (for example with `gh secret set`).
4. Push a `v*` tag. The matrix builds macOS arm64, macOS x64, Windows x64, and Linux x64 desktop installers plus standalone CLI binaries, then publishes one GitHub Release with checksums.

If the Apple signing secrets are absent, the workflow emits a warning and produces unsigned macOS installers so multi-platform releases can still proceed while credentials are being prepared.

The pipeline is:

1. `bun run release <version>` bumps `package.json` and folds the changelog.
2. You commit, tag `v<version>` and push the tag.
3. GitHub Actions verifies the source, then builds on native runners:
   `macos-15` (arm64), `macos-15-intel` (x64), `ubuntu-24.04` and
   `windows-2025`.
4. The macOS jobs import the Developer ID certificate, sign, notarize, staple
   and verify the app and DMG.
5. A final job downloads all platform artifacts, writes `SHA256SUMS.txt`, and
   publishes a GitHub Release.

## 1. One-time Apple setup

You need an active [Apple Developer Program](https://developer.apple.com/programs/)
membership and the Account Holder or Admin role.

### Developer ID Application certificate

1. Open **Keychain Access → Certificate Assistant → Request a Certificate From
   a Certificate Authority**, save the CSR to disk.
2. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates),
   create a **Developer ID Application** certificate with that CSR.
   This is the certificate for distributing outside the App Store — not
   _Apple Development_ and not _Developer ID Installer_.
3. Download and double-click the `.cer` so it lands in your login keychain.
4. In Keychain Access, expand the certificate, select **both** the certificate
   and its private key, then **Export 2 items…** as `DeveloperID.p12` with a
   strong password.
5. Confirm the identity is visible:

   ```sh
   security find-identity -v -p codesigning
   # "Developer ID Application: Your Name (TEAMID)"
   ```

Note the 10-character **Team ID** from
[Membership details](https://developer.apple.com/account/#/membership).

### Notarization credentials

Pick one. Apple ID is simpler; an App Store Connect API key is more robust for
CI and does not expire with a password change.

**Apple ID (default in this repo)**

1. Go to [appleid.apple.com](https://appleid.apple.com) → **Sign-In and
   Security → App-Specific Passwords**.
2. Generate one for "Coding Tokens CI" and copy the `xxxx-xxxx-xxxx-xxxx` value.
   Use this, not your Apple ID password.

**App Store Connect API key (alternative)**

Create a key under **Users and Access → Integrations → App Store Connect API**
with the _Developer_ role, download the `.p8` once, and note the Key ID and
Issuer ID. The build then needs:

```sh
export ELECTROBUN_APPLEAPIKEY="<key id>"
export ELECTROBUN_APPLEAPIISSUER="<issuer uuid>"
export ELECTROBUN_APPLEAPIKEYPATH="/path/to/AuthKey_XXXX.p8"
```

The release workflow uses the Apple ID variables; swap them in
`.github/workflows/release.yml` if you prefer the API key.

## 2. GitHub secrets

Add these under **Settings → Secrets and variables → Actions → New repository
secret**:

| Secret                        | Value                                                 |
| ----------------------------- | ----------------------------------------------------- |
| `MACOS_CERT_P12`              | `base64 -i DeveloperID.p12` output, one line          |
| `MACOS_CERT_PASSWORD`         | Password chosen when exporting the `.p12`             |
| `MACOS_KEYCHAIN_PASSWORD`     | Any random string; used for the temporary CI keychain |
| `MACOS_DEVELOPER_ID`          | `Developer ID Application: Your Name (TEAMID)`        |
| `APPLE_TEAM_ID`               | 10-character Team ID                                  |
| `APPLE_ID`                    | Apple ID email used for notarization                  |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from the step above             |

Create the base64 value without extra wrapping, or run `bun run setup:signing` to guide CSR generation and secret uploads:

```sh
base64 -i DeveloperID.p12 | tr -d '\n' | pbcopy
```

With the GitHub CLI (`gh`), you can set all seven secrets directly:

```sh
gh secret set MACOS_CERT_P12 < DeveloperID.p12.b64
gh secret set MACOS_CERT_PASSWORD
gh secret set MACOS_KEYCHAIN_PASSWORD
gh secret set MACOS_DEVELOPER_ID
gh secret set APPLE_TEAM_ID
gh secret set APPLE_ID
gh secret set APPLE_APP_SPECIFIC_PASSWORD
```

The certificate expires after five years; when it does, repeat step 1 and
replace `MACOS_CERT_P12` and `MACOS_CERT_PASSWORD`.

Windows and Linux builds do not use these secrets. Electrobun does not currently
sign Windows installers; add an Authenticode step in a `postPackage` build hook
if you later need it.

## 3. Platform matrix

Every release tag builds on native runners. Electrobun does not cross-compile,
so each row must run on its own runner.

| Runner           | Platform    | Installer artifact                    | Updater artifact                              | CLI binary                      |
| ---------------- | ----------- | ------------------------------------- | --------------------------------------------- | ------------------------------- |
| `macos-15`       | macOS arm64 | `macos-arm64-CodingTokens.dmg`        | `stable-macos-arm64-CodingTokens.app.tar.zst` | `coding-tokens-cli-macos-arm64` |
| `macos-15-intel` | macOS x64   | `macos-x64-CodingTokens.dmg`          | `stable-macos-x64-CodingTokens.app.tar.zst`   | `coding-tokens-cli-macos-x64`   |
| `windows-2025`   | Windows x64 | `win-x64-CodingTokens-Setup.zip`      | `stable-win-x64-CodingTokens.tar.zst`         | `coding-tokens-cli-win-x64.exe` |
| `ubuntu-24.04`   | Linux x64   | `linux-x64-CodingTokens-Setup.tar.gz` | `stable-linux-x64-CodingTokens.tar.zst`       | `coding-tokens-cli-linux-x64`   |

Each row also emits `*-update.json`. All files are uploaded to the same release.
The update feed uses:

```text
https://github.com/OWNER/REPO/releases/latest/download
```

Keep releases marked **latest** (not draft or prerelease) or that URL breaks.

ARM64 Linux and Windows builds use the same commands on
`ubuntu-24.04-arm` and `windows-11-arm` runners. Add them to the `build` matrix
only after confirming those runners are available for the repository; otherwise
the release job will wait forever for an unavailable runner.

## 4. Local signed build

Useful before tagging, and for testing notarization:

```sh
export ELECTROBUN_DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)"
export ELECTROBUN_TEAMID="TEAMID"
export ELECTROBUN_APPLEID="you@example.com"
export ELECTROBUN_APPLEIDPASS="xxxx-xxxx-xxxx-xxxx"
export RELEASES_BASE_URL="https://github.com/OWNER/REPO/releases/latest/download"

CODESIGN=1 NOTARIZE=1 bun run build:app
```

Output lands in `build/stable-macos-arm64/` (or `stable-macos-x64/`) and
`artifacts/`:

| File                                                    | Purpose              |
| ------------------------------------------------------- | -------------------- |
| `artifacts/macos-arm64-CodingTokens.dmg`                | Human download       |
| `artifacts/stable-macos-arm64-CodingTokens.app.tar.zst` | In-app update bundle |
| `artifacts/stable-macos-arm64-update.json`              | Update manifest      |

`electrobun.config.ts` reads four environment switches:

| Variable            | Default | Meaning                                     |
| ------------------- | ------- | ------------------------------------------- |
| `CODESIGN`          | off     | Sign with `ELECTROBUN_DEVELOPER_ID`         |
| `NOTARIZE`          | off     | Notarize (implies `CODESIGN`)               |
| `CREATE_DMG`        | on      | Set `false` for a fast unsigned smoke build |
| `RELEASES_BASE_URL` | unset   | Baked into update metadata                  |

### Verify before uploading

```sh
APP="build/stable-macos-arm64/Coding Tokens.app"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier"
spctl -a -vvv -t exec "$APP"          # expect: accepted, source=Notarized Developer ID
xcrun stapler validate "$APP"
hdiutil attach -readonly artifacts/macos-arm64-CodingTokens.dmg
```

## 5. Release checklist

1. Make sure the changelog `## [Unreleased]` section describes the release.
2. Bump the version and open the resulting files for review:

   ```sh
   bun run release minor      # or major / patch / 1.2.3
   git diff package.json CHANGELOG.md
   ```

3. Run the local checks (CI repeats them):

   ```sh
   bun run check && bun run typecheck && bun test && bun run build
   ```

4. Commit, tag and push:

   ```sh
   git add -A
   git commit -m "chore(release): v0.3.0"
   git tag -a v0.3.0 -m "v0.3.0"
   git push origin main v0.3.0
   ```

5. Watch the **Release** workflow. It verifies that the tag matches
   `package.json`, builds signed and notarized macOS bundles when all seven Apple
   secrets are configured (or unsigned bundles otherwise), builds Windows/Linux
   installers and CLI binaries, and publishes the GitHub Release.

6. Sanity-check the published release: download the DMG on a machine that has
   never seen the app, install, launch, and confirm the version in the About
   panel. Smoke-test the Windows and Linux installers the same way.

## 6. Troubleshooting

| Symptom                                            | Fix                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `errSecInternalComponent` during `codesign`        | The CI keychain was not unlocked or lacks the partition list; re-run the import step                          |
| `notarytool` returns 401 / invalid credentials     | Use an **app-specific password**, not the Apple ID password; check `APPLE_TEAM_ID`                            |
| `spctl` says `source=Unnotarized Developer ID`     | Notarization was skipped or timed out; check the build log for the notarytool submission                      |
| `hdiutil: create failed - Directory not empty`     | The agent sandbox blocks disk images; run the build with full disk access or let CI build the DMG             |
| Gatekeeper still blocks after a successful release | The old rejection is cached; re-download or `xattr -dr com.apple.quarantine` the app                          |
| Update check finds nothing                         | The release must be the latest non-prerelease, and the asset names must match `stable-<os>-<arch>-*`          |
| Linux app fails to start                           | Install the runtime packages: `libgtk-3-0`, `libwebkit2gtk-4.1-0`, `libayatana-appindicator3-1`, `librsvg2-2` |
| Windows build waits forever                        | The requested ARM64 runner is not enabled for the repository; remove that matrix row                          |
