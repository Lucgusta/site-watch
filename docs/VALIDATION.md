# Validation record

Validated locally on **6 October 2026 (America/Sao_Paulo)**. This records observed results for the initial release; the GitHub Actions badge/run is the current automated result for later revisions.

| Check | Result |
| --- | --- |
| ESLint | Passed, no warnings. |
| TypeScript | Passed for server and web workspaces. |
| Vitest with PostgreSQL enabled | 112 tests passed, including 15 real PostgreSQL integration cases. |
| Production build | Frontend and API/worker compiled. |
| Playwright browser tests | 2 passed: read-only demo, mobile layout at 390 px without document overflow, login, monitor creation with email left blank, persisted worker result, details, pause, and logout. |
| npm audit | No vulnerabilities reported for the locked dependencies at validation time. |
| Docker Compose | PostgreSQL 17, migrations, API/frontend, and a separate worker built and started; API and database health checks passed. |
| Real public HTTP measurement | `https://example.com` returned HTTP 200. The first observed response time was 109 ms. This is one observation from the local worker, not an uptime guarantee. |
| Collection without a browser | Further automatic observations were saved while no browser test was running. |
| Process restart | API/worker restart preserved the monitor and stored observations in PostgreSQL. |
| Worker interruption | After the freshness limit elapsed, the real monitor changed to `STALE`; worker freshness was stale and no website-failure incident was invented. The worker was then restarted. |
| Private configuration | Configured database/password/session secrets and ignored `.env`/`.runtime` files were excluded from the staged source. |

Incident confirmation/recovery and email retry behavior were tested with controlled transport/sender dependencies against real PostgreSQL. No actual SMTP provider or inbox delivery was configured during this validation.

The source is ready for a continuously running host with persistent PostgreSQL and HTTPS. A repository URL is not evidence of an internet deployment. See [deployment requirements](DEPLOYMENT.md) and [reproduction commands](TESTING.md).
