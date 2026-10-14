# Release Queue

Topic-branch commits awaiting review and operator deploy. `main` only moves via
the operator's `deploy-safe.sh`; never merge or force-move `main` from an agent
worktree. Add one row per topic-branch commit set.

| Date | Issue | Branch | Commit | Summary | Status |
| --- | --- | --- | --- | --- | --- |
| 2026-10-14 | TOP-599 | top-599-token-metering | 0f50bf00b | hermes_local token metering: read cumulative session usage from the Hermes session store (state.db) so prompt/completion tokens attribute to agent + provider in the cost ledger (usageBasis session_cumulative; stdout regex stays as fallback) | pending different-provider review |
