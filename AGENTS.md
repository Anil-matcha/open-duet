# Repository Agent Instructions

## Test workflow

- For a narrow change, run the smallest tests that cover the changed behavior first. Find test commands in the relevant package and CI workflow; avoid running the entire backend suite as the default local check.
- Run independent backend and frontend checks in parallel when they cover the same change. For a failure, rerun the specific failing test after fixing it.
- The full backend suite includes process, socket, and end-to-end tests and takes several minutes. Run it for broad backend changes, when requested, or as part of CI/release verification. Do not weaken or remove CI coverage to make local iteration faster.
- Use the backend SQLite and throwaway `TOKEN_ENCRYPTION_KEYS` values from `.github/workflows/ci.yml`; never use production credentials in tests.
- Some integration tests need process or localhost socket permissions that a restricted environment may deny. Treat those as environment failures, not product failures, and rerun them in an environment that supports them when the result matters.
- Report exactly which checks passed, skipped, failed, or were interrupted. An incomplete run is not a passing full suite.

## Local package instructions

- Read a package-level `AGENTS.md` before changing files in that package. For example, `frontend/AGENTS.md` contains the frontend-specific framework rules.
