const VIEW_SCHEMA = 'operator-capability-view/1';
const OBSERVATION_SCHEMA = 'operator-capability-observations/1';
const MAX_TEXT = 180;
const MAX_REASONS = 8;
const MAX_ERRORS = 100;
const UNKNOWN = (reason) => ({ state: 'unknown', reasons: [reason] });

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : fallback;
}

function error(code, message) {
  return { code, message: message.slice(0, MAX_TEXT) };
}

function addError(errors, code, message) {
  if (errors.length < MAX_ERRORS) errors.push(error(code, message));
}

// Inspect descriptors instead of reading properties. This accepts ordinary
// JSON-like data and null-prototype records while refusing getters, hidden
// fields, symbols, sparse/special arrays, cycles, and unsupported values.
function inspectJsonLike(root) {
  const seen = new Set();
  let nodes = 0;
  const visit = (value, depth) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || depth > 16 || ++nodes > 12000 || seen.has(value)) return false;
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) return false;
        const keys = Reflect.ownKeys(value);
        const length = Object.getOwnPropertyDescriptor(value, 'length');
        if (!length || length.enumerable || length.get || length.set || !Number.isSafeInteger(length.value) || keys.length !== length.value + 1) return false;
        for (let index = 0; index < length.value; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
        }
        return keys.every((key) => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < length.value));
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (typeof key !== 'string') return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  return visit(root, 0);
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return { present: false, invalid: false };
    return descriptor && descriptor.enumerable && !descriptor.get && !descriptor.set && Object.hasOwn(descriptor, 'value')
      ? { present: true, value: descriptor.value }
      : { present: true, invalid: true };
  } catch {
    return { present: true, invalid: true };
  }
}

function hasOnlyKeys(object, allowed) {
  try {
    return Reflect.ownKeys(object).every((key) => typeof key === 'string' && allowed.includes(key));
  } catch {
    return false;
  }
}

function safeRecordShape(object) {
  try {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeArrayShape(array) {
  try {
    if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype) return false;
    const length = Object.getOwnPropertyDescriptor(array, 'length');
    if (!length || length.enumerable || length.get || length.set || !Number.isSafeInteger(length.value)) return false;
    const keys = Reflect.ownKeys(array);
    if (keys.length !== length.value + 1) return false;
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) return false;
    }
    return keys.every((key) => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < length.value));
  } catch {
    return false;
  }
}

function validNonblank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function identityKey(id, version) {
  return JSON.stringify([id, version]);
}

function parseFact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasOnlyKeys(value, ['state', 'reasons'])) return null;
  const state = ownData(value, 'state');
  const reasons = ownData(value, 'reasons');
  if (!state.present || state.invalid || !['yes', 'no', 'unknown'].includes(state.value) ||
      !reasons.present || reasons.invalid || !Array.isArray(reasons.value) ||
      !reasons.value.every((reason) => typeof reason === 'string')) return null;
  return { state: state.value, reasons: reasons.value.slice(0, MAX_REASONS).map((reason) => cleanText(reason)) };
}

function factWithReason(state, reason) {
  return { state, reasons: [reason] };
}

function combineReasons(...facts) {
  const seen = new Set();
  const reasons = [];
  for (const fact of facts) for (const reason of fact.reasons) {
    if (reason && !seen.has(reason) && reasons.length < MAX_REASONS) {
      seen.add(reason);
      reasons.push(reason);
    }
  }
  return reasons;
}

function triState(facts, yesReason, noReason, unknownReason) {
  if (facts.some((fact) => fact.state === 'no')) return { state: 'no', reasons: combineReasons(...facts, factWithReason('no', noReason)) };
  if (facts.some((fact) => fact.state === 'unknown')) return { state: 'unknown', reasons: combineReasons(...facts, factWithReason('unknown', unknownReason)) };
  return { state: 'yes', reasons: combineReasons(...facts, factWithReason('yes', yesReason)) };
}

