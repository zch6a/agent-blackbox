# Security

agent-blackbox reads files that can contain source code, credentials and personal data, so security issues are taken seriously.

## Design

- Log files are opened **read-only** and never modified, moved or uploaded.
- The UI server listens on `127.0.0.1` by default. Every `/api/*` request must carry a random token generated at startup; it is only embedded in the page served to you.
- Requests whose `Host` header is not the server's own loopback address are rejected, which blocks DNS-rebinding attacks from web pages you visit.
- Responses send `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- The UI escapes all log content before rendering; Markdown rendering is a small allow-list (no raw HTML), done in
  one pass so nothing it writes is parsed again (an earlier chain of passes allowed a stored XSS, fixed in 1.2.0).
- In the terminal, control characters from logs are shown as symbols: escape sequences in a log are never sent to
  your terminal.
- Bound to every interface (`--host 0.0.0.0`, which prints a warning), the server also accepts requests addressed
  to this machine's IP addresses; a domain name is still refused, and every API call still needs the token.
- There is no telemetry and no outbound network traffic.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab) with steps to reproduce. You should get a response within a few days.
