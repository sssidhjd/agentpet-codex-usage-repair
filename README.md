# AgentPet Windows Codex usage repair

Unofficial source overlay for [AgentPet](https://github.com/ntd4996/agentpet),
based on the official Windows 0.1.8 commit
`78633a1e62e349bf55c9232a25475a5308476e6a`.
This is not an upstream release and the portable executable is not vendor-signed.

## Changes

- Prefer the exact hook `transcript_path`, validate its session metadata, and use
  the newest matching rollout only when no valid explicit path is available.
- Never match an unrelated session merely because it uses the same directory.
- Poll known active rollout files every 3 seconds, including delayed token events.
- Read cumulative `total_token_usage`, not repeated `last_token_usage` snapshots.
- Keep cache-excluded accounting: input minus cached input, plus output.
- Atomically save per-source high-water receipts with pet XP in `ap_care`.
  Re-delivery, restart, and switching pets do not replay previously accepted usage.
- Baseline pre-existing files on first use. Historic counts from the old reader
  are ambiguous and are not blindly replayed or subtracted.

The reader does not modify Codex logs, change hooks trust, or upload conversations.
Receipts stay local and are omitted from the existing web-profile sync payload.
No authentication, TLS, updater signature, or browser security controls are disabled.

## Cloud build

The workflow builds on a GitHub-hosted Windows runner; it does not install Rust or
Microsoft C++ tools on the user's computer. It checks out the pinned upstream source,
copies the six-file overlay, runs frontend and native regression tests, builds a
portable executable, and uploads a SHA-256 manifest with the artifact. It has only
read access to repository contents and does not publish an upstream release.

## Verification status

The local 7-case receipt test suite and TypeScript/Vite production build passed.
Native parser tests and the complete Windows application must still be built and
verified before installation. A successful workflow artifact means the automated
checks passed, not that desktop/cloud end-to-end testing has already been completed.

Before replacing an installation, close AgentPet normally and back up both the
original executable and the WebView save directory. Preserve the application
identifier and existing launcher/save/sync guards. Verify a real token increment,
desktop/web agreement, and two normal restarts without a duplicate increase.

## Compatibility limits

Codex transcript format is not a stable interface. Unknown or invalid usage events
are ignored rather than guessed. Resets/truncations with unchanged file identity
are handled conservatively to avoid inflating progress. Existing uncertain historical
totals are preserved; this patch is not a retroactive audit of all account usage.

MIT license; upstream attribution is retained in LICENSE.