function parseRegistry(registry, errors) {
  if (!safeRecordShape(registry)) {
    addError(errors, 'invalid-registry', 'Registry is missing or is not safe JSON-like data.');
    return null;
  }
  const marker = ownData(registry, 'registry_version');
  const capabilities = ownData(registry, 'capabilities');
  if (!marker.present || marker.invalid || marker.value !== 'v1' || !capabilities.present || capabilities.invalid || !safeArrayShape(capabilities.value)) {
    addError(errors, 'unsupported-registry-schema', 'Registry must declare registry_version v1 and a capabilities array.');
    return null;
  }
  return capabilities.value;
}

function parseObservations(observations, errors) {
  if (observations === undefined) return null;
  if (!observations || typeof observations !== 'object' || Array.isArray(observations) || !inspectJsonLike(observations)) {
    addError(errors, 'invalid-observations', 'Observations are not safe JSON-like data; readiness remains unknown.');
    return null;
  }
  const topAllowed = ['schema', 'runtime', 'workflowCatalog', 'capabilities'];
  if (!hasOnlyKeys(observations, topAllowed)) {
    addError(errors, 'invalid-observations-schema', 'Observations contain fields outside the supported schema.');
    return null;
  }
  const schema = ownData(observations, 'schema');
  if (!schema.present || schema.invalid || schema.value !== OBSERVATION_SCHEMA) {
    addError(errors, 'unsupported-observations-schema', 'Observations must declare operator-capability-observations/1.');
    return null;
  }
  const runtimeData = ownData(observations, 'runtime');
  const catalogData = ownData(observations, 'workflowCatalog');
  const capabilitiesData = ownData(observations, 'capabilities');
  let runtime = UNKNOWN('Runtime compatibility has not been established.');
  let catalog = { state: 'unknown', names: [], reasons: ['Workflow catalog freshness or availability has not been established.'] };
  const byIdentity = new Map();
  if (runtimeData.present && !runtimeData.invalid && runtimeData.value && typeof runtimeData.value === 'object' && !Array.isArray(runtimeData.value) && hasOnlyKeys(runtimeData.value, ['compatible'])) {
    const compatible = ownData(runtimeData.value, 'compatible');
    const parsed = compatible.present && !compatible.invalid ? parseFact(compatible.value) : null;
    if (parsed) runtime = parsed;
    else addError(errors, 'invalid-runtime-fact', 'Runtime compatibility fact is malformed.');
  } else addError(errors, 'invalid-runtime-observation', 'Runtime compatibility observation is missing or malformed.');

  if (catalogData.present && !catalogData.invalid && catalogData.value && typeof catalogData.value === 'object' && !Array.isArray(catalogData.value) && hasOnlyKeys(catalogData.value, ['state', 'names', 'reasons'])) {
    const state = ownData(catalogData.value, 'state');
    const names = ownData(catalogData.value, 'names');
    const reasons = ownData(catalogData.value, 'reasons');
    if (state.present && !state.invalid && ['available', 'unavailable', 'unknown'].includes(state.value) &&
        names.present && !names.invalid && Array.isArray(names.value) && names.value.every(validNonblank) &&
        reasons.present && !reasons.invalid && Array.isArray(reasons.value) && reasons.value.every((reason) => typeof reason === 'string')) {
      catalog = { state: state.value, names: state.value === 'available' ? names.value.slice() : [], reasons: reasons.value.slice(0, MAX_REASONS).map((reason) => cleanText(reason)) };
    } else addError(errors, 'invalid-workflow-catalog', 'Workflow catalog observation is malformed.');
  } else addError(errors, 'invalid-workflow-catalog', 'Workflow catalog observation is missing or malformed.');

  if (!capabilitiesData.present || capabilitiesData.invalid || !Array.isArray(capabilitiesData.value)) {
    addError(errors, 'invalid-capability-observations', 'Capability observations must be an array.');
  } else {
    const candidates = new Map();
    for (const item of capabilitiesData.value) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !hasOnlyKeys(item, ['id', 'version', 'sourceDigest', 'installed', 'verified', 'dependencies', 'authority'])) {
        addError(errors, 'invalid-capability-observation', 'A capability observation is malformed.');
        continue;
      }
      const id = ownData(item, 'id');
      const version = ownData(item, 'version');
      const digest = ownData(item, 'sourceDigest');
      if (!id.present || id.invalid || !validNonblank(id.value) || !version.present || version.invalid || !validNonblank(version.value) ||
          (digest.present && (digest.invalid || (digest.value !== null && !validNonblank(digest.value))))) {
        addError(errors, 'invalid-capability-observation', 'A capability observation has invalid identity fields.');
        continue;
      }
      const identity = identityKey(id.value, version.value);
      const observation = {
        id: id.value, version: version.value,
        sourceDigest: digest.present && typeof digest.value === 'string' ? digest.value : null,
        installed: parseFact(ownData(item, 'installed').value),
        verified: parseFact(ownData(item, 'verified').value),
        authority: parseFact(ownData(item, 'authority').value),
        dependencies: new Map(), dependencyMalformed: false,
      };
      for (const [field, factName] of [['installed', 'installed'], ['verified', 'verified'], ['authority', 'authority']]) {
        const fieldData = ownData(item, field);
        observation[factName] = fieldData.present && !fieldData.invalid ? parseFact(fieldData.value) : null;
        if (!observation[factName]) addError(errors, 'invalid-observation-fact', 'Capability observation contains a malformed ' + field + ' fact.');
      }
      const dependencies = ownData(item, 'dependencies');
      if (!dependencies.present || dependencies.invalid || !Array.isArray(dependencies.value)) {
        observation.dependencyMalformed = true;
        addError(errors, 'invalid-observation-dependencies', 'Capability dependency facts are missing or malformed.');
      } else for (const dependency of dependencies.value) {
        if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency) || !hasOnlyKeys(dependency, ['name', 'fact'])) {
          observation.dependencyMalformed = true;
          addError(errors, 'invalid-observation-dependencies', 'A capability dependency fact is malformed.');
          continue;
        }
        const name = ownData(dependency, 'name');
        const factData = ownData(dependency, 'fact');
        const parsed = factData.present && !factData.invalid ? parseFact(factData.value) : null;
        if (!name.present || name.invalid || !validNonblank(name.value) || !parsed || observation.dependencies.has(name.value)) {
          observation.dependencyMalformed = true;
          addError(errors, 'invalid-observation-dependencies', 'A capability dependency fact is invalid or duplicated.');
          continue;
        }
        observation.dependencies.set(name.value, parsed);
      }
      if (!candidates.has(identity)) candidates.set(identity, []);
      candidates.get(identity).push(observation);
    }
    for (const [identity, matches] of candidates) {
      if (matches.length !== 1) addError(errors, 'duplicate-observation-identity', 'Duplicate capability observation identity was rejected.');
      else byIdentity.set(identity, matches[0]);
    }
  }
  return { runtime, catalog, byIdentity };
}

