// API gateway for api.simplesalt.company: maps a path prefix to the private
// network that serves it. Routed on api.simplesalt.company/*; the Workers with
// their own, more specific routes on this host (HubSpot, Gmail, LinkedIn,
// Dux-Soup, MCP) never reach it.
//
// Each entry forwards the request unchanged (method, path, headers including
// Cf-Access-Jwt-Assertion, body) and only overrides where it resolves: the
// origin hostname is a proxied record in this zone that points at that
// network, e.g. a CNAME to its Cloudflare Tunnel, whose ingress then matches on
// Host api.simplesalt.company and the path. Cloudflare Access on a path runs
// before this Worker, so sign-in and CORS preflights are handled there.
//
// Adding an API: one entry here, plus its tunnel ingress rule (and Access app
// if it needs sign-in) wherever that network is managed.
export const ROUTES = [
  // Grammar fix, ssint-main cluster, namespace ssint-main-voice.
  { prefix: "/45e6451afc312886/grammar", origin: "ssint-main-origin.simplesalt.company" },
];

export function match(pathname) {
  return ROUTES.find(
    (r) => pathname === r.prefix || pathname.startsWith(r.prefix + "/"),
  );
}

export default {
  async fetch(request) {
    const route = match(new URL(request.url).pathname);
    if (!route) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return fetch(request, { cf: { resolveOverride: route.origin } });
  },
};
