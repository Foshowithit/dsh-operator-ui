# bounded-research 0.1.0 (candidate)

K4 outcome pack from the K2 `bounded-research` brief (outcome inspired by
liustack/modsearch; no upstream code copied, link-out only). Query in,
cited passages out — every fetch recorded with bytes, digest, and timestamp,
every failure recorded as a refusal.

## Contract

`contract.json` (`rcos-capability-contract/1`): input `{query ≤280 chars,
urls[1..5], allowlist[1..16 hosts], timeoutMs?}`, output
`bounded-research-observation/1` with `passages[]` (url, host, scheme,
status, bytes, sha256, fetchedAt, excerpt ≤500 chars, termHit) and
`refused[]` (url, reason). Refusal reasons: off-allowlist (refused before
any fetch), insecure-scheme, empty query/urls, http errors, timeout,
non-text or oversize payloads, empty bodies, redirect off the allowlist.

## Adapter

`adapter/run.cjs` (sha256 `246b077f…e1fd5`): RCOS kernel env
(`RCOS_INPUT`/`RCOS_OUTPUT`/`RCOS_EVIDENCE_DIR`) or `--input/--out/
--evidence-dir` flags. Exit 0 on valid input even when everything is
refused; exit 2 on malformed input or an unusable evidence dir. GET only,
8s default timeout, 256KB cap, 3 same-allowlist redirects, no cookies.

## Evals

`evals/run-eval.js` (+ `fixture-server.cjs`, loopback-only, spawned as its
own process so the parent's `spawnSync` cannot starve it): 8 cases, PASS,
plus a `--negative` control that FAILs as required (exit 1). Evidence dir
per case holds raw bodies, the input echo, and the fetch log; passage
digests are recomputed independently.

## Binding status

`workflow: null` — candidate only. B2 `selectCapability` refuses it with
`absent-binding` today; binding arrives when a supported archon-workflow
exists. This entry alone installs, promotes, and proves nothing.