function unknownObservationFact(observation, field, reason) {
  return observation && observation[field] ? observation[field] : UNKNOWN(reason);
}

function dependencyReadiness(record, observation, errors) {
  const data = ownData(record, 'dependencies');
  if (!data.present || data.invalid || !Array.isArray(data.value)) {
    if (data.present) addError(errors, 'invalid-dependencies', 'Capability dependency declaration is malformed.');
    return UNKNOWN('Machine dependency declaration is missing or malformed.');
  }
  const names = [];
  for (const dependency of data.value) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency) || !inspectJsonLike(dependency) || !hasOnlyKeys(dependency, ['name'])) {
      addError(errors, 'invalid-dependencies', 'A machine dependency declaration is malformed.');
      return UNKNOWN('Machine dependency declaration is malformed.');
    }
    const name = ownData(dependency, 'name');
    if (!name.present || name.invalid || !validNonblank(name.value)) {
      addError(errors, 'invalid-dependencies', 'A machine dependency declaration has no valid name.');
      return UNKNOWN('Machine dependency declaration is malformed.');
    }
    if (names.includes(name.value)) {
      addError(errors, 'duplicate-dependency', 'Machine dependency declaration contains a duplicate name.');
      return UNKNOWN('Machine dependency declaration is ambiguous.');
    }
    names.push(name.value);
  }
  if (names.length === 0) return factWithReason('yes', 'No additional machine dependencies are declared.');
  if (!observation || observation.dependencyMalformed) return UNKNOWN('Machine dependency availability has not been established.');
  const facts = names.map((name) => observation.dependencies.get(name) || UNKNOWN('Dependency ' + name.slice(0, 80) + ' has no current availability fact.'));
  return triState(facts, 'All declared machine dependencies are available.', 'A declared machine dependency is unavailable.', 'Machine dependency availability is incomplete.');
}

