# Security

A full security review of the codebase was conducted covering code-level vulnerabilities, native module handling, and supply chain risks. Here is what was checked and what was found.

**Checks performed:**
- Command/shell injection in PTY spawn, shell path handling, and ZIP extraction
- Path traversal in file operations
- Input validation at all user-facing and URI-handler boundaries
- Integrity verification of downloaded native binaries
- XSS and prototype pollution in the Obsidian UI layer
- Hardcoded secrets, sensitive data in logs, and dynamic code execution
- GitHub Actions workflow supply chain (trigger conditions, action pinning)
- npm dependency audit for known CVEs

**No issues found in:**
- Shell command construction (all paths fed into `execSync` are system-controlled, not user-supplied)
- Claude session resume commands (UUID-validated before PTY write)
- Obsidian UI rendering (no `innerHTML` or `eval` usage)
- Hardcoded credentials or tokens

**Binary download integrity:**

When the plugin downloads native `node-pty` binaries from GitHub Releases, it verifies their SHA-256 checksum against a `checksums.json` file published alongside the release. Checksum verification is mandatory - if `checksums.json` is unreachable or does not contain an entry for the downloaded asset, the installation is aborted.

SHA-256 checksums for each release are also published in `checksums.json` attached to every [GitHub Release](https://github.com/dannyshmueli/obsidian-hermes-console/releases) for manual verification.
