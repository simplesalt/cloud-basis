# cloud-basis

Cloudflare and Google Workspace/GCP Crossplane resources for the SimpleSalt
proprietary account set (`ssint-main` account `ba92fe12c6c1275f965c7c86e3b392ac`,
GCP project `internalapps-481018`). Intended to be delivered via a chain of
Flux `Kustomization`s (and, upstream, a `FluxInstance`) as part of a larger
cluster stack.

This repo now installs Crossplane itself (simplesalt/projects#567): the
`crossplane-system` namespace, the `crossplane-stable` Helm chart source,
and the `crossplane` `HelmRelease`. It also installs the six Cloudflare and
GCP `Provider` packages it consumes, their two `DeploymentRuntimeConfig`s,
and the CRD-watch `ClusterRole` they need — all moved here from
`simplesalt/basis` (`operators/ns.yaml`, `operators/helmrepos.yaml`,
`operators/controllers.yaml`, `platform/cf-providers.yaml`,
`platform/cf-runtime.yaml`, `platform/gcp-providers.yaml`,
`platform/gcp-runtime.yaml`). Everything is applied in three ordered stages
so a fresh cluster never has one build holding both a CRD-installing object
and objects of the kinds it installs — see "Layout and ordering" below.

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
kustomization.yaml     root: lists only stages.yaml
stages.yaml            three Flux Kustomizations — the stage chain (below)
00-crossplane/         stage 1: Crossplane itself (namespace, chart source, HelmRelease)
10-providers/          stage 2: the Cloudflare/GCP Provider packages + runtime configs
20-resources/          stage 3: managed resources
  provider-configs/    ProviderConfig(s) + backing credential Secret for the ssint-main Cloudflare account
  cloudflare/          ssint-main Cloudflare account: R2, KV, DNS, tunnel
    dux-soup-event-handler/  Dux Soup event handler Worker (Script) + its receiver-key Job
quarantine/            known-broken manifest, deliberately excluded from any build
```

`20-gcp/` (GCP SSO/SCIM support resources) and `30-certs/` (cert-manager
`ClusterIssuer` for simplesalt.company) were removed entirely
(simplesalt/projects#226): every object either directory declared duplicated
one `simplesalt/brain` already declares, and brain is the canonical owner
going forward. See "The dedupe" below.

**The stage chain (simplesalt/projects#567):**

```
ss-basis-operators → ss-cloud-basis-crossplane → ss-cloud-basis-providers → ss-cloud-basis-resources
```

- `ss-basis-operators` is `simplesalt/basis`'s own Kustomization (not in this
  repo) — Kyverno and the scheduling mutation it installs are up before
  anything here starts.
- `ss-cloud-basis-crossplane` (`00-crossplane/`) installs Crossplane. It
  waits on the `crossplane` `HelmRelease` being Ready, *and* on the
  `providers.pkg.crossplane.io` and `deploymentruntimeconfigs.pkg.crossplane.io`
  CRDs being Established — Crossplane's init creates those CRDs without
  waiting for them, so the HelmRelease alone does not guarantee stage 2 can
  apply.
- `ss-cloud-basis-providers` (`10-providers/`) installs the six `Provider`
  packages and their runtime configs. It waits on all six Providers being
  both `Installed` and `Healthy` — a `Provider` has no `Ready` condition, so
  this uses a `healthCheckExprs` CEL expression rather than a plain
  `healthChecks` entry (which would treat the object as healthy the moment
  it exists). There is deliberately no `failed` expression: a provider that
  is briefly unhealthy while starting is waited for, not failed fast.
- `ss-cloud-basis-resources` (`20-resources/`) applies the managed
  resources — `ProviderConfig`s and everything that references them via
  `providerConfigRef`. It has no `healthChecks` of its own; it only needs
  stage 2's Providers to be installed first.

The chain exists because a single flat build holding a `Provider` (or
Crossplane's own CRDs) together with objects of the kinds it installs fails
dry-run on a fresh cluster and never applies — `kustomize build .`'s file
order is not an apply-order guarantee under Flux's server-side apply, so the
guarantee has to come from `dependsOn` + `healthChecks`/`healthCheckExprs`
instead. See `stages.yaml` for the full spec of all three Kustomizations.

**`deletionPolicy: Orphan`:** all three stage Kustomizations set this
(the Flux default, `MirrorPrune`, would delete a removed stage's objects). If
this parent build ever drops or renames a stage, the stage's objects are
orphaned — Flux stops managing them but never deletes them. Between the three stages that protects the production
Cloudflare tunnel, the R2 backup bucket, and `crossplane-system` itself
(deleting it would take every `Provider` and managed resource in the
cluster with it) from a structural refactor of this repo.

**Every object in every stage also carries its own**
**`kustomize.toolkit.fluxcd.io/prune: disabled`.** This is a second,
independent guard, not a duplicate of `deletionPolicy: Orphan`: it protects
against prune during the ownership handoff from `simplesalt/basis` to this
repo specifically. While both repos declare an object, each Flux apply
stamps its own Kustomization's name into the `kustomize.toolkit.fluxcd.io/name`
owner label, so the label flips to whichever applied last and cannot be
relied on to stop a prune while ownership is moving — only the annotation
can, since every copy carries it regardless of who applied last.

## Naming conventions for the consuming cluster config

This repo now contains its own child `Kustomization`s (`stages.yaml`) — the
`00-crossplane`/`10-providers`/`20-resources` chain is entirely internal to
this repo and needs no wiring from the consuming cluster config. What still
lives outside this repo, in the cluster bootstrap config, is the top-level
`GitRepository` and the top-level `Kustomization` that points at this repo's
root (`ss-cloud-basis`, path `./`) — per SimpleSalt's
`<entity>-<clustername>-<capability>` convention (entity prefix `ss`), same
as before.

The top-level `ss-cloud-basis` Kustomization still depends on `ss-basis` (or
whatever `simplesalt/basis`'s top-level Kustomization is actually named) —
that dependency is unchanged. What's new is that stage 1
(`ss-cloud-basis-crossplane`) *also* depends directly on
`ss-basis-operators` rather than only transitively through `ss-basis`:
`ss-basis` does not wait for its own children (`ss-basis-operators`,
`ss-basis-platform`) to be Ready, only for them to exist, so depending on
`ss-basis` alone would not guarantee Kyverno and the scheduling mutation are
actually up before this repo's own Crossplane install starts.

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
`10-cloudflare/zero-trust.yaml`). `20-resources/cloudflare/tunnel.yaml`'s
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
| `Script/dux-soup-event-handler` | `main-dux-soup-event-handler` |

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
`20-resources/cloudflare/tunnel.yaml`'s `fetch-ssint-main-tunnel-id` Job still patches
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
| `ssint-main-cf` | `crossplane-system` | Raw Cloudflare API token, key `api_token`. The `assemble-cloudflare-credentials-main` Job (`20-resources/cloudflare/creds-job.yaml`) reads this and writes the JSON-wrapped form into `cloudflare-credentials-main`. |
| `cloudflare-credentials-main` | `crossplane-system` | Written by the Job above — indirect, but still ultimately out-of-band via `ssint-main-cf`. |

`gcp-credentials`, `ssint-main-g-idp-secret`, and `ss-acme-cf-token` were
previously listed here; all three were removed along with the objects that
declared them (simplesalt/projects#226) and are now populated out-of-band
against `simplesalt/brain`'s copies instead.

`ssint-main-tunnel-id` (`flux-system`) and `ssint-main-tunnel-token`
(`cluster-named-routing`) are also empty placeholders at apply time, but
those ARE self-populating via in-repo Jobs (`fetch-ssint-main-tunnel-id`,
`fetch-ssint-main-tunnel-token` in `20-resources/cloudflare/tunnel.yaml` /
`tunnel-token-job.yaml`) once `TrustTunnelCloudflared/ssint-main-tunnel` is
Ready, so they aren't "out-of-band" in the same sense.

`dux-soup-event-handler` (`crossplane-system`) is the same kind of
self-populating placeholder: its `receiver_key` key is empty at apply time
and is filled by the `derive-dux-soup-receiver-key` Job
(`20-resources/cloudflare/dux-soup-event-handler/receiver-key.yaml`), which
derives it from `ssint-main-msg/duxsoup-api-key` (owned by
`simplesalt/brain`, not this repo). Unlike the tunnel Jobs, it has no
Crossplane condition to wait on — it retries (via `backoffLimit`) until that
Secret exists and is non-empty. Re-trigger after the source API key rotates
by deleting the Job — Flux recreates it. `dux-soup-event-handler-config`
(same namespace) is a sibling Secret but is **not** out-of-band: its keys
are ordinary git-committed `stringData`, not populated by any Job — see
"Dux Soup event handler" below for why non-secret values live in a Secret
at all.

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

- `20-resources/cloudflare/tunnel-daemon.yaml`: `namespace: cluster-named-routing`
  (`HelmRelease/cloudflared-main`'s target namespace).
- `20-resources/cloudflare/tunnel.yaml`: `namespace: cluster-named-routing` (tunnel
  run-token connection secret) and RBAC in `flux-system`.

The tunnel ingress service target
(`http://big-agi.ssint-main-ai.svc.k.famevans.win:3000`) previously listed
here lived in `10-cloudflare/zero-trust.yaml`, which was removed as a
duplicate of `simplesalt/brain`'s copy (simplesalt/projects#226); that
hardcoded reference now only exists in `brain`.

## Dux Soup event handler

`20-resources/cloudflare/dux-soup-event-handler/` takes over the existing,
hand-uploaded Cloudflare Worker `main-dux-soup-event-handler` with a
`Script` managed resource (adopted via `crossplane.io/external-name`, no
`Delete`/`LateInitialize` in `managementPolicies`) so its code deploys from
this repo instead of by hand (simplesalt/projects#595). Dux Soup posts
every webhook event to it through the zone route
`api.simplesalt.company/<token>/dux*`. The Worker:

- answers 405 to anything but POST and 404 unless the first path segment
  hashes to `ROUTE_PATH_SHA256`, and 400 to a body that is not a JSON object;
- hands every JSON-object event, byte-for-byte, to the `EventOutbox`
  Durable Object, which stores it in SQLite before the Worker answers and
  then delivers it, oldest first, to the cluster's Dux Soup receiver at
  `https://hooks.simplesalt.company/duxsoup/events?key=<RECEIVER_KEY>`
  (served by the `ssint-main` tunnel — see `Record/hooks-simplesalt-company`
  in `dns.yaml`). A 2xx deletes the row; 400/413/415/422 moves it to a
  `dead_letter` table; anything else (receiver down, 401, 5xx, network)
  keeps it and retries with exponential backoff capped at 10 minutes;
- keeps received LinkedIn messages (`type: message`, `event: received`)
  exactly as the hand-uploaded version did: same validation, same
  `{topic, payload}` message on queue `main-inmessage-li`, same 202;
- answers every other event 200 `{"status":"forwarded"}` (it used to answer
  400).

The Worker's source, `DuxSoupEventHandler.js`, lives alongside `script.yaml`
in this same directory, with Miniflare tests under `test/` (`npm test`
there). The source must never contain `${` or `%{`: the provider hands the
Script's content to Terraform, which parses every string as a template
(simplesalt/projects#594 hit this), so the handler builds strings by
concatenation and `npm test` first runs `check-source.mjs` to enforce it. The directory's own `kustomization.yaml`
reads that file into a build-time-only `ConfigMap` (`disableNameSuffixHash`,
`config.kubernetes.io/local-config: "true"` so it's never actually applied)
and a `replacements` rule copies its contents into the `Script`'s
`spec.forProvider.content` — so the deployed code always matches the file
in git, without duplicating it into the YAML by hand.

Two values never appear in git: the zone-side route path token itself (the
route that embeds it is managed directly in Cloudflare, outside this repo)
and `RECEIVER_KEY`, the HMAC derived from the receiver's Dux Soup API key.
Only the route token's SHA-256 (`ROUTE_PATH_SHA256`) is committed, so the
Worker can verify a request's path without the token ever being readable
from this repo. `RECEIVER_KEY` is filled by the `derive-dux-soup-receiver-key`
Job the same way the tunnel token/id Secrets are (see "Out-of-band secrets"
above).

`BRANCH`, `ROUTE_PATH_SHA256`, and `RECEIVER_URL` are ordinary, non-secret
configuration — but the installed `Script` CRD
(`provider-cloudflare-workers:v0.2.6`) only exposes a text-valued binding
through `textSecretRef` (a Kubernetes Secret reference), for both
`plain_text` and `secret_text` binding types alike; there is no plain string
field. So these three values are held in a plaintext, git-committed Secret
(`dux-soup-event-handler-config`) purely to satisfy that shape, not because
they're sensitive.

**`observability` is spelled out in full on purpose.** The provider treats
`observability` and its `logs` as plain optional fields and reads back
everything Cloudflare returns, so a spec that sets only `enabled: true`
never matches and the provider re-uploads the Worker every few seconds
(it did on 2026-09-29, until commit eac37ec paused updates). Keep the spec
equal to what `status.atProvider.observability` shows.

**The `Script` deliberately carries no `migrations`.** The `EventOutbox`
Durable Object class was created on 2026-09-29 by a one-off
`migrations: {newTag: v1, newSqliteClasses: [EventOutbox]}` (commit
5ab8ecd), and the Worker now sits at migration tag `v1`. The provider
resends whatever `migrations` the spec holds on every update, and Cloudflare
rejects a migration whose tag precondition does not match ("Actor migration
tag precondition failed"), so leaving it in made every later update fail.
If the Worker is ever recreated from scratch, or a Durable Object class is
added or renamed, put a single migration back for one reconcile and remove
it again once the `Script` reports `Synced=True`.

## Validation

Validated locally with `kustomize build .` (kustomize v5.7.1), per-stage:

- Root `kustomize build .` renders exactly the three stage `Kustomization`s
  in `stages.yaml`, correctly ordered/configured (`dependsOn`, `healthChecks`,
  `healthCheckExprs`, `deletionPolicy: Orphan`, `prune: true`).
- `kustomize build 00-crossplane`, `kustomize build 10-providers`, and
  `kustomize build 20-resources` each build cleanly; their kinds fall
  entirely within the expected apiGroups per stage (stage 1: core,
  `source.toolkit.fluxcd.io`, `helm.toolkit.fluxcd.io`; stage 2:
  `pkg.crossplane.io`, `rbac.authorization.k8s.io`; stage 3: core,
  `rbac.authorization.k8s.io`, `batch`, `helm.toolkit.fluxcd.io`, and the
  `*.upbound.io` Crossplane-managed-resource groups) — confirming no stage
  mixes a CRD-installing object with objects of the kinds it installs.
- `kustomize build 20-resources` renders the same 27 objects, JSON-identical,
  as `kustomize build .` did at the pre-split commit (simplesalt/projects#567)
  — the split changed nothing about what the managed-resources stage applies.
- The twelve objects moved from `simplesalt/basis` (three in `00-crossplane/`,
  nine in `10-providers/`) render identical, as JSON with sorted keys, to the
  same objects built from `simplesalt/basis` `operators/` and `platform/` at
  the commit they were copied from (simplesalt/projects#567) — the move
  changed nothing about the objects themselves.
- All 50 objects across the three stage builds carry
  `kustomize.toolkit.fluxcd.io/prune: disabled`.
- Zero duplicate `kind`/`namespace`/`name` tuples confirmed across the whole
  repo (and none shared with `simplesalt/brain`, per simplesalt/projects#226).
- `20-resources/cloudflare/dux-soup-event-handler/`'s own `kustomization.yaml`
  builds cleanly standalone and as part of `20-resources`/`.`; its
  `configMapGenerator` output (`ConfigMap/dux-soup-event-handler-source`,
  local-config annotated) never appears in any of these builds, and the
  `replacements`-copied `Script/dux-soup-event-handler`
  `spec.forProvider.content` is byte-identical to
  `DuxSoupEventHandler.js`. The rendered `Script`'s `spec` was checked
  against the live `scripts.workers.upjet-cloudflare.m.upbound.io` CRD's
  `openAPIV3Schema` with a small stdlib-only Python checker (types,
  `required`, `enum`) — no `jsonschema`/`kubeconform` available in the
  validation environment.

## Explicitly out of scope

- The Cloudflare provider family package
  (`wildbitca-provider-family-cloudflare`) is still installed implicitly as
  a dependency of the four `provider-cloudflare-*` packages in
  `10-providers/cf-providers.yaml`; its version is not pinned here
  (Crossplane resolves it itself).
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
