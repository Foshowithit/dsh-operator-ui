# Third-party plugin discovery contract

Status: B1a source audit, 2026-09-28. This contract is for external discovery
only. It does not add a runtime adapter, canonical capability record, plugin
installer, or execution authority.

## Source findings

| Source | Documented behavior | RCOS treatment |
| --- | --- | --- |
| [dshfind.com](https://dshfind.com), source [hikariming/dshfind at `6be2b8f`](https://github.com/hikariming/dshfind/tree/6be2b8f653595483e14303e457afe97affd4548d) | Its pinned [Public Data API and Query Guide](https://github.com/hikariming/dshfind/blob/6be2b8f653595483e14303e457afe97affd4548d/docs/api-query.md) documents public read-only REST and GraphQL APIs. REST includes paginated `GET /v1/plugins` (`page`, `per_page`, snapshot-pinned `data_version`, and `409 stale_data` on cross-snapshot page fetches), full-catalog `GET /v1/catalog`, details, and HTTP ETag revalidation. The GraphQL `plugins` connection uses opaque cursors bound to `dataVersion` and query shape. The desktop-market interface has `GET /market/manifest.json` plus schema-versioned, cursor-paginated `GET /market/v1/plugins` (`catalog-provider-page` 1.0.0); the API guide says it is a fixed field whitelist. Dataset snapshots expose a content-hash `data_version` and `as_of`; stable plugin ID is `owner/repo`. `is_plugin` is nullable, and `is_official` is explicitly an editorial flag, not GitHub verification. No repository license or API/data license granting reuse was found at the pinned revision. | Documented API contracts exist, but rights to reuse the dataset are unresolved. Link out only unless its terms/license are clarified. Public unauthenticated access is not itself a reuse grant. Keep directory scores, `is_plugin`, install probes, compatibility declarations, and editorial flags as source claims, not RCOS proof. |
| [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com), source [awesome-dsh-plugin/awesome-dsh-plugin at `4c4167f`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/tree/4c4167fa0dc992395f8d9c56cfb27e1f812ddb33) | Repository declares CC0-1.0. Its public static [`plugins.json`](https://awesome-dsh-plugin.com/plugins.json) is explicitly documented as the dataset consumed by dsh-market. On 2026-09-28 the endpoint returned HTTP 200, `application/json`, `Access-Control-Allow-Origin: *`, a 600-second cache, an ETag and `Last-Modified`; top-level fields were `name`, `url`, `source`, `updated`, `count`, `categories`, `plugins` (4,382 entries). Plugin objects included `name`, `owner`, `url`, `page`, `category`, bilingual `description`, `npm`, `version`, `stars`, download counts and date fields, `install`, `added`, and optional `capabilities`, `capabilityRedLines`, `capabilityCheckedAt`, `screenshots`, `tarball`. | This is the only source inspected with both an explicit machine-readable dataset and a repository-level reuse license. A future read-only adapter may consume a pinned/validated projection of this JSON under CC0, subject to source attribution and the rights limits below. It is a static whole-catalog document, not a paginated or versioned API: no schema version, stable record ID, cursor, or canonical duplicate-resolution rule was found. Treat its shape and freshness as mutable; do not poll or assume a stale copy is current. |
| [dshmarket.com](https://dshmarket.com), source [dsh-market/dsh-market at `42e55f0`](https://github.com/dsh-market/dsh-market/tree/42e55f03c883fc301374436a534eceb398f70f33) | First-party README says the Market fetches `awesome-dsh-plugin.com/plugins.json` live on each open, has no bundled fallback snapshot, and derives the catalog from that source. Its own code is MIT-licensed. The separately documented `/dsh-market/api/v1/*` is a **beta plugin-update API**, not a public catalog API; its own contract says response shapes may change until `capabilities.stability` is `stable`. | Link out to the Market UI or upstream dataset. Do not treat Market UI/private responses or its update API as an RCOS catalog API. No independent dataset license or pagination contract is published by the Market. |

The observed `plugins.json` content is not a stable compatibility contract. In
particular, the `capabilities` array and `capabilityRedLines` fields are
third-party directory metadata, not RCOS task capabilities, permission scopes,
or an audited security result. The dshfind API documents richer fields such as
`is_plugin`, scores, and install probes, but these remain dshfind-owned
observations, not RCOS proof. Publisher-declared DSH ranges, if separately
obtained from a package manifest, remain declared metadata. Independently
tested host versions require RCOS-owned evidence tied to the exact plugin
package/version/digest and tested DSH/tools build.

The maintainer post supplied for this task
([X status 2104565558712959065](https://x.com/tianyi/status/2104565558712959065))
could not be fetched or independently verified. Its reported plugin-use
percentage and future API-stabilization intent remain attributed, unverified
context and do not establish adoption, a stable interface, or permission to
ingest data.

## DSH plugin trust and install boundary

The audited DSH source target is tag `dsh-v0.2.0-rc.1`, commit
[`4878cdabd87d4041bdaff61d04c966883b9fd07a`](https://github.com/deepseek-ai/deepseek-harness/tree/4878cdabd87d4041bdaff61d04c966883b9fd07a).
Its [CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/apps/cli/reference/README.md)
documents `dsh plugin --profile <name> <args...>` as forwarding package-manager
arguments to pnpm in the profile. A bundle is an npm package whose
`package.json` declares `dsh.bundle`; the profile manifest's `dsh.profile`
lists installed bundles. DSH composes their patches and mounts their plugins.
The [publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/docs/user/develop/basic/publish.md)
also explains that source packages with `prepare` scripts may require the user
to allow install-time builds under pnpm 10+.

DSH's own [safety statement](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/SAFETY.md)
says DSH can load third-party plugins and access network, processes,
credentials, and files available to it; sandboxing, approval prompts, and
permission controls do not guarantee isolation. Install-time build approval is
not a runtime sandbox. Therefore plugin code may have the DSH process's host
access and can affect host configuration through its bundle patch. Operator
does not audit, sandbox, grant, or limit those plugin privileges. The user's
choice to install a plugin through DSH is separate from RCOS task admission.
Directory inclusion, popularity, or an install command is not an endorsement.

## Separate listing and capability records

Discovery output, if later integrated, must use a separate external-listing
type. It is not an entry in the canonical RCOS capability registry and must
never be cast, copied, or promoted into one automatically.

```ts
type ExternalPluginListing = {
  source: 'awesome-dsh-plugin' | 'dshfind' | 'dshmarket';
  sourceRef: { url: string; listingKey: string | null; dataVersion: string | null };
  // listingKey locates a row inside this source; it is not a canonical ID.
  sourceDigest: string | null;        // SHA-256 of acquired catalog snapshot bytes, or null
  fetchedAt: string;                  // collector time; distinct from sourceAsOf
  sourceAsOf: string | null;          // source snapshot's updated/as_of time, when supplied
  publisher: string | null;
  name: string;
  description: string | null;
  category: string | null;
  repositoryUrl: string | null;
  listingUrl: string | null;
  packageSpec: string | null;
  declaredDshRange: { value: string; evidenceUrl: string } | null;
};
```

The listing is untrusted display metadata. It cannot supply tested host
versions, canonical capability links, or readiness. Those values belong in a
separate host-owned observation with exact identities:

```ts
type PluginHostObservation = {
  // Here sourceDigest identifies exact plugin artifact/source bytes, never a catalog snapshot.
  plugin: { packageName: string; version: string; sourceDigest: string };
  host: { dshVersion: string; dshToolsVersion: string };
  compatibility: 'pass' | 'fail' | 'unknown';
  evidence: { id: string; sourceDigest: string; url: string; observedAt: string } | null;
};

type CanonicalCapabilityLink = {
  capability: { id: string; version: string; sourceDigest: string };
  plugin: { packageName: string; version: string; sourceDigest: string };
  evidenceId: string;
};
```

Only a host-owned compatibility observation whose plugin package, version,
source digest, DSH version, and dsh-tools version match the exact target may
support tested-host evidence. Missing or mismatched identity/evidence stays
unknown. Canonical mapping requires an explicit host-owned link with the
canonical record's `sourceDigest`; publisher or directory fields cannot create
that link. Any later UI readiness label is a display-only conclusion over
those observations. It must never be passed as B1 `eligible` or treated as
dispatch authorization.

This transport/display schema does not change B1's supported executable
binding, which is only `{ kind: 'archon-workflow', workflowName }` in
[`CAPABILITY-VIEW-CONTRACT.md`](CAPABILITY-VIEW-CONTRACT.md). A DSH-native tool
or UI plugin can be useful host functionality without being a task-level RCOS
capability. Turning one into a task capability requires a separately reviewed
input/output contract, explicit execution binding, prerequisites and
permissions, exact source/version, and independent evaluations. Until such a
binding exists, keep it as a link or display-only listing. A plugin ID,
manifest, directory label, install state, or host tool name must not invent
`workflowName`, task authority, or an execution result.

For a future adapter, the narrow data projection allowed from the CC0 dataset
is publisher/name, description, category, repository/listing links, package
spec/version, star/download counts with their supplied observation dates, and
the source snapshot's `updated`/`as_of` value. Preserve a source reference and
SHA-256 of acquired catalog snapshot bytes separately from collector
`fetchedAt`; do not substitute plugin artifact bytes for the catalog digest.
Do not convert `install` into an executable action, counts into readiness, or
directory `capabilities` into RCOS permissions or capabilities.
Do not import plugin code, fetch README or package content automatically, or
install from this adapter. The CC0 notice is for the directory repository's
work; it does not license linked plugin code, grant trademark rights, or prove
that every submitted third-party text/image was authorized by its contributor.

No canonical record identity is supplied by these sources. An adapter must
not silently merge collisions by name, package name, URL, stars, or description.
Keep source-specific rows distinct and surface ambiguous matches; use a
canonical capability identity only after a separate registry record is
explicitly linked and verified. Missing or stale listing data yields unknown
or unavailable, never an empty success or inherited verification.

## Adapter acceptance cases

Any later ingestion work must test at least these cases before UI wiring:

- Keep dshfind link-only while its API/data reuse rights remain unresolved,
  even though its pinned source documents public REST/GraphQL endpoints.
- If rights are later established and a dshfind paginated adapter is approved,
  pin page one `data_version` across every page; on `409 stale_data`, discard
  the whole collection and restart from page one. For `/v1/catalog`, verify
  the returned `data_version` against the requested version because the
  documented stale-version path may serve the current snapshot instead.
- Reject a missing/wrong-shaped dataset, a non-array `plugins`, invalid
  required fields, and a `count` that disagrees with the array; never present
  partial input as a complete catalog.
- Accept unknown optional fields without treating them as authority. Keep
  source freshness (`updated`, cache validators, fetched time) distinct from
  per-entry download/capability check dates.
- Preserve two records sharing a name or repository and report the ambiguity;
  never fabricate a stable ID or join either record to a canonical capability
  based on fuzzy matching.
- Keep publisher-declared compatibility separate from host-owned evidence.
  A listing row cannot supply tested host versions, canonical capability
  links, or readiness. Missing range or test evidence stays unknown.
- Require host observations to match exact plugin package, version, source
  digest, DSH version, and dsh-tools version. A mismatched version/digest or
  missing evidence ID must not count as tested compatibility. Canonical links
  must also match the capability's exact ID, version, and `sourceDigest`.
- Keep any external-listing readiness label out of B1 `eligible`; test that a
  publisher's `is_plugin`, score, `capabilities`, install probe, or claimed
  compatibility cannot create canonical identity, verification, permission,
  or dispatch authority.
- Treat absent, stale, failed, or oversized source responses as unavailable;
  do not silently substitute a prior snapshot or mark an empty result current.
- Ensure no listing can invoke install/update/remove, run a build, import
  community code, emit an admission decision, or grant execution authority.
- Verify that DSH installation remains an explicit user action in DSH's own
  plugin flow, separate from an RCOS-selected task's admission and approval.
