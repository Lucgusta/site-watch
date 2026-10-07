# API guide

The API and production dashboard share an origin. All responses use JSON except a successful deletion, which returns an empty body. Dates are ISO 8601 UTC strings; the browser handles display timezone. Examples below use placeholders and `https://example.com`, not a particular customer's domain.

[Architecture and rules](ARCHITECTURE.md) · [Setup](../README.md#quick-start) · [Português](../README.pt-BR.md)

## Authentication

The administrator is configured locally; there is no public default password or registration endpoint. Login returns a CSRF token and sets the `sitewatch_session` cookie. This cookie is `HttpOnly`, `SameSite=Strict`, valid for 12 hours, and `Secure` in production. Logout invalidates the stored session.

- Every mutation, including login, requires `Origin` equal to configured `APP_ORIGIN`.
- Real monitor, incident, and notification endpoints require the session cookie.
- Authenticated POST, PATCH, and DELETE requests additionally require `X-CSRF-Token` from login or `GET /api/session`.
- The demo endpoints are public and accept reads only. They never initiate a check or send email.

The commands use Bash syntax, including Linux, macOS, or Git Bash on Windows. In PowerShell, use `curl.exe` and put each command on one line or adapt the line continuations. Files under `.runtime/` are excluded from Git; keep credentials and cookie jars there.

First create the private working directory, then save `.runtime/login.json` locally with your chosen administrator credentials:

```bash
mkdir -p .runtime
```

This file example contains placeholders:

```json
{
  "username": "YOUR_ADMIN_USERNAME",
  "password": "YOUR_PRIVATE_PASSWORD"
}
```

For a local Docker installation, use the exact configured origin:

```bash
BASE_URL=http://localhost:3000
APP_ORIGIN=http://localhost:3000

curl --fail-with-body --silent --show-error \
  --cookie-jar .runtime/api-cookies.txt \
  --header "Origin: $APP_ORIGIN" \
  --header 'Content-Type: application/json' \
  --data-binary @.runtime/login.json \
  "$BASE_URL/api/login" > .runtime/api-session.json

CSRF=$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync('.runtime/api-session.json', 'utf8')).csrfToken ?? '')")
```

For Vite development, use the browser's `APP_ORIGIN=http://localhost:5173`; the API still normally listens on port 3000. In production both values use your HTTPS origin. These commands do not print the password or session cookie.

Login response, with an illustrative token placeholder:

```json
{
  "authenticated": true,
  "username": "YOUR_ADMIN_USERNAME",
  "csrfToken": "YOUR_SESSION_CSRF_TOKEN"
}
```

Check the current session:

```bash
curl --fail-with-body --silent --show-error \
  --cookie .runtime/api-cookies.txt \
  "$BASE_URL/api/session"
```

Without a valid session, `GET /api/session` returns `{"authenticated":false}` rather than an authentication error.

## Endpoints

`{id}` is the monitor ID returned when it was created. The table describes normal success responses.

| Method | Path | Access | Success |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | `200`, `{ "status": "ok" }` after a database query. |
| POST | `/api/login` | Matching Origin | `200`, session information and cookie. |
| GET | `/api/session` | Public/session aware | `200`, authentication state; CSRF token when signed in. |
| POST | `/api/logout` | Session, Origin, CSRF | `200`, `{ "authenticated": false }`. |
| GET | `/api/monitors` | Session | `200`, paginated monitor views, worker heartbeat, SMTP configuration flag. |
| POST | `/api/monitors` | Session, Origin, CSRF | `201`, created monitor view. |
| GET | `/api/monitors/{id}` | Session | `200`, monitor, recent checks, full-period chart, incidents, gaps, retention. |
| PATCH | `/api/monitors/{id}` | Session, Origin, CSRF | `200`, updated monitor view. |
| DELETE | `/api/monitors/{id}` | Session, Origin, CSRF | `204`, no body. |
| POST | `/api/monitors/{id}/check` | Session, Origin, CSRF | `202`, queued manual request. |
| GET | `/api/monitors/{id}/checks` | Session | `200`, paginated checks in the selected period. |
| GET | `/api/monitors/{id}/metrics` | Session | `200`, full-period metrics and retention. |
| GET | `/api/monitors/{id}/incidents` | Session | `200`, paginated incidents overlapping the selected period. |
| GET | `/api/incidents` | Session | `200`, paginated incidents across monitors. |
| GET | `/api/notifications` | Session | `200`, SMTP configuration and recent failed deliveries. |
| GET | `/api/demo/monitors` | Public, synthetic | `200`, synthetic monitor views. |
| GET | `/api/demo/monitors/{id}` | Public, synthetic | `200`, synthetic details; IDs such as `demo-1`. |
| GET | `/api/demo/incidents` | Public, synthetic | `200`, synthetic incidents. |

The health endpoint checks the API/database, not the availability of every website or worker. Inspect the monitor-list `worker` object separately.

## Request fields

POST requires `name` and `url`. Other fields have defaults. PATCH accepts any subset of these fields and additionally `paused`; it does not require sending the whole monitor.

| Field | Type | Accepted values / default |
| --- | --- | --- |
| `name` | string | Trimmed, 1–80 characters. |
| `url` | string | Maximum 2,048 characters; public HTTP/HTTPS, ports 80/443, no embedded credentials. |
| `intervalSeconds` | integer | `60`, `300`, or `900`; default `300`. |
| `timeoutMs` | integer | `1000`–`30000`; default `10000`. |
| `slowThresholdMs` | integer | `100`–`30000`; default `2000`. |
| `notificationEmail` | string or null | Optional valid email, maximum 254 characters; default `null`. |
| `paused` | boolean | PATCH only; `true` pauses, `false` resumes. |

Unknown body fields are rejected. An empty email string is invalid at the API level: omit `notificationEmail` or send `null`. The UI translates a blank optional email field to `null`. A syntactically valid URL can be saved before DNS is queried; the worker validates all actual DNS answers before each connection.

## Create a monitor

Store this example JSON as `.runtime/new-monitor.json`. Replace only the domain and email if you want to monitor your own site and receive messages:

```json
{
  "name": "Documentation website",
  "url": "https://example.com/",
  "intervalSeconds": 300,
  "timeoutMs": 10000,
  "slowThresholdMs": 2000,
  "notificationEmail": "alerts@example.com"
}
```

To monitor without email, omit `notificationEmail` or set it to `null`.

```bash
curl --fail-with-body --silent --show-error \
  --cookie .runtime/api-cookies.txt \
  --header "Origin: $APP_ORIGIN" \
  --header "X-CSRF-Token: $CSRF" \
  --header 'Content-Type: application/json' \
  --data-binary @.runtime/new-monitor.json \
  "$BASE_URL/api/monitors"
```

The response is a monitor view. This illustrative example has not been checked yet:

```json
{
  "id": "MONITOR_ID",
  "name": "Documentation website",
  "url": "https://example.com/",
  "intervalSeconds": 300,
  "timeoutMs": 10000,
  "slowThresholdMs": 2000,
  "notificationEmail": "alerts@example.com",
  "paused": false,
  "nextCheckAt": "2026-10-06T15:00:00.000Z",
  "createdAt": "2026-10-06T15:00:00.000Z",
  "state": "NO_DATA",
  "lastCheck": null,
  "metrics": {
    "samples": 0,
    "successfulSamples": 0,
    "availability": null,
    "averageMs": null,
    "p95Ms": null
  },
  "openIncident": null
}
```

Set `MONITOR_ID` to the real ID in the response. New monitors are due for the worker to claim; creating one does not mean a check has already completed.

## Query periods, filters, and pagination

| Query | Where it applies | Values |
| --- | --- | --- |
| `period` | Monitor list/details, checks, metrics, incidents | `24h`, `7d`, `30d`; default `24h`, rolling from now. |
| `page` | Real monitor, check, incident lists | Integer `1`–`10000`; default `1`. |
| `pageSize` | Real monitor, check, incident lists | Integer `1`–`100`; default `20`. |
| `q` | Real monitor list | Case-insensitive substring of name or URL; maximum 100 characters. |
| `state` | Real monitor list | `UP`, `SLOW`, `PENDING`, `DOWN`, `STALE`, `PAUSED`, `NO_DATA`. |

Monitor list state reflects the latest observation and current freshness, regardless of which historical metric period is selected. Incidents overlap a window if they are still open or recovered within it, so a long-running incident that started before the window remains visible. History is preserved beyond 30 days even though the API's selectable windows are at most 30 days.

```bash
curl --fail-with-body --silent --show-error \
  --cookie .runtime/api-cookies.txt \
  "$BASE_URL/api/monitors?period=7d&page=1&pageSize=20&state=STALE"

curl --fail-with-body --silent --show-error \
  --cookie .runtime/api-cookies.txt \
  "$BASE_URL/api/monitors/$MONITOR_ID/checks?period=30d&page=2&pageSize=100"
```

List envelopes use `{ "items": [...], "total": 42, "page": 1, "pageSize": 20 }`. `total` is the filtered count before pagination. Monitors are ordered by creation date; checks by newest observation; incidents by newest confirmation. The public demo is a fixed small fixture and does not paginate the real database.

The monitor list also returns:

```json
{
  "worker": { "lastSeenAt": null, "stale": true },
  "notifications": { "configured": false }
}
```

`worker.stale` indicates a missing heartbeat or one older than 45 seconds. `notifications.configured` indicates SMTP configuration, not proof that a mailbox accepted a message.

## Details, checks, and metrics

`GET /api/monitors/{id}?period=7d` returns:

```text
{
  monitor: MonitorView,
  checks: CheckView[],
  chart: { checkedAt, responseTimeMs, samples }[],
  incidents: IncidentView[],
  gaps: { startedAt, endedAt }[],
  retentionDays: 30
}
```

The detail response includes up to 500 recent checks and 100 overlapping incidents. Use their paginated endpoints to inspect more rows. The chart and metrics are calculated over the full selected period, independent of the recent-check cap.

Chart entries are ascending time buckets: 5 minutes for `24h`, 30 minutes for `7d`, and 2 hours for `30d`. `responseTimeMs` is the rounded average of successful responses in that bucket, or `null` without a successful response. `samples` counts completed website observations in the bucket and excludes `INTERNAL`. Preserve nulls when drawing the chart; never replace them with zero. The separate `gaps` array identifies recorded collection gaps.

Check view example:

```json
{
  "id": "CHECK_ID",
  "checkedAt": "2026-10-06T15:05:00.000Z",
  "source": "AUTOMATIC",
  "success": false,
  "httpStatus": 503,
  "responseTimeMs": 182,
  "elapsedMs": 182,
  "errorCategory": "HTTP_STATUS",
  "errorMessage": "Unexpected HTTP status 503."
}
```

`source` is `AUTOMATIC` or `MANUAL`. Categories are `DNS`, `CONNECTION`, `TLS`, `TIMEOUT`, `HTTP_STATUS`, `BLOCKED`, `REDIRECT_LIMIT`, `INTERNAL`, or `null` for success. Network/policy failures without final headers have null HTTP status and response time; elapsed time remains separate. `INTERNAL` is a collection failure and does not count as a website failure.

`GET /api/monitors/{id}/metrics?period=7d` returns:

```json
{
  "period": "7d",
  "samples": 100,
  "successfulSamples": 90,
  "availability": 90,
  "averageMs": 244,
  "p95Ms": 410,
  "retentionDays": 30
}
```

These values are illustrative, not a claim about `example.com`. Availability is successful website samples divided by website samples times 100. Average and nearest-rank p95 use successful HTTP responses only. Zero relevant samples produce `null` metrics. See [measurement rules](ARCHITECTURE.md#measurements-and-charts).

## Queue a manual check

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --cookie .runtime/api-cookies.txt \
  --header "Origin: $APP_ORIGIN" \
  --header "X-CSRF-Token: $CSRF" \
  "$BASE_URL/api/monitors/$MONITOR_ID/check"
```

Successful response is **202 Accepted**:

```json
{ "queued": true, "requestId": "CHECK_REQUEST_ID" }
```

The worker later executes this request through the same secure pipeline as scheduled checks. The request ID identifies the queue record; it is not a check result or a website status. Poll the monitor details or checks endpoint to observe the resulting `MANUAL` check. A stopped worker leaves the request queued.

There is a one-minute minimum between accepted manual requests for the same monitor, a maximum of three pending manual requests across the installation, and at most one pending request per monitor. Paused monitors return 409. The route also limits requests to ten per minute per requester. Automatic and manual checks share the worker's three concurrent slots.

## Edit, pause, resume, or remove

PATCH sends only the fields to change:

```bash
curl --fail-with-body --silent --show-error \
  --request PATCH \
  --cookie .runtime/api-cookies.txt \
  --header "Origin: $APP_ORIGIN" \
  --header "X-CSRF-Token: $CSRF" \
  --header 'Content-Type: application/json' \
  --data '{"paused":true}' \
  "$BASE_URL/api/monitors/$MONITOR_ID"
```

Use `{"paused":false}` to resume, `{"notificationEmail":null}` to remove an optional recipient, or `{"slowThresholdMs":2500}` to adjust the slow threshold. Pausing completes queued manual requests and prevents their execution. Resuming schedules a check shortly afterward.

A URL change returns 409 while a check is in flight or an incident is open. Otherwise it resets the latest-target state and consecutive-failure streak; old checks and metrics remain part of this monitor's history. Use a new monitor for an unrelated site's separate history. POST/PATCH responses return the updated monitor with the default 24-hour metrics.

DELETE permanently removes the monitor and its related history, including its incident notifications:

```bash
curl --fail-with-body --silent --show-error \
  --request DELETE \
  --cookie .runtime/api-cookies.txt \
  --header "Origin: $APP_ORIGIN" \
  --header "X-CSRF-Token: $CSRF" \
  "$BASE_URL/api/monitors/$MONITOR_ID"
```

The API returns 204 with no JSON. It does not implement a separate confirmation endpoint; the dashboard confirms before issuing DELETE.

## Incidents and optional email

An incident view contains `id`, `monitorId`, `monitorName`, `firstFailureAt`, `confirmedAt`, `recoveredAt`, and `errorCategory`. `recoveredAt: null` means open. Two consecutive failed website observations open one incident; a successful observation closes it. The fields describe observation times, not the exact unobserved downtime boundaries.

If `notificationEmail` is configured, incident confirmation and recovery each queue one message in the same transaction as the incident transition. Sending requires SMTP configuration and a running worker. The public demo never queues or sends messages. Delivery retries are separate from monitoring outcomes.

```bash
curl --fail-with-body --silent --show-error \
  --cookie .runtime/api-cookies.txt \
  "$BASE_URL/api/incidents?period=30d&page=1&pageSize=100"

curl --fail-with-body --silent --show-error \
  --cookie .runtime/api-cookies.txt \
  "$BASE_URL/api/notifications"
```

The notification endpoint returns `configured` and at most 50 recent failure records. Each record exposes `id`, `incidentId`, `kind`, `attempts`, `abandonedAt`, and `nextTryAt`, without SMTP credentials, message bodies, or recipient addresses. After five unsuccessful attempts, the message is abandoned. There is no API endpoint to manually resend it. See [email guarantees](ARCHITECTURE.md#optional-email-delivery).

## Sign out

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --cookie .runtime/api-cookies.txt \
  --cookie-jar .runtime/api-cookies.txt \
  --header "Origin: $APP_ORIGIN" \
  --header "X-CSRF-Token: $CSRF" \
  "$BASE_URL/api/logout"
```

The session is removed and its cookie cleared. Clear the local `CSRF` variable and remove the private login/session example files when finished.

## Errors and limits

Application errors use `{ "error": "Readable message" }`. Fastify's rate limiter can also include its standard `statusCode`, `error`, and `message` fields. Client code should inspect the HTTP status and tolerate that shape.

| Status | Typical cause |
| --- | --- |
| 400 | Invalid field, forbidden URL syntax/address, or unsupported interval. |
| 401 | Invalid login credentials or missing/expired administrator session. |
| 403 | Wrong/missing Origin, wrong/missing CSRF token, or demo mutation. |
| 404 | Missing monitor or unknown endpoint. |
| 409 | 20-monitor limit, paused manual check, duplicate queued check, or unsafe URL edit during activity. |
| 429 | Login/request limit, manual cooldown, or full manual queue. |
| 500 | Internal API/database failure; private exception details are not returned. |

General API throttling is 120 requests per minute per requester; login and manual check routes have stricter limits. Bodies are limited to 16 KiB. The API does not accept arbitrary headers, request bodies, credentials, private URLs, or alternate monitoring methods from clients. Deployment must use the single supported worker and preserve database storage; see [deployment](DEPLOYMENT.md).

## Resumo em português

Use a sessão do administrador para consultar dados reais. Toda alteração exige `Origin` correto e, após o login, `X-CSRF-Token` junto ao cookie. O email é opcional (`null` ou campo omitido), e a verificação manual entra numa fila executada pelo worker. O [README em português](../README.pt-BR.md) apresenta a configuração e o uso do painel.
