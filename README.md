# Site Watch

**Keep an eye on all your domains from one place.** A self-hosted HTTP monitor for freelancers, agencies, and anyone maintaining several websites.

[Português](README.pt-BR.md) · [Quick start](#quick-start) · [How it works](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Deployment](docs/DEPLOYMENT.md) · [Contributing](CONTRIBUTING.md)

![Site Watch dashboard displaying synthetic demonstration data](docs/screenshots/dashboard.png)

Site Watch helps answer practical questions: which domain needs attention, whether the problem is DNS, TLS, connectivity or HTTP, when a failure was confirmed, and whether a response has become slow. Monitoring runs on the server, even with the browser closed.

The source code is public under the MIT license. Each installation has **one administrator and up to 20 monitors**. The English interface includes a public, read-only demonstration with clearly identified synthetic data; real monitors and email addresses require login.

## Features

- Add, edit, pause, resume, and delete public HTTP/HTTPS monitors.
- Check every 1, 5, or 15 minutes, with configurable total timeout and slow-response threshold.
- Dashboard with search, status filters, worker freshness, response times, observed availability, and recent incidents.
- Details with response-time charts, recent checks, observation gaps, and failure/recovery history over 24 hours, 7 days, or 30 days.
- Optional email recipient per monitor: an email when the **second consecutive failure confirms an incident**, and another when a successful check observes recovery.
- PostgreSQL persistence, a separate worker, restart recovery, bounded concurrency, and durable email retries.
- Administrator authentication, expiring cookie sessions, CSRF protection, login throttling, and SSRF protection.
- UTC storage and selectable display timezone, initially `America/Sao_Paulo`.

## Quick start

Requirements: **Node.js 22 LTS, version 22.13 or later in that major**, npm 11.6+, and Docker Desktop or Docker Engine with Compose v2. No paid service is needed to run locally.

```bash
git clone https://github.com/Lucgusta/site-watch.git
cd site-watch
npm ci
npm run setup
docker compose up --build
```

Open **http://localhost:3000**. Explore the read-only demo, then sign in with the username and password you chose during setup. Add a public URL such as `https://example.com` and wait for the worker's first check.

`npm run setup` creates a private `.env` with a scrypt password hash and random database/session secrets. It refuses to overwrite existing configuration. For unattended setup, use `npm run setup -- --generate`; the random login is saved locally to `.runtime/initial-admin.txt`, which is excluded from Git. Store the password safely and remove that temporary credentials file.

Compose starts PostgreSQL, applies versioned migrations, serves the compiled frontend/API, and runs **one worker**. Data lives in the `site_watch_data` Docker volume. `docker compose stop` and `docker compose up -d` preserve it. Deleting the volume removes the stored data.

If ports conflict, change `POSTGRES_PORT` or `PORT` in `.env`. Keep the host part of `DATABASE_URL` aligned with `POSTGRES_PORT`, and update `APP_ORIGIN` when changing the website port. The database's container port remains 5432.

## Optional email alerts

Monitoring works without an email address. Leave **Notification email** blank to keep alerts in the dashboard.

To deliver email, configure your own SMTP provider in the private `.env`:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=monitor@example.com
```

Port 587 uses STARTTLS; use port 465 and `SMTP_SECURE=true` for TLS from connection start. Restart the API and worker after changing environment values: `docker compose up -d --force-recreate api worker`.

Fill in **Notification email** when adding or editing a monitor. The email identifies the monitor, URL, failure category, and observation timestamps. It reports confirmed incidents and recovery; repeated failures in an already-open incident do not produce another incident alert. Delivery is queued in the same transaction as the incident transition and retried by the worker. See [delivery guarantees and deployment](docs/DEPLOYMENT.md#email).

## Understand the measurements

| Measurement | Meaning |
| --- | --- |
| Response time | Time from starting the attempt until receiving the final HTTP response headers, including DNS, connection, TLS and redirects. The page body is discarded. |
| Observed availability | Successful HTTP checks / completed website checks × 100, with the sample count. Internal monitor errors and missing observations are excluded. |
| Average | Arithmetic mean of successful HTTP response times in the selected period. |
| p95 | Sorted successful response times at index `ceil(0.95 × n) - 1` (nearest rank). Always interpret it alongside the sample count. |
| Slow | A successful HTTP response exceeding the monitor's configured threshold; it still counts as HTTP success. |
| Stale data | No usable observation for more than two intervals plus the timeout, or an internal collection error. This does not establish website downtime. |

The first failed check is **Failure pending**. A second consecutive failure confirms an incident. The next successful check records observed recovery. These timestamps describe observations; the exact start or end between checks is unknown.

Successful HTTP means a final status between 200 and 299. It does **not validate checkout, login, JavaScript rendering, or all page resources**. Observed availability is a ratio of samples, not an SLA or exact percentage of time online. Without samples, metrics show no data. Charts preserve collection gaps. Raw checks are retained for 30 days; incident history survives raw-check cleanup.

## Development

```bash
npm ci
npm run setup                  # once; skip if .env already exists
docker compose up -d db
npm run db:generate
npm run db:migrate
npm run dev
```

The UI runs at http://localhost:5173 and proxies `/api` to port 3000. For development set `APP_ORIGIN=http://localhost:5173` in `.env`; restart the API after editing it. Browser mutations are checked against that origin.

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

[Testing guide](docs/TESTING.md) covers database integration tests, the Playwright login/create/details/pause flow, and deterministic DNS/HTTP/TLS fixtures. GitHub Actions runs lint, types, tests, build, database integration, and the browser flow against a dedicated test database.

See the [initial release validation record](docs/VALIDATION.md) for observed local results and the scope of the email and deployment checks.

## Project map

```text
apps/web/          React dashboard, forms, charts, and accessible English UI
apps/server/src/   Fastify API, authentication, secure transport, worker, email outbox
apps/server/prisma/  Schema and versioned PostgreSQL migrations
scripts/           Private setup, database tests, and guarded GitHub publication
docs/              Architecture, API, testing, deployment, screenshots
.github/           CI and contribution templates
```

Start with [the architecture walkthrough](docs/ARCHITECTURE.md) to follow one check from schedule to incident and email. The public demo is generated separately and never inserts synthetic results into the real database.

## Deployment and limits

Deploy on a host with persistent PostgreSQL, HTTPS, and continuously running API and worker processes. Use one worker instance; it executes at most three checks concurrently and prevents overlap per monitor. SSRF controls restrict targets to public HTTP/HTTPS on ports 80/443, validate all DNS answers at every redirect, and pin the validated address for the actual connection. Keep TLS validation enabled and add outbound network restrictions on production hosts.

**GitHub stores the code. GitHub Pages alone cannot run the API, PostgreSQL, SMTP queue, or worker.** Follow the [deployment guide](docs/DEPLOYMENT.md). Hosting the application is separate from publishing this repository; no public live deployment is implied by the repository URL.

## Roadmap

- Telegram alerts and certificate-expiry notices.
- Multiple administrators, teams, and a configurable monitor limit.
- Public status pages that reveal only explicitly selected data.
- Browser-based checks for login, checkout and rendering.
- Aggregated history beyond the 30-day raw-check retention.

See [contribution guidelines](CONTRIBUTING.md) and [security reporting](SECURITY.md). Licensed under [MIT](LICENSE).
