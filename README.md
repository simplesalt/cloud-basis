# cloud-basis

Cloudflare and Google Workspace/GCP Crossplane resources for the SimpleSalt
proprietary account set (`ssint-main` account `ba92fe12c6c1275f965c7c86e3b392ac`,
GCP project `internalapps-481018`). Intended to be delivered via a Flux
`Kustomization` (and, upstream, a `FluxInstance`) as part of a larger
cluster stack, with Crossplane providers supplied by `simplesalt/basis`.

This repo holds **managed resources only** — the Crossplane provider
*installation* (`Provider`, `DeploymentRuntimeConfig`, provider CRDs) is
explicitly out of scope and stays in `simplesalt/basis` (`cf-providers.yaml`,
`cf-runtime.yaml`, `gcp-providers.yaml`, `gcp-runtime.yaml`).

## Provenance

This repo's initial content was assembled from two sources that were meant
to converge here but hadn't yet (simplesalt/projects#183, #184):

- `simplesalt/base-stack@named` — `3.infra/cf-main*.yaml`, `3.infra/gcp.yaml`,
  `2.access/cf-main-creds-job.yaml`, `3.infra/post-tunnel/tunnel-config.yaml`
  (`HelmRelease/cloudflared-main` only — see dedupe note below).
- `simplesalt/brain` — `manifests/cloudflare-zero-trust-main.yaml`,
  `manifests/gcp-sso.yaml`, `manifests/simplesalt-certs.yaml`,
  `manifests/cloudflare-zero-trust-idp-quarantine.yaml`.

Both source repos were cloned **read-only** to author this content;
nothing was deleted or modified in either. `base-stack@named` and `brain`
still declare their own copies of everything below as of this writing —
this repo is not yet subscribed by any live cluster, so there is no
double-apply risk today. Cutting `base-stack`/`brain` over to this repo
(and removing their copies) is a separate, out-of-scope activity now that
`base-stack` is being retired wholesale in favor of a new cluster
bootstrapped against `cloud-basis` and its sibling repos directly.

## Account-based split rule

Every resource here belongs to the SimpleSalt Cloudflare account
`ssint-main` (`ba92fe12c6c1275f965c7c86e3b392ac`) or GCP project
`internalapps-481018`. Classification is by **owning cloud account, not by
object name** — e.g. `Bucket/ss-testing` is SimpleSalt-*named* but lives in
the personal `evans-home` Cloudflare account, so it is **excluded** here;
it belongs in `dylannevans/cloud-basis` (simplesalt/projects#182).

## Layout and ordering

```
00-providers/   ProviderConfigs + their backing credential Secrets
10-cloudflare/  ssint-main Cloudflare account: R2, KV, tunnel, Zero Trust access
20-gcp/         GCP SSO/SCIM support resources (internalapps-481018)
30-certs/       cert-manager ClusterIssuer for simplesalt.company (NOT Crossplane)
quarantine/     known-broken manifest, deliberately excluded from any build
```

**Ordering constraint:** `ProviderConfig/ssint-main` (both the namespaced
`upjet-cloudflare.m.upbound.io` and cluster-scoped
`upjet-cloudflare.upbound.io` variants), `ProviderConfig/gcp-default`, and
their backing Secrets (`cloudflare-credentials-main`, `gcp-credentials`)
must be reconciled before any managed resource that references them via
`providerConfigRef`. They are isolated in `00-providers/`, listed first in
the root `kustomization.yaml`, specifically so this is visible from a file
listing. A flat `kustomize build .` does not itself guarantee apply order
under Flux's server-side apply within a single Kustomization — if the
Crossplane provider CRDs/ProviderConfigs are not already installed and
healthy on the target cluster before this Kustomization's first
reconcile, split this into a `dependsOn` chain (e.g.
`ss-cloud-basis-providers` → `ss-cloud-basis`) rather than relying on file
order alone. `30-certs/` has no dependency on `00-providers/` (cert-manager,
not Crossplane) but does need cert-manager's CRDs installed first (from
`simplesalt/basis`).

## Naming conventions for the consuming cluster config

