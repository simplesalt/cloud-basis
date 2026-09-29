// Non-secret build-time configuration, baked into the bundle by
// scripts/bundle.mjs from a config.json file (see that script for which one).
// Values may be the literal string "PENDING" until the real Cloudflare
// account details are known; the Worker still builds and runs, it just
// won't point at a real host or Access application until config.json is
// filled in and rebuilt.
declare const __BUILD_CONFIG__: string;

export interface BuildConfig {
  /** Public hostname the MCP endpoint is served on, e.g. r4x69awbkkotgfs44cmd.simplesalt.company. */
  host: string;
  /** Cloudflare Access team auth domain, e.g. <team-name>.cloudflareaccess.com. */
  accessAuthDomain: string;
  /** Client ID of the Access for SaaS OIDC application fronting this Worker. */
  accessClientId: string;
}

export const BUILD_CONFIG: BuildConfig = JSON.parse(__BUILD_CONFIG__) as BuildConfig;

/** The fixed hostname documented as a signpost to the real MCP host; never PENDING. */
export const API_SIGNPOST_HOST = 'api.simplesalt.company';
