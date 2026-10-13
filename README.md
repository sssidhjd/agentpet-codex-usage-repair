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
- Disable automatic and one-click in-place updates for this customized executable,
  because an upstream replacement would remove the reviewed local repairs. Future
  upgrades must be rebuilt from the repair overlay first.
- Complete the Simplified Chinese UI for Care, History, web-profile sync, stages,
  hunger, achievements, statistics, activity bubbles, reactive comments, tray
  status, integration notes, previews, and the locked-update status.
- Read the official Codex account total, daily activity, and current rate-limit
  window through the locally authenticated `codex app-server` protocol. Only a
  fixed allowlist of aggregate fields is exposed; account identity is discarded.
- Maintain an idempotent local SQLite shadow ledger over both active and archived
  Codex sessions. It tracks gross and cache-adjusted totals continuously without
  modifying transcripts, replaying usage, or awarding historical pet XP.

The reader does not modify Codex logs, change hooks trust, or upload conversations.
Receipts stay local and are omitted from the existing web-profile sync payload.
No authentication, TLS, updater signature, or browser security controls are disabled.

## Cloud build

The workflow builds on a GitHub-hosted Windows runner; it does not install Rust or
Microsoft C++ tools on the user's computer. It checks out the pinned upstream source,
copies the reviewed overlay, runs frontend and native regression tests, builds a
portable executable, and uploads a SHA-256 manifest with the artifact. It has only
read access to repository contents and does not publish an upstream release.

## Verification status

The local 7-case receipt test suite and TypeScript/Vite production build passed.
The cloud workflow additionally runs the account-protocol, ledger idempotency,
native parser, and resolver regression suites before producing the executable.
A successful workflow artifact means those automated checks passed, not that
desktop/cloud end-to-end testing has already been completed.

Before replacing an installation, close AgentPet normally and back up both the
original executable and the WebView save directory. Preserve the application
identifier and existing launcher/save/sync guards. Verify a real token increment,
desktop/web agreement, and two normal restarts without a duplicate increase.

## Compatibility limits

Codex transcript format is not a stable interface. Unknown or invalid usage events
are ignored rather than guessed. Resets/truncations with unchanged file identity
are handled conservatively to avoid inflating progress. Official account totals and
local transcript totals intentionally remain separate from XP-bearing usage.

MIT license; upstream attribution is retained in LICENSE.