function projectRecord(record, observations, errors) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !inspectJsonLike(record)) {
    addError(errors, 'invalid-registry-entry', 'A registry entry is not a record.');
    return null;
  }
  const idData = ownData(record, 'id');
  const versionData = ownData(record, 'version');
  const statusData = ownData(record, 'status');
  const workflowData = ownData(record, 'workflow');
  const digestData = ownData(record, 'sourceDigest');
  const seedData = ownData(record, 'seed');
  if (!idData.present || idData.invalid || !validNonblank(idData.value) ||
      (versionData.present && (versionData.invalid || (versionData.value !== null && !validNonblank(versionData.value)))) ||
      (statusData.present && (statusData.invalid || typeof statusData.value !== 'string')) ||
      (workflowData.present && (workflowData.invalid || (workflowData.value !== null && (typeof workflowData.value !== 'string' || workflowData.value.length > MAX_TEXT)))) ||
      (digestData.present && (digestData.invalid || (digestData.value !== null && !validNonblank(digestData.value)))) ||
      (seedData.present && (seedData.invalid || typeof seedData.value !== 'boolean'))) {
    addError(errors, 'invalid-registry-entry', 'A registry entry has malformed identity or binding fields.');
    return null;
  }
  const id = idData.value;
  const version = versionData.present && typeof versionData.value === 'string' ? versionData.value : null;
  const lifecycle = statusData.present ? statusData.value || 'unknown' : 'unknown';
  const sourceDigest = digestData.present && typeof digestData.value === 'string' ? digestData.value : null;
  const workflow = workflowData.present && typeof workflowData.value === 'string' ? workflowData.value : '';
  const binding = validNonblank(workflow) ? { kind: 'archon-workflow', workflowName: workflow } : null;
  const identity = version === null ? null : identityKey(id, version);
  const candidateObservation = identity && observations ? observations.byIdentity.get(identity) : null;
  const registryDigestMismatch = candidateObservation && ((sourceDigest !== null || candidateObservation.sourceDigest !== null) && sourceDigest !== candidateObservation.sourceDigest);
  const observation = registryDigestMismatch ? null : candidateObservation;
  const matchMissingReason = version === null
    ? 'Registry version is missing; observations cannot be matched.'
    : registryDigestMismatch
      ? 'Capability observation digest does not match the registry artifact.'
      : 'No exact current observation matches this capability identity.';
  const installed = unknownObservationFact(observation, 'installed', matchMissingReason + ' Installation is unknown.');
  const verified = unknownObservationFact(observation, 'verified', matchMissingReason + ' Independent verification is unknown.');
  const authority = unknownObservationFact(observation, 'authority', 'Current contextual authority has not been established.');
  const runtime = observations ? observations.runtime : UNKNOWN('Runtime compatibility has not been established.');
  const catalog = observations ? observations.catalog : { state: 'unknown', names: [], reasons: ['Workflow catalog freshness or availability has not been established.'] };
  const workflowFact = !binding
    ? factWithReason('no', 'No explicit Archon workflow binding is declared.')
    : catalog.state === 'unavailable'
      ? factWithReason('no', 'Archon workflow catalog is unavailable.')
      : catalog.state !== 'available'
        ? UNKNOWN('Current Archon workflow catalog has not been established.')
        : catalog.names.includes(binding.workflowName)
          ? factWithReason('yes', 'Explicit workflow appears in the available Archon catalog.')
          : factWithReason('no', 'Explicit workflow is absent from the available Archon catalog.');
  const deps = dependencyReadiness(record, observation, errors);
  const executable = triState([installed, runtime, workflowFact, deps], 'Installation, runtime, workflow, and dependencies are ready.', 'A required execution condition is known to be unavailable.', 'Execution readiness evidence is incomplete.');
  const seed = seedData.present && seedData.value === true;
  const normalizedLifecycle = lifecycle.toLowerCase();
  let eligible;
  if (seed || normalizedLifecycle === 'candidate' || normalizedLifecycle === 'retired') {
    eligible = factWithReason('no', seed ? 'Seed capabilities are not eligible for user work.' : 'Lifecycle ' + normalizedLifecycle + ' is not eligible.');
  } else if (normalizedLifecycle === 'promoted' || normalizedLifecycle === 'verified') {
    eligible = triState([verified, executable, authority], 'Independent verification, execution readiness, and current authority are affirmative.', 'A required eligibility fact is known to be negative.', 'Eligibility evidence is incomplete.');
  } else {
    const required = [verified, executable, authority];
    eligible = required.some((fact) => fact.state === 'no')
      ? factWithReason('no', 'A required eligibility fact is known to be negative.')
      : UNKNOWN('Lifecycle is not promoted or verified, so eligibility is unknown.');
  }
  return {
    id, version, lifecycle, sourceDigest,
    binding,
    present: factWithReason('yes', 'Unique valid capability identity appears in the accepted registry.'),
    installed: { state: installed.state, reasons: combineReasons(installed) },
    verified: { state: verified.state, reasons: combineReasons(verified) },
    executable,
    eligible,
  };
}

