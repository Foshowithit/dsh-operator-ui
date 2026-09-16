// dsh-operator-ui — authority contract (permissions round).
//
// GPT refinement: permission levels are NOT four global modes. They are
// operator personalities (presets) over a lower-level authority contract:
// scopes. A capability declares what it REQUIRES; the operator's preset
// pre-authorizes (grants) a subset; a task carries the granted policy it ran
// under. The SAME contract renders Preview ("RCOS plans to …") and Prove
// ("RCOS did …") — one vocabulary, two tenses.
//
// Scopes (v1, fixed vocabulary — `domain:action`):
//   filesystem:read/write  shell:execute  network:outbound
//   browser:read/interact  credentials:use (NAMED references only, never values)
//   git:read/modify/push   external:draft/submit
// (physical:observe/control is reserved for later milestones.)
//
// Presets (personalities over scopes — what each pre-authorizes):
//   PLAN_ONLY          grants nothing — every execution needs explicit approval
//   ASK_BEFORE_ACTION  pre-authorizes read-only-ish scopes; writes, execution,
//                      pushes, submits, and credential use need approval
//   AUTO_WITHIN_POLICY pre-authorizes everything except the irreversible /
//                      external trio (credentials:use, git:push, external:submit)
//   FULL_ACCESS        pre-authorizes every v1 scope — still bound by
//                      capability/runtime safety (seeded capabilities never
//                      route to goals, retired capabilities never route, the
//                      registry is still required).
//
// Fail-closed: a capability that declares an UNKNOWN scope can never
// auto-dispatch — it always needs explicit approval, with the reason named.

export const SCOPES = [
  'filesystem:read',
  'filesystem:write',
  'shell:execute',
  'network:outbound',
  'browser:read',
  'browser:interact',
  'credentials:use',
  'git:read',
  'git:modify',
  'git:push',
  'external:draft',
  'external:submit',
];

export const PRESETS = ['PLAN_ONLY', 'ASK_BEFORE_ACTION', 'AUTO_WITHIN_POLICY', 'FULL_ACCESS'];

// Normal language for Preview/Prove lines ("RCOS plans to Read files ✓").
const HUMAN = {
  'filesystem:read': 'Read files',
  'filesystem:write': 'Modify files',
  'shell:execute': 'Run commands',
  'network:outbound': 'Reach the network',
  'browser:read': 'Read browser pages',
  'browser:interact': 'Drive browser pages',
  'credentials:use': 'Use named credentials',
  'git:read': 'Read repositories',
  'git:modify': 'Modify repositories',
  'git:push': 'Push to remotes',
  'external:draft': 'Draft external actions',
  'external:submit': 'Submit external actions',
};

export function humanScope(scope) {
  return HUMAN[scope] || String(scope);
}

// Operator personalities in normal language (Preview/Prove headers).
const PRESET_LABEL = {
  PLAN_ONLY: 'Plan only',
  ASK_BEFORE_ACTION: 'Ask before acting',
  AUTO_WITHIN_POLICY: 'Auto within policy',
  FULL_ACCESS: 'Full access',
};

export function humanPreset(preset) {
  return PRESET_LABEL[preset] || String(preset);
}

const ASK_GRANTS = new Set([
  'filesystem:read',
  'git:read',
  'browser:read',
  'network:outbound',
  'external:draft',
]);

const AUTO_HOLDOUTS = new Set(['credentials:use', 'git:push', 'external:submit']);

export function grantsFor(preset) {
  if (preset === 'FULL_ACCESS') return new Set(SCOPES);
  if (preset === 'AUTO_WITHIN_POLICY') return new Set(SCOPES.filter((s) => !AUTO_HOLDOUTS.has(s)));
  if (preset === 'ASK_BEFORE_ACTION') return new Set(ASK_GRANTS);
  return new Set(); // PLAN_ONLY (and anything unknown): pre-authorize nothing
}

// What a capability requires: the optional `requires` array on the registry
// entry. Absent/non-array = requires nothing. Unknown scope strings are
// returned separately so the caller can fail closed on them.
export function requiresOf(capability) {
  const raw = capability && capability.requires;
  const list = Array.isArray(raw) ? raw.map((s) => String(s)) : [];
  return {
    requires: list,
    unknown: list.filter((s) => !SCOPES.includes(s)),
  };
}

// The authority decision for one task: { mode, granted, missing, reason }.
// mode 'auto' = dispatch now under the preset's standing grant; mode
// 'approval' = seal awaiting-approval and render Preview instead.
export function decisionFor(preset, requires, unknown) {
  const granted = grantsFor(preset);
  if (preset === 'PLAN_ONLY') {
    return {
      mode: 'approval',
      granted: [],
      missing: requires.slice(),
      reason: 'PLAN_ONLY preset pre-authorizes nothing — every execution needs explicit approval',
    };
  }
  if ((unknown || []).length > 0) {
    return {
      mode: 'approval',
      granted: requires.filter((s) => granted.has(s)),
      missing: requires.filter((s) => !granted.has(s)),
      reason: 'capability declares unknown scope(s) ' + unknown.join(', ') + ' — failing closed to explicit approval',
    };
  }
  const missing = requires.filter((s) => !granted.has(s));
  if (missing.length === 0) {
    return {
      mode: 'auto',
      granted: requires.slice(),
      missing: [],
      reason: requires.length
        ? 'every required scope is pre-authorized by ' + preset
        : 'the capability requires no authority beyond execution itself',
    };
  }
  return {
    mode: 'approval',
    granted: requires.filter((s) => granted.has(s)),
    missing,
    reason: preset + ' does not pre-authorize ' + missing.map(humanScope).join(', ') + ' — approval required',
  };
}
