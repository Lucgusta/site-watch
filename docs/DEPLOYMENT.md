# Deployment

The GitHub repository distributes the source. A live installation needs persistent PostgreSQL, an always-running API, **one always-running worker**, and HTTPS. GitHub Pages cannot supply these services. Do not put the worker into an intermittently suspended serverless request handler.

Resumo em português: use um servidor com banco persistente, HTTPS e API/worker contínuos. O repositório público não é a hospedagem do monitor. Os passos de instalação local estão no [README em português](../README.pt-BR.md).

## Local installation

Install Node 22 LTS (22.13+), npm 11.6+, and Docker with Compose v2. Run `npm ci`, `npm run setup`, then `docker compose up --build`. Visit http://localhost:3000. Local `.env` uses `NODE_ENV=development` so cookies work over local HTTP. Production configuration requires HTTPS and Secure cookies.

The supplied Compose stack binds API port 3000 and database port 55432 to loopback only. PostgreSQL uses a named persistent volume. A one-shot migration service completes before the API and worker start.

## Production on an existing host

1. Clone a reviewed revision and prepare `.env` using `npm run setup` or your secret manager. Never use the example placeholders as credentials.
2. Set `NODE_ENV=production` and `APP_ORIGIN=https://monitor.your-domain.example`, using the exact public origin without a path. Choose a strong unique administrator password. The session secret must have at least 32 characters.
3. Run `docker compose up -d --build` on the host. Keep PostgreSQL and the worker continuously active and preserve the Docker volume.
4. Point your domain to that host and configure an HTTPS reverse proxy to the loopback API port. An example Caddy configuration for an **existing** proxy installation is:

   ```caddyfile
   monitor.your-domain.example {
     reverse_proxy 127.0.0.1:3000
   }
   ```

5. Confirm `/api/health`, login/logout, one real public monitor, and fresh worker heartbeat. Close the browser and confirm new checks appear when you reopen it.
6. Restart API and worker, then verify the same monitors, checks and incidents are present. Test backup recovery before relying on stored history.

The proxy is responsible for public HTTPS. The API keeps `trustProxy=false`; incoming forwarding headers are not used to weaken authentication or origin checks. Login and request rate limits see the proxy IP, which is appropriate for this single-administrator installation. If you change proxy trust, restrict it to actual trusted proxy addresses and review rate limits.

Only the demo is public. Do not expose real monitors or recipient addresses anonymously. The demo does not let visitors submit URLs or execute arbitrary checks. Change administrator username/hash or `SESSION_SECRET` through your private environment configuration and recreate the services; rotating the session secret invalidates existing session tokens.

## Outbound network

The worker needs DNS and outgoing connections to public TCP ports 80/443. Email also needs the configured SMTP port. Add an outbound firewall that denies private, loopback, link-local, metadata, reserved and special-use network destinations, including IPv6 equivalents. If SMTP or your database is intentionally private, allow only that explicitly configured service through a separate rule.

Application checks reject nonpublic addresses and validate every A/AAAA answer before each connection and redirect. The selected public IP is pinned to the connection; hostname/SNI and certificate verification remain intact. There is no configuration flag to bypass SSRF or disable TLS validation. Conservative restrictions also reject IPv6 transition/tunnel targets. See [architecture](ARCHITECTURE.md#outbound-request-safety).

## Email

SMTP is optional. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, and optionally `SMTP_USER`/`SMTP_PASSWORD`. `SMTP_FROM` is a plain validated email address. STARTTLS is required when `SMTP_SECURE=false`; for implicit TLS normally use port 465 and `SMTP_SECURE=true`. Certificate verification stays enabled.

Each monitor independently chooses its optional recipient. Empty recipient means no queued email for that monitor. The dashboard shows whether SMTP is configured; it does not assert that credentials or provider delivery have been verified.

Incident and recovery messages are recorded in a durable outbox in the same transaction as the corresponding incident transition. There is one row per incident/event kind. The worker processes pending messages in bounded batches, with retry delays starting at one minute and doubling. After five failed attempts the message is marked abandoned and appears in the authenticated notification diagnostics endpoint `/api/notifications`. Monitoring results and incidents are unaffected by SMTP failure.

Delivery is **at least once**, not exactly once: if SMTP accepts a message and the worker crashes before recording `sentAt`, the retry may deliver a duplicate. SMTP acceptance also does not prove inbox delivery. Monitor your provider's bounce/spam reports. No real recipient or SMTP account is included in the public project.

If a recipient is configured while SMTP is off, events remain queued until SMTP is enabled. Previously queued events keep their original recipient; changing a monitor's email affects future events. Back up the database with care because queued messages contain recipient addresses.

## Backups and updates

Back up PostgreSQL, not just the code. The following local Compose example uses the generated default database/user. It avoids piping binary backups through older PowerShell versions:

```bash
docker compose exec -T db pg_dump -U sitewatch -d sitewatch -Fc -f /tmp/sitewatch-backup.dump
docker compose cp db:/tmp/sitewatch-backup.dump .runtime/sitewatch-backup.dump
```

Keep encrypted off-host copies and test restoration into a separate database. Never commit backups. If you changed `POSTGRES_USER`/`POSTGRES_DB`, use those configured names instead. Retain your private configuration securely alongside the database recovery procedure.

For an update, back up the database, pull a reviewed revision, then run `docker compose up -d --build`. Versioned migrations run before the services restart. Review schema changes before upgrades; do not reset the production database to fix a migration issue. `docker compose stop` preserves the volume. Removing `site_watch_data` deletes the database.

## Operational checks

| Symptom | Check next |
| --- | --- |
| Dashboard says worker is stale | `docker compose ps` and `docker compose logs --tail=100 worker`; check database connectivity and that only one worker runs. |
| Site result is stale but API responds | The worker may be stopped; this is an observation gap, not evidence of downtime. |
| DNS/TLS/connection failure | Inspect the monitor's error category and recent checks; compare domain/certificate/deployment changes. |
| Login returns 403 | Ensure browser origin equals `APP_ORIGIN` exactly, including scheme and port. |
| SMTP configured but no email | Verify the recipient, provider credentials/TLS and `/api/notifications`; an incident needs two consecutive failed observations. |
| Database cannot bind locally | Change `POSTGRES_PORT` and the local `DATABASE_URL`; keep container port 5432. |
| A second worker exits | The database singleton lock is held by the existing worker; do not scale worker replicas above one. |

Raw checks are cleaned incrementally after 30 days, while incident and notification history is preserved. For long-running installations plan backups and storage monitoring for that preserved history. When checks are overdue after restart, scheduling is spread over a short window rather than replaying every missed interval.

## Reference documentation

- [Node.js release support](https://nodejs.org/en/about/previous-releases)
- [Fastify LTS policy](https://fastify.dev/docs/latest/Reference/LTS/)
- [Prisma PostgreSQL configuration](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)
- [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Nodemailer SMTP/TLS options](https://nodemailer.com/smtp)
- [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

Prisma 7 is deliberately pinned to a stable release rather than Prisma 8 release candidates. The npm lockfile records actual dependency versions. Overrides for `deepmerge-ts`, `mysql2` and `shell-quote` use corrected transitive versions; Prisma generation/migrations and development commands must continue to be checked when updating them.
