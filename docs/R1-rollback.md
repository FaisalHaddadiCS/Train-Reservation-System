# R1 change review and rollback

The baseline before the R1 contingency change is commit `6b9139f5b7ef30248d4d67ae9d38c6b5d63fb068`, preserved by Git tag `before-r1-mitigation-2026-10-14`.

The implementation is submitted on branch `risk/r1-database-fallback`. It does not require any database schema, policy, grant or seed changes. The snapshot is stored in server memory and expires after five minutes; restarting the process clears it. Existing database connectivity and permissions are still required for live reads and bookings.

To inspect or run the old version from a clean checkout:

```bash
git fetch origin --tags
git switch --detach before-r1-mitigation-2026-10-14
```

Return to the implementation branch with:

```bash
git switch risk/r1-database-fallback
```

Before switching, commit or stash any new local work; do not discard it. Stop the application process before switching versions and restart it afterward. Existing `node_modules` are compatible because dependencies and the lockfile were not changed.

If the pull request is later merged and needs to be undone, use GitHub's Revert action on the merged pull request to propose a revert PR, or use `git revert` on the actual integration commit according to the merge method. This preserves history and later work. Do not force-push or reset `main` to the baseline tag.