This repo does not itself contain Flux `GitRepository`/`Kustomization`
objects (those live in the cluster bootstrap config, out of scope for this
task). When wiring this repo into a cluster: the `GitRepository` should be
named `ss-cloud-basis`, and any `Kustomization`s that reference it should
be named `ss-cloud-basis-*`, per SimpleSalt's `<entity>-<clustername>-<capability>`
convention (entity prefix `ss`). The Crossplane providers this repo depends
on come from `simplesalt/basis`; use `dependsOn: basis` (or
`ss-basis`, matching whatever that repo's Kustomization is actually named).

## The dedupe

Several objects were declared independently in both `base-stack` and
`brain`. Diffed byte-for-byte before choosing; in every case `spec` was
**identical** between the two copies, so no live-config decision was
required — only a documentation/label decision. This table is exhaustive:
every SimpleSalt-proprietary object independently declared in both
`base-stack@named` and `brain` as of this repo's initial content is listed
below (confirmed by audit, simplesalt/projects#183):

| Objects | Only differences found | Kept |
|---|---|---|
| `Secret/gcp-credentials`, `ProviderConfig/gcp-default` | labels (`entity: cluster, capability: infra` vs `entity: ssint, env: main, capability: access`); base-stack's copies also carried `kustomize.toolkit.fluxcd.io/prune: disabled` | brain's copy (`00-providers/gcp-provider.yaml`) |
| `TrustOrganization/cf-main-zero-trust-org` | same as above | brain's copy (`10-cloudflare/zero-trust.yaml`) |
| `Secret/ssint-main-g-idp-secret` (the client_id placeholder Secret was also deduped here at migration time; later deleted — see "Unsubstituted `${...}` variables" below) | same as above | brain's copy |
| `TrustAccessIdentityProvider/cf-main-idp-ssint-sso` | same as above | brain's copy |
| `TrustTunnelCloudflaredConfig/ssint-main-tunnel-config` | same as above | brain's copy |
| `Record/info-simplesalt-company` | same as above | brain's copy |
| `TrustAccessPolicy/simplesalt-email-domain`, `TrustAccessApplication/cloudflare-app-appflowy-main` | labels (`entity: cluster, capability: access` vs `entity: ssint, env: main, capability: access`); base-stack's copy (`2.access/cf-zero-trust-apps-appflowy-main.yaml`) also carried `kustomize.toolkit.fluxcd.io/prune: disabled` | brain's copy (`10-cloudflare/zero-trust.yaml`) |
| `ProjectService/admin-googleapis-com`, `ServiceAccount/cloudflare-sso-agent`, `ServiceAccountKey/cloudflare-sso-agent-key` | labels (`entity: cluster, capability: infra` vs `entity: ssint, env: main, capability: access`); base-stack's copy (`3.infra/gcp-cloudflare-sso.yaml`) also carried `kustomize.toolkit.fluxcd.io/prune: disabled` | brain's copy (`20-gcp/gcp-sso.yaml`) |

Rationale for keeping brain's copies in all eight cases: the `entity: ssint,
env: main, capability: access` labels correctly identify this as
SimpleSalt-proprietary account content, consistent with the other access-tier
objects it's declared alongside (`TrustAccessPolicy`, `TrustAccessApplication`,
the GCP SSO service-account chain) — vs. base-stack's generic
`entity: cluster` labels, which read as cluster-infra rather than
account-specific. `kustomize.toolkit.fluxcd.io/prune: disabled` was dropped
in all cases: that annotation was a defensive artifact of the live
`base-stack`/`brain` dual-ownership flap (two Kustomizations racing to
reconcile — and prune — the same object); with exactly one canonical
declaration here and no other claimant, it serves no purpose, and pruning
this repo's own Kustomization is the intended control path going forward.

**One label correction found by the same audit (simplesalt/projects#183):**
`ClusterIssuer/simplesalt` (`30-certs/simplesalt-certs.yaml`) was migrated
with `capability: access`, unlike every other object above where only
`entity`/`env` normalize and `capability`'s *value* carries over unchanged.
Its base-stack counterpart (`3.infra/certs.yaml`) used `capability: certs`
(no `env` field), and `certs` is a distinct, actively-used SimpleSalt
capability value — base-stack's `cert-manager` Namespace and its
`cert-manager` controller `HelmRelease` (`1.basis/ns.yaml`,
`1.basis/controllers.yaml`) both also use `capability: certs`, separate from
`access`/`infra`. Corrected here to `capability: certs` to match. Verified
the `capability` label is never used as a selector (`matchLabels`/
`labelSelector`) anywhere in this repo or in `base-stack`, so this is a
label-only, no-behavior-change fix.

**Discrepancy found and NOT resolved by invention:** simplesalt/projects#184
states `TrustAccessIdentityProvider/cf-main-idp-ssint-sso` is "adopted by
external ID `42cbdc64-699e-4e17-b470-fb7cda3c0791`" via
`crossplane.io/external-name`. Checked both source copies
(`brain/manifests/cloudflare-zero-trust-main.yaml` and
`base-stack@named 3.infra/cf-main-idp.yaml`): **neither carries a
`crossplane.io/external-name` annotation on that object.** The UUID
`42cbdc64-…` only appears as a plain value (with an explanatory comment)
inside `TrustAccessApplication/cloudflare-app-appflowy-main`'s
`allowedIdps[]` list — a spec reference, not an adoption annotation. This
repo carries the object exactly as found in source (no annotation). If
adoption-by-external-name was actually intended, it needs to be added
deliberately after confirming the value against the live Cloudflare API —
not assumed from this migration.

Final check: `grep` across every file for `^kind:`/`^  name:` pairs
confirms no `apiVersion`/`kind`/`namespace`/`name` tuple repeats anywhere
in this repo (see "Validation" below).

## `crossplane.io/external-name` annotations carried over (verbatim)

| Object | Value |
|---|---|
| `Bucket/cf-main-backups` | `backups` |
| `KvNamespace/cf-main-kv-sot-test-results` | `b8f5e5a1be0240f6b484b4ab1258a6a8` |
| `KvNamespace/cf-main-kv-sot-test-results-dev` | `05b9f242460f42b1bd29178bf85b2767` |
| `TrustOrganization/cf-main-zero-trust-org` | `ba92fe12c6c1275f965c7c86e3b392ac` |
| `TrustAccessPolicy/simplesalt-email-domain` | `79bac8d3-6c82-4ac5-bbdb-f98a3388236c` |
| `ProjectService/admin-googleapis-com` | `admin.googleapis.com` |
| `ServiceAccount/cloudflare-sso-agent` | `cloudflare-sso-agent` |

`TrustAccessIdentityProvider/cf-main-idp-ssint-sso` has **no**
`crossplane.io/external-name` annotation in either source copy — see the
discrepancy note above. `TrustAccessApplication/cloudflare-app-appflowy-main`
also has none by design (Crossplane creates it; see the comment in
`10-cloudflare/zero-trust.yaml`).

## Unsubstituted `${...}` variables

These render literally (e.g. `${ssint_main_tunnel_id}`) unless the Flux
`Kustomization` that owns this repo sets `postBuild.substituteFrom`
pointing at the Secrets/ConfigMaps below:

| Variable | Used in | Sourced from |
|---|---|---|
| `${ssint_main_tunnel_id}` | `10-cloudflare/zero-trust.yaml` (`TrustTunnelCloudflaredConfig/ssint-main-tunnel-config`, `Record/info-simplesalt-company`) | `Secret/ssint-main-tunnel-id` (`flux-system`, key `ssint_main_tunnel_id`), patched by the `fetch-ssint-main-tunnel-id` Job in `10-cloudflare/tunnel.yaml` once the tunnel is Ready |

`${client_id}` was previously listed here, sourced from a `flux-system`
placeholder Secret. It has been removed: `clientId` on
`TrustAccessIdentityProvider/cf-main-idp-ssint-sso` is now an inlined
literal (a GCP OAuth2 client_id is a public identifier, not credential
material — simplesalt/projects#235, simplesalt/projects#236), and the
placeholder Secret was deleted.

Without `postBuild.substituteFrom` wired up on the owning Kustomization,
`ssint-main-tunnel-config` reconciles with the literal string
`${ssint_main_tunnel_id}` and is `Synced=False` — this is the exact failure
mode flagged in simplesalt/projects#184. Not resolved here by design (the
bootstrap `config.yaml` for the new cluster needs to declare matching
`substituteFrom` entries; that lives in a different repo, out of scope for
this task).

## Out-of-band secrets (empty on a fresh cluster)

None of these are populated by any manifest in this repo. Each must be
patched manually (or by some other out-of-band automation) before the
resources that depend on them can reconcile:

| Secret | Namespace | Populated how |
|---|---|---|
| `ssint-main-cf` | `crossplane-system` | Raw Cloudflare API token, key `api_token`. The `assemble-cloudflare-credentials-main` Job (`10-cloudflare/creds-job.yaml`) reads this and writes the JSON-wrapped form into `cloudflare-credentials-main`. |
| `cloudflare-credentials-main` | `crossplane-system` | Written by the Job above — indirect, but still ultimately out-of-band via `ssint-main-cf`. |
| `gcp-credentials` | `crossplane-system` | JSON GCP service-account key patched directly into the `credentials` key (no assembler Job by design): `kubectl patch secret gcp-credentials -n crossplane-system --type=merge -p '{"data":{"credentials":"<base64 key.json>"}}'` |
| `ssint-main-g-idp-secret` | `crossplane-system` | Google OAuth client secret, key `client_secret`, for the OAuth2 client created per the operator steps in `10-cloudflare/zero-trust.yaml`. |
| `ss-acme-cf-token` | `cert-manager` | Cloudflare API token scoped for DNS-01 challenges on `simplesalt.company`, key `api-token`. |

`ssint-main-tunnel-id` (`flux-system`) and `ssint-main-tunnel-token`
(`cluster-named-routing`) are also empty placeholders at apply time, but
those ARE self-populating via in-repo Jobs (`fetch-ssint-main-tunnel-id`,
`fetch-ssint-main-tunnel-token` in `10-cloudflare/tunnel.yaml` /
`tunnel-token-job.yaml`) once `TrustTunnelCloudflared/ssint-main-tunnel` is
Ready, so they aren't "out-of-band" in the same sense.

## Quarantined file

`quarantine/cloudflare-zero-trust-idp-quarantine.yaml` is copied
byte-for-byte from `brain/manifests/cloudflare-zero-trust-idp-quarantine.yaml`
and is **deliberately not referenced by any `kustomization.yaml` in this
repo** (it isn't listed in any `resources:`). Its `config[]`/`scimConfig[]`
OIDC fields use list-form shapes that target a newer
`provider-cloudflare-zero` than the currently installed `v0.2.6`, whose CRD
declares those fields as bare objects — applying it causes a strict-decode
failure. It has never applied anywhere. The live equivalent
(`TrustAccessIdentityProvider/cf-main-idp-ssint-sso`, object-form config) is
in `10-cloudflare/zero-trust.yaml` and IS reconciled. This file is kept only
as a scanned-from-the-API historical reference in case the list-form shape
is wanted again after a provider upgrade; deleting it was considered but
rejected in favor of preserving optionality — flag for review if it's
confirmed dead.

## Hardcoded cluster-specific references

The new cluster's name is undecided (simplesalt/projects#216). The
following references to the *current* cluster were carried over unchanged
because inventing a new name is out of scope, and should be revisited once
the new cluster's naming convention is set:

- `10-cloudflare/tunnel-daemon.yaml`: `namespace: cluster-named-routing`
  (`HelmRelease/cloudflared-main`'s target namespace).
- `10-cloudflare/tunnel.yaml`: `namespace: cluster-named-routing` (tunnel
  run-token connection secret) and RBAC in `flux-system`.
- `10-cloudflare/zero-trust.yaml`: tunnel ingress service target
  `http://big-agi.ssint-main-ai.svc.k.famevans.win:3000` — the
  `famevans.win`-domain, `ssint-main-ai`-namespace service reference is
  specific to the current cluster's internal DNS.

## Validation

Validated locally with `kustomize build .` (and each subdirectory) using
kustomize v5.4.3 — see the task report for full output. Zero duplicate
`kind`/`namespace`/`name` tuples confirmed across the whole repo.

## Explicitly out of scope

- Crossplane *installation* (`Provider`, runtime config, CRDs) — stays in
  `simplesalt/basis` (`cf-providers.yaml`, `cf-runtime.yaml`,
  `gcp-providers.yaml`, `gcp-runtime.yaml`).
- Personal `evans-home` account resources (`Secret/cloudflare-credentials`,
  `ProviderConfig/default` x2, `Bucket/ss-testing`, the personal
  creds-assembler Job) — go to `dylannevans/cloud-basis`
  (simplesalt/projects#182).
- Any modification to `simplesalt/base-stack` or `simplesalt/brain` — both
  are read-only sources for this task. Retiring their copies of this
  content is a separate, later activity once a live cluster actually
  subscribes to this repo.
- Wiring this repo into any cluster's `flux.repos`/`config.yaml` — that
  lives in a different repo and is out of scope here.
