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
nothing was deleted or modified in either at that time. `base-stack@named`
and `brain` originally still declared their own copies of everything below,
and since this repo was not yet subscribed by any live cluster there was no
double-apply risk. That has since changed for the `brain` overlap
specifically: the objects `brain` and `cloud-basis` both declared have been
removed **from this repo** (simplesalt/projects#226) — see "The dedupe"
below for the full accounting and rationale. `base-stack` is being retired
wholesale in favor of a new cluster bootstrapped against `cloud-basis` and
its sibling repos directly, and any remaining `base-stack`-only overlap is
unaffected by this change.

## Account-based split rule

Every resource here belongs to the SimpleSalt Cloudflare account
`ssint-main` (`ba92fe12c6c1275f965c7c86e3b392ac`) or GCP project
`internalapps-481018`. Classification is by **owning cloud account, not by
object name** — e.g. `Bucket/ss-testing` is SimpleSalt-*named* but lives in
the personal `evans-home` Cloudflare account, so it is **excluded** here;
it belongs in `dylannevans/basis:cloud/` (simplesalt/projects#227 —
supersedes the earlier `dylannevans/cloud-basis` destination named in
simplesalt/projects#182, which is closed and unused).

## Layout and ordering

```
00-providers/   ProviderConfig(s) + backing credential Secret for the ssint-main Cloudflare account
10-cloudflare/  ssint-main Cloudflare account: R2, KV, tunnel
quarantine/     known-broken manifest, deliberately excluded from any build
```

`20-gcp/` (GCP SSO/SCIM support resources) and `30-certs/` (cert-manager
`ClusterIssuer` for simplesalt.company) were removed entirely
(simplesalt/projects#226): every object either directory declared duplicated
one `simplesalt/brain` already declares, and brain is the canonical owner
going forward. See "The dedupe" below.

**Ordering constraint:** `ProviderConfig/ssint-main` (both the namespaced
`upjet-cloudflare.m.upbound.io` and cluster-scoped
`upjet-cloudflare.upbound.io` variants) and its backing Secret
(`cloudflare-credentials-main`) must be reconciled before any managed
resource in `10-cloudflare/` that references it via `providerConfigRef`.
They are isolated in `00-providers/`, listed first in the root
`kustomization.yaml`, specifically so this is visible from a file listing.
A flat `kustomize build .` does not itself guarantee apply order under
Flux's server-side apply within a single Kustomization — if the Crossplane
provider CRDs/ProviderConfigs are not already installed and healthy on the
target cluster before this Kustomization's first reconcile, split this into
a `dependsOn` chain (e.g. `ss-cloud-basis-providers` → `ss-cloud-basis`)
rather than relying on file order alone.

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

**Current state (simplesalt/projects#226):** this repo's initial content was
populated by *copying* manifests out of `simplesalt/brain` (and
`simplesalt/base-stack`) without deleting the originals, so both `brain` and
`cloud-basis` ended up declaring the same live Cloudflare/GCP objects. That
duplication has been resolved by **removing the 14 duplicated objects from
this repo**; `simplesalt/brain` keeps sole ownership of them and is left
byte-identical. `simplesalt/brain` is reconciled by the *live* cluster with
`prune: true`, so removing the declarations there would delete the real
objects and requires that cluster to be switched off first; `cloud-basis` is
reconciled by no cluster at all, so editing it here is free and immediate.
The new cluster still receives these objects — it subscribes to `brain` as
well as `cloud-basis`. (An earlier version of this README, and
simplesalt/projects#226 itself before it was retitled, described the
opposite direction — dedupe by editing `brain` — with an 8-row table. That
direction was reversed by the repo owner; the true duplicate count, computed
by rendering both repos with `kustomize build .` and intersecting
`apiVersion/kind/namespace/name` tuples, is **14**, not 8.)

The 14 removed objects, and where they used to live in this repo:

| Object | Former location |
|---|---|
| `Secret/gcp-credentials` | `00-providers/gcp-provider.yaml` (whole file removed) |
| `ProviderConfig/gcp-default` | `00-providers/gcp-provider.yaml` (whole file removed) |
| `TrustOrganization/cf-main-zero-trust-org` | `10-cloudflare/zero-trust.yaml` (whole file removed) |
| `Secret/ssint-main-g-idp-secret` | `10-cloudflare/zero-trust.yaml` |
| `TrustAccessIdentityProvider/cf-main-idp-ssint-sso` | `10-cloudflare/zero-trust.yaml` |
| `TrustAccessPolicy/simplesalt-email-domain` | `10-cloudflare/zero-trust.yaml` |
| `TrustAccessApplication/cloudflare-app-appflowy-main` | `10-cloudflare/zero-trust.yaml` |
| `TrustTunnelCloudflaredConfig/ssint-main-tunnel-config` | `10-cloudflare/zero-trust.yaml` |
| `Record/info-simplesalt-company` | `10-cloudflare/zero-trust.yaml` |
| `ProjectService/admin-googleapis-com` | `20-gcp/gcp-sso.yaml` (whole directory removed) |
| `ServiceAccount/cloudflare-sso-agent` | `20-gcp/gcp-sso.yaml` |
| `ServiceAccountKey/cloudflare-sso-agent-key` | `20-gcp/gcp-sso.yaml` |
| `ClusterIssuer/simplesalt` | `30-certs/simplesalt-certs.yaml` (whole directory removed) |
| `Secret/ss-acme-cf-token` | `30-certs/simplesalt-certs.yaml` |

Each of the four removed files/directories was **entirely** duplicated —
every object declared in it appears in the table above — so no partial-file
edits were needed; `git rm` of the file (and its `resources:` entry, and, for
`20-gcp/`/`30-certs/`, the emptied directory and its root `kustomization.yaml`
entry) was sufficient.

**Cross-repo references left behind:** none. Every surviving `cloud-basis`
object that could plausibly have referenced a removed one turned out to live
in the *same* removed file (e.g. `20-gcp/gcp-sso.yaml`'s three objects all
reference `providerConfigRef: gcp-default`, but all three — and
`gcp-default` itself — were duplicates and are gone together). No object
that remains in this repo references a name that now only exists in `brain`.

**`${ssint_main_tunnel_id}`:** its only two consumers in this repo,
`TrustTunnelCloudflaredConfig/ssint-main-tunnel-config` and
`Record/info-simplesalt-company`, were both removed (both lived in
`10-cloudflare/zero-trust.yaml`). `10-cloudflare/tunnel.yaml`'s
`fetch-ssint-main-tunnel-id` Job still *produces* the value (patches
`Secret/ssint-main-tunnel-id` in `flux-system`, key `ssint_main_tunnel_id`),
but as of this change **no manifest in `cloud-basis` consumes it** — the
`${...}` substitution requirement described in simplesalt/projects#235 has
left this repo. See "Unsubstituted `${...}` variables" below, which no
longer lists this variable.

---

The remainder of this section is the **original** base-stack/brain dedupe
history from when this repo was first authored (simplesalt/projects#183,
#184) — kept for provenance, since it explains where the now-removed
objects' `spec`/labels originally came from before brain's copy was chosen
as canonical:

Several objects were declared independently in both `base-stack` and
`brain`. Diffed byte-for-byte before choosing; in every case `spec` was
**identical** between the two copies, so no live-config decision was
required — only a documentation/label decision.

Rationale for keeping brain's copies in all cases: the `entity: ssint,
env: main, capability: access` labels correctly identify this as
SimpleSalt-proprietary account content, consistent with the other access-tier
objects it's declared alongside (`TrustAccessPolicy`, `TrustAccessApplication`,
the GCP SSO service-account chain) — vs. base-stack's generic
`entity: cluster` labels, which read as cluster-infra rather than
account-specific. `kustomize.toolkit.fluxcd.io/prune: disabled` was dropped
in all cases: that annotation was a defensive artifact of the live
`base-stack`/`brain` dual-ownership flap (two Kustomizations racing to
reconcile — and prune — the same object); with exactly one canonical
declaration in `brain` and no other claimant (now that `cloud-basis` no
longer declares these), it serves no purpose.

**One label correction found by the original audit (simplesalt/projects#183):**
`ClusterIssuer/simplesalt` was migrated with `capability: access`, unlike
every other object above where only `entity`/`env` normalize and
`capability`'s *value* carries over unchanged. Its base-stack counterpart
(`3.infra/certs.yaml`) used `capability: certs` (no `env` field), and
`certs` is a distinct, actively-used SimpleSalt capability value —
base-stack's `cert-manager` Namespace and its `cert-manager` controller
`HelmRelease` (`1.basis/ns.yaml`, `1.basis/controllers.yaml`) both also use
`capability: certs`, separate from `access`/`infra`. Corrected to
`capability: certs` to match. This correction lives in `brain`'s copy now
that `cloud-basis`'s copy has been removed.

**Discrepancy found and NOT resolved by invention:** simplesalt/projects#184
states `TrustAccessIdentityProvider/cf-main-idp-ssint-sso` is "adopted by
external ID `42cbdc64-699e-4e17-b470-fb7cda3c0791`" via
`crossplane.io/external-name`. Checked both source copies
(`brain/manifests/cloudflare-zero-trust-main.yaml` and
`base-stack@named 3.infra/cf-main-idp.yaml`): **neither carries a
`crossplane.io/external-name` annotation on that object.** The UUID
`42cbdc64-…` only appears as a plain value (with an explanatory comment)
inside `TrustAccessApplication/cloudflare-app-appflowy-main`'s
`allowedIdps[]` list — a spec reference, not an adoption annotation. If
adoption-by-external-name was actually intended, it needs to be added
deliberately in `brain` (the current owner) after confirming the value
against the live Cloudflare API — not assumed from this migration.

Final check: `grep` across every remaining file for `^kind:`/`^  name:`
pairs confirms no `apiVersion`/`kind`/`namespace`/`name` tuple repeats
anywhere in this repo, and none intersect `simplesalt/brain`'s tuples (see
"Validation" below).

## `crossplane.io/external-name` annotations carried over (verbatim)

| Object | Value |
|---|---|
| `Bucket/cf-main-backups` | `backups` |
| `KvNamespace/cf-main-kv-sot-test-results` | `b8f5e5a1be0240f6b484b4ab1258a6a8` |
| `KvNamespace/cf-main-kv-sot-test-results-dev` | `05b9f242460f42b1bd29178bf85b2767` |

The `TrustOrganization/cf-main-zero-trust-org`, `TrustAccessPolicy/simplesalt-email-domain`,
`ProjectService/admin-googleapis-com`, and `ServiceAccount/cloudflare-sso-agent`
rows previously listed here were removed along with those objects
(simplesalt/projects#226) — their `crossplane.io/external-name` annotations
now live only in `simplesalt/brain`'s copies.
`TrustAccessIdentityProvider/cf-main-idp-ssint-sso` (also removed) had **no**
`crossplane.io/external-name` annotation in either source copy — see the
discrepancy note above. `TrustAccessApplication/cloudflare-app-appflowy-main`
(also removed) had none by design (Crossplane creates it).

## Unsubstituted `${...}` variables

`${ssint_main_tunnel_id}` was previously listed here. Its only two consumers,
`TrustTunnelCloudflaredConfig/ssint-main-tunnel-config` and
`Record/info-simplesalt-company`, were removed along with
`10-cloudflare/zero-trust.yaml` (simplesalt/projects#226) — see "The dedupe"
above. **No manifest in this repo references `${ssint_main_tunnel_id}`
anymore**; the substitution requirement has left this repo (it may still
apply to `simplesalt/brain`'s copies of those objects, out of scope here).
`10-cloudflare/tunnel.yaml`'s `fetch-ssint-main-tunnel-id` Job still patches
`Secret/ssint-main-tunnel-id` (`flux-system`, key `ssint_main_tunnel_id`)
with the live tunnel ID, but that value currently has no in-repo consumer.
This also means the failure mode simplesalt/projects#235 flagged
(`ssint-main-tunnel-config` reconciling with the literal string
`${ssint_main_tunnel_id}` because no `postBuild.substituteFrom` is wired up)
no longer applies to `cloud-basis` — worth rechecking whether #235 still
applies to `brain`.

`${client_id}` was previously listed here too, sourced from a `flux-system`
placeholder Secret. It was removed independently of the above: `clientId` on
`TrustAccessIdentityProvider/cf-main-idp-ssint-sso` became an inlined
literal (a GCP OAuth2 client_id is a public identifier, not credential
material — simplesalt/projects#236) before that object itself was removed
along with the rest of `10-cloudflare/zero-trust.yaml`.

## Out-of-band secrets (empty on a fresh cluster)

None of these are populated by any manifest in this repo. Each must be
patched manually (or by some other out-of-band automation) before the
resources that depend on them can reconcile:

| Secret | Namespace | Populated how |
|---|---|---|
| `ssint-main-cf` | `crossplane-system` | Raw Cloudflare API token, key `api_token`. The `assemble-cloudflare-credentials-main` Job (`10-cloudflare/creds-job.yaml`) reads this and writes the JSON-wrapped form into `cloudflare-credentials-main`. |
| `cloudflare-credentials-main` | `crossplane-system` | Written by the Job above — indirect, but still ultimately out-of-band via `ssint-main-cf`. |

`gcp-credentials`, `ssint-main-g-idp-secret`, and `ss-acme-cf-token` were
previously listed here; all three were removed along with the objects that
declared them (simplesalt/projects#226) and are now populated out-of-band
against `simplesalt/brain`'s copies instead.

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
failure. It has never applied anywhere. This file is kept only as a
scanned-from-the-API historical reference in case the list-form shape is
wanted again after a provider upgrade; deleting it was considered but
rejected in favor of preserving optionality — flag for review if it's
confirmed dead. The live equivalent
(`TrustAccessIdentityProvider/cf-main-idp-ssint-sso`, object-form config)
previously lived alongside it in this repo's own `10-cloudflare/zero-trust.yaml`,
but that file was removed as a duplicate of `simplesalt/brain`'s copy
(simplesalt/projects#226) — the reconciled, live object now exists only in
`simplesalt/brain` (`manifests/cloudflare-zero-trust-main.yaml`).

## Hardcoded cluster-specific references

The new cluster's name is undecided (simplesalt/projects#216). The
following references to the *current* cluster were carried over unchanged
because inventing a new name is out of scope, and should be revisited once
the new cluster's naming convention is set:

- `10-cloudflare/tunnel-daemon.yaml`: `namespace: cluster-named-routing`
  (`HelmRelease/cloudflared-main`'s target namespace).
- `10-cloudflare/tunnel.yaml`: `namespace: cluster-named-routing` (tunnel
  run-token connection secret) and RBAC in `flux-system`.

The tunnel ingress service target
(`http://big-agi.ssint-main-ai.svc.k.famevans.win:3000`) previously listed
here lived in `10-cloudflare/zero-trust.yaml`, which was removed as a
duplicate of `simplesalt/brain`'s copy (simplesalt/projects#226); that
hardcoded reference now only exists in `brain`.

## Validation

Validated locally with `kustomize build .` using kustomize v5.4.3 — see the
task report for full output. Zero duplicate `kind`/`namespace`/`name`
tuples confirmed across the whole repo (and none shared with
`simplesalt/brain`, per simplesalt/projects#226).

## Explicitly out of scope

- Crossplane *installation* (`Provider`, runtime config, CRDs) — stays in
  `simplesalt/basis` (`cf-providers.yaml`, `cf-runtime.yaml`,
  `gcp-providers.yaml`, `gcp-runtime.yaml`).
- Personal `evans-home` account resources (`Secret/cloudflare-credentials`,
  `ProviderConfig/default` x2, `Bucket/ss-testing`, the personal
  creds-assembler Job) — go to `dylannevans/basis:cloud/`
  (simplesalt/projects#227 — supersedes the earlier `dylannevans/cloud-basis`
  destination named in simplesalt/projects#182, which is closed and unused).
- Any modification to `simplesalt/brain` — it is the canonical owner of the
  14 objects deduplicated out of this repo (simplesalt/projects#226) and was
  left byte-identical by that change. Any further modification to `brain`
  is a separate activity.
- Any modification to `simplesalt/base-stack` — it is being retired
  wholesale in favor of a new cluster bootstrapped against `cloud-basis` and
  its sibling repos directly; retiring its copies of this content is a
  separate, later activity once a live cluster actually subscribes to this
  repo.
- Wiring this repo into any cluster's `flux.repos`/`config.yaml` — that
  lives in a different repo and is out of scope here.
