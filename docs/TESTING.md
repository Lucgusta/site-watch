# Testing

Use Node 22 LTS (22.13+) and npm 11.6+. After `npm ci`, generate the Prisma client with `npm run db:generate`. Tests use controlled clocks, DNS, HTTP responses and email senders; third-party site availability is not a test dependency.

Resumo em português: `npm run check` valida código, tipos, regras e build. Os testes de banco e navegador abaixo usam schemas isolados, com autenticação real e respostas HTTP controladas. Não use um banco de produção para testes.

## Rules, transport and build

```bash
npm run check
```

The transport suite covers 2xx and unexpected HTTP status, DNS, connection, TLS and total timeout errors, redirected targets, redirect limits, IPv4 encodings, IPv6/private/mapped addresses, mixed DNS answers, pinned connections, DNS rebinding and resource cancellation. Domain/configuration tests check metrics, no data, slow success, stale collection and required private configuration.

Database integration tests are skipped in `npm test` unless `RUN_DB_TESTS=true`; skipped tests are not reported as validated database behavior.

## Real PostgreSQL integration

Start the local database and create your private configuration first:

```bash
npm run setup                 # once only
docker compose up -d db
npm run db:generate
npm run test:db
```

`scripts/db-tests.mjs` loads the local `.env` if needed and enables real database tests. Set `TEST_DATABASE_URL` to use a separate dedicated PostgreSQL test server. Each run creates a random `sitewatch_test_...` schema, applies the actual checked-in SQL migration, and drops that exact schema during cleanup. It does not truncate the real `public` schema. The database account needs permission to create schemas. Avoid production databases even though the schemas are isolated.

Tests exercise real Fastify requests and PostgreSQL transactions: session cookies/expiry/logout, CSRF/origin, demo mutation rejection, optional email validation, the concurrent monitor cap, persistent manual queues, pause/resume, non-overlapping leases, worker singleton lock, atomic incident/recovery, internal-error exclusions, notification retries, SQL metrics/full-period charts, and retention preserving incidents.

The worker lock is database-wide. Stop a running local worker before integration/browser tests against the same database, or use a dedicated `TEST_DATABASE_URL`. GitHub Actions always uses its own PostgreSQL service.

## Browser flow and real screenshots

```bash
npm run build
npx playwright install chromium
npm run test:e2e
```

The dedicated harness `e2e/server.ts` serves the **actual built frontend** and real API, creates a random PostgreSQL schema, uses real administrator hashing/sessions/CSRF, and starts the actual worker scheduler with an injected controlled HTTP transport. It is separate from production entrypoints; there is no environment switch to disable SSRF or authentication.

Playwright verifies the public read-only demo, then logs in, adds a monitor with email omitted, observes the worker's persisted HTTP result, opens the details, pauses the monitor and signs out. Temporary test credentials are generated per run in ignored `.runtime/`; no fixed production password is provided.

The tests capture actual browser-rendered pages to `docs/screenshots/dashboard.png`, `mobile.png`, and `details.png`. The dashboard/mobile captures show labeled synthetic demo data. The details capture shows the controlled browser-test fixture, not a measurement of an external website. HTML reports and traces remain in ignored `playwright-report/` and `test-results/`.

## Manual deployment acceptance

After automated checks, verify the Compose stack with a real public URL you own or have permission to monitor:

1. Confirm the initial `No data` state becomes an actual recorded result.
2. Close the browser and confirm later checks still appear.
3. Restart the API and worker; confirm the monitor and history persist.
4. Use a controlled failing endpoint to observe first failure, confirmation after the second failure, and recovery on success.
5. Stop the worker; after two intervals plus timeout, verify the stale state. No extra site-failure incident should be invented during the missing collection period.
6. If you configure SMTP, test delivery to an address you control and confirm notification failure does not change site health.

No live SMTP inbox delivery is implied by passing tests with a controlled sender. Record deployment acceptance evidence separately from the deterministic CI suite.