/** Pure, display-only readiness projection over a canonical registry and host observations. */
export function projectCapabilityView(options) {
  const errors = [];
  if (options === undefined) options = {};
  if (!safeRecordShape(options)) {
    addError(errors, 'invalid-options', 'Projection options must be a safe data record.');
    return { schema: VIEW_SCHEMA, entries: [], errors };
  }
  const registryData = ownData(options, 'registry');
  const observationsData = ownData(options, 'observations');
  if (registryData.invalid || observationsData.invalid) {
    addError(errors, 'invalid-options', 'Projection options contain an invalid property.');
    return { schema: VIEW_SCHEMA, entries: [], errors };
  }
  const registry = registryData.present ? registryData.value : undefined;
  const observations = observationsData.present ? observationsData.value : undefined;
  const records = parseRegistry(registry, errors);
  if (!records) return { schema: VIEW_SCHEMA, entries: [], errors };
  const parsedObservations = parseObservations(observations, errors);
  const registryIdCounts = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const idData = ownData(record, 'id');
    if (idData.present && !idData.invalid && validNonblank(idData.value)) {
      registryIdCounts.set(idData.value, (registryIdCounts.get(idData.value) || 0) + 1);
    }
  }
  const duplicates = new Set([...registryIdCounts].filter(([, count]) => count > 1).map(([id]) => id));
  for (const _id of duplicates) addError(errors, 'duplicate-registry-id', 'Duplicate capability ID was rejected.');
  const valid = [];
  for (const record of records) {
    const entry = projectRecord(record, parsedObservations, errors);
    if (entry) valid.push({ record, entry });
  }
  const entries = valid.filter(({ entry }) => !duplicates.has(entry.id)).map(({ entry }) => entry);
  entries.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return { schema: VIEW_SCHEMA, entries, errors };
}
