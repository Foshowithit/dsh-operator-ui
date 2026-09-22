'use strict';
// Adapter declarations and capability contracts.
//
// A registry entry may declare HOW to invoke it. The declaration is
// deliberately narrow (type=command: an executable entrypoint under RCOS_HOME)
// and the contract is a small, deterministic JSON Schema subset — no model
// judgment, no dependency on an external validator. This module is the single
// source for both the registry validator (structure) and the invocation kernel
// (resolution + I/O checking), so audit and execution can never disagree about
// what a valid declaration is.

const fs = require('node:fs');
const path = require('node:path');

const ADAPTER_TYPES = ['command'];
const CONTRACT_SCHEMA = 'rcos-capability-contract/1';
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Entrypoints and contracts are declared relative to RCOS_HOME so a home can be
// copied (or sandboxed in a test) and still resolve.
function isHomeRelative(p) {
  return typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) &&
    !p.split('/').includes('..');
}

function validateAdapterDeclaration(decl) {
  const errors = [];
  if (!isPlainObject(decl)) return ['adapter: must be an object'];
  if (typeof decl.type !== 'string') errors.push('adapter.type: must be a string');
  else if (!ADAPTER_TYPES.includes(decl.type)) {
    errors.push('adapter.type: unsupported type \'' + decl.type + '\' (supported: ' + ADAPTER_TYPES.join(', ') + ')');
  }
  if (!isHomeRelative(decl.entrypoint)) {
    errors.push('adapter.entrypoint: must be a non-empty path relative to RCOS_HOME with no \'..\' segments');
  }
  if (decl.timeout_seconds !== undefined &&
      !(Number.isInteger(decl.timeout_seconds) && decl.timeout_seconds > 0)) {
    errors.push('adapter.timeout_seconds: must be a positive integer');
  }
  if (decl.contract !== undefined && !isHomeRelative(decl.contract)) {
    errors.push('adapter.contract: must be a non-empty path relative to RCOS_HOME with no \'..\' segments');
  }
  return errors;
}

function resolveEntrypoint(homeDir, decl) {
  return path.join(homeDir, decl.entrypoint);
}

function resolveContractPath(homeDir, decl) {
  return decl.contract === undefined ? null : path.join(homeDir, decl.contract);
}

// Shape check for a declared contract file. Structural only — it says the
// contract can be enforced, not that any value satisfies it.
function validateContractShape(contract) {
  const errors = [];
  if (!isPlainObject(contract)) return ['contract: must be an object'];
  if (contract.schema !== CONTRACT_SCHEMA) {
    errors.push('contract.schema: must be \'' + CONTRACT_SCHEMA + '\'');
  }
  const declared = ['input', 'output'].filter((k) => contract[k] !== undefined);
  if (declared.length === 0) errors.push('contract: declares neither input nor output');
  for (const dir of declared) {
    if (!isPlainObject(contract[dir])) { errors.push('contract.' + dir + ': must be an object'); continue; }
    errors.push(...validateSchemaShape(contract[dir], 'contract.' + dir));
  }
  return errors;
}

function validateSchemaShape(schema, label) {
  const errors = [];
  if (!isPlainObject(schema)) return [label + ': must be an object'];
  if (schema.type === undefined) errors.push(label + '.type: required');
  else {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of types) {
      if (!SCHEMA_TYPES.includes(t)) errors.push(label + '.type: unknown type \'' + t + '\'');
    }
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) errors.push(label + '.properties: must be an object');
    else for (const [k, v] of Object.entries(schema.properties)) {
      errors.push(...validateSchemaShape(v, label + '.properties.' + k));
    }
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === 'string'))) {
    errors.push(label + '.required: must be an array of strings');
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    errors.push(label + '.additionalProperties: must be a boolean');
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) errors.push(label + '.enum: must be an array');
  if (schema.items !== undefined) errors.push(...validateSchemaShape(schema.items, label + '.items'));
  if (schema.pattern !== undefined) {
    try { new RegExp(schema.pattern); } catch (e) { errors.push(label + '.pattern: not a valid regex: ' + e.message); }
  }
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[k] !== undefined && !(Number.isInteger(schema[k]) && schema[k] >= 0)) {
      errors.push(label + '.' + k + ': must be a non-negative integer');
    }
  }
  for (const k of ['minimum', 'maximum']) {
    if (schema[k] !== undefined && !Number.isFinite(schema[k])) errors.push(label + '.' + k + ': must be a number');
  }
  return errors;
}

// Reads and shape-checks the contract a declaration points at.
//   { ok, contract, errors }  — contract is null when nothing is declared.
function loadContract(homeDir, decl) {
  const p = resolveContractPath(homeDir, decl);
  if (p === null) return { ok: true, contract: null, errors: [], path: null };
  if (!fs.existsSync(p)) {
    return { ok: false, contract: null, errors: ['declared contract is missing: ' + decl.contract], path: p };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, contract: null, errors: ['declared contract is not valid JSON: ' + e.message], path: p };
  }
  const errors = validateContractShape(parsed);
  return { ok: errors.length === 0, contract: errors.length === 0 ? parsed : null, errors, path: p };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(v, t) {
  switch (t) {
    case 'object': return isPlainObject(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The enforced subset. Deterministic, exhaustive over the declared keywords:
// anything the contract does not declare is not checked, so a contract that
// says `additionalProperties: false` is exactly what makes an unknown field
// fail (and a contract that omits it tolerates one).
function validateValue(value, schema, where) {
  const errors = [];
  if (!isPlainObject(schema)) return [where + ': schema is not an object'];
  if (schema.enum !== undefined && Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(where + ': must be one of ' + JSON.stringify(schema.enum) + ' (got ' + JSON.stringify(value) + ')');
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(where + ': expected ' + types.join('|') + ', got ' + typeOf(value));
      return errors; // deeper checks would only produce noise
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(where + ': shorter than minLength ' + schema.minLength);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(where + ': longer than maxLength ' + schema.maxLength);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(where + ': does not match pattern ' + schema.pattern);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(where + ': below minimum ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(where + ': above maximum ' + schema.maximum);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(where + ': fewer than minItems ' + schema.minItems);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(where + ': more than maxItems ' + schema.maxItems);
    if (schema.items !== undefined) {
      value.forEach((v, i) => errors.push(...validateValue(v, schema.items, where + '[' + i + ']')));
    }
  }
  if (isPlainObject(value)) {
    for (const r of schema.required || []) {
      if (value[r] === undefined) errors.push(where + '.' + r + ': required');
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = (schema.properties || {})[k];
      if (sub !== undefined) errors.push(...validateValue(v, sub, where + '.' + k));
      else if (schema.additionalProperties === false) errors.push(where + '.' + k + ': unknown field (contract declares additionalProperties: false)');
    }
  }
  return errors;
}

function describeContract(contract) {
  if (!contract) return 'no declared contract';
  const part = (dir) => {
    const s = contract[dir];
    if (!s) return dir + ': (not declared)';
    const req = new Set(s.required || []);
    const keys = Object.keys(s.properties || {});
    return dir + ': ' + (keys.length === 0 ? '(no fields)' : keys.map((k) => k + (req.has(k) ? '*' : '')).join(', '));
  };
  return part('input') + ' -> ' + part('output');
}

module.exports = {
  ADAPTER_TYPES,
  CONTRACT_SCHEMA,
  SCHEMA_TYPES,
  validateAdapterDeclaration,
  validateContractShape,
  validateValue,
  resolveEntrypoint,
  resolveContractPath,
  loadContract,
  describeContract,
  typeOf
};
