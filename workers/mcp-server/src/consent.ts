// The /authorize consent page. Everything in `details` can come from a
// dynamically registered or CIMD client, so every value is HTML-escaped
// before it is rendered — see docs/consent-page.md in
// @cloudflare/workers-oauth-provider for why this page exists and what it
// must show (MCP security guidance: name the client, name the redirect
// host, warn on a loopback redirect).
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function renderConsentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const loopbackWarning = details.redirectIsLoopback
    ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize ${name}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<h1>Allow ${name} to access your account?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopbackWarning}
<p>You will be asked to sign in with your identity provider next.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button name="decision" value="approve">Allow</button>
  <button name="decision" value="deny">Deny</button>
</form>
</body>
</html>`;
}
