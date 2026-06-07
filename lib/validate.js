// Strict shape validation for imported data. Pure functions — no chrome deps.
// If validation fails we throw a ValidationError with a precise message so the
// UI can show the user exactly what's wrong.

export class ValidationError extends Error {
  constructor(msg, path) {
    super(path ? `${msg} (at ${path})` : msg);
    this.name = 'ValidationError';
    this.path = path || '';
  }
}

const VALID_TYPES = new Set(['manual', 'auto', 'startup', 'crash', 'pre-restore', 'import', 'live']);
const VALID_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);

function ensure(cond, msg, path) {
  if (!cond) throw new ValidationError(msg, path);
}

function isStr(v)  { return typeof v === 'string'; }
function isNum(v)  { return typeof v === 'number' && Number.isFinite(v); }
function isBool(v) { return typeof v === 'boolean'; }
function isArr(v)  { return Array.isArray(v); }
function isObj(v)  { return v && typeof v === 'object' && !Array.isArray(v); }

export function validateSnapshot(s, basePath = 'snapshot') {
  ensure(isObj(s), 'must be an object', basePath);
  ensure(isStr(s.id) && s.id.length > 0, 'id must be a non-empty string', `${basePath}.id`);
  ensure(isNum(s.timestamp), 'timestamp must be a number', `${basePath}.timestamp`);
  ensure(s.timestamp > 0, 'timestamp must be positive', `${basePath}.timestamp`);
  if (s.name !== undefined) ensure(isStr(s.name), 'name must be a string', `${basePath}.name`);
  if (s.type !== undefined) {
    ensure(isStr(s.type), 'type must be a string', `${basePath}.type`);
    // Unknown types are allowed (forward-compat) but logged via warn — we
    // don't throw, just coerce.
  }
  if (s.pinned !== undefined) ensure(isBool(s.pinned), 'pinned must be boolean', `${basePath}.pinned`);
  if (s.schema !== undefined) ensure(isNum(s.schema), 'schema must be a number', `${basePath}.schema`);

  ensure(isArr(s.windows), 'windows must be an array', `${basePath}.windows`);
  s.windows.forEach((w, i) => validateWindow(w, `${basePath}.windows[${i}]`));

  if (s.stats !== undefined) {
    ensure(isObj(s.stats), 'stats must be an object', `${basePath}.stats`);
  }
  return true;
}

function validateWindow(w, path) {
  ensure(isObj(w), 'must be an object', path);
  if (w.windowId !== undefined) ensure(isNum(w.windowId), 'windowId must be a number', `${path}.windowId`);
  if (w.focused !== undefined) ensure(isBool(w.focused), 'focused must be boolean', `${path}.focused`);
  if (w.state !== undefined) ensure(isStr(w.state), 'state must be a string', `${path}.state`);
  ensure(isArr(w.tabs), 'tabs must be an array', `${path}.tabs`);
  w.tabs.forEach((t, i) => validateTab(t, `${path}.tabs[${i}]`));
  if (w.groups !== undefined) {
    ensure(isArr(w.groups), 'groups must be an array', `${path}.groups`);
    w.groups.forEach((g, i) => validateGroup(g, `${path}.groups[${i}]`));
  }
}

function validateTab(t, path) {
  ensure(isObj(t), 'must be an object', path);
  // url is the only truly required field — title/index/pinned are all optional
  ensure(isStr(t.url), 'url must be a string', `${path}.url`);
  if (t.title !== undefined) ensure(isStr(t.title), 'title must be a string', `${path}.title`);
  if (t.index !== undefined) ensure(isNum(t.index), 'index must be a number', `${path}.index`);
  if (t.pinned !== undefined) ensure(isBool(t.pinned), 'pinned must be boolean', `${path}.pinned`);
  if (t.active !== undefined) ensure(isBool(t.active), 'active must be boolean', `${path}.active`);
  if (t.groupId !== undefined) ensure(isNum(t.groupId), 'groupId must be a number', `${path}.groupId`);
}

function validateGroup(g, path) {
  ensure(isObj(g), 'must be an object', path);
  if (g.id !== undefined) ensure(isNum(g.id), 'id must be a number', `${path}.id`);
  if (g.title !== undefined) ensure(isStr(g.title), 'title must be a string', `${path}.title`);
  if (g.color !== undefined) {
    ensure(isStr(g.color), 'color must be a string', `${path}.color`);
    // unknown colors are allowed; UI falls back to grey
  }
  if (g.collapsed !== undefined) ensure(isBool(g.collapsed), 'collapsed must be boolean', `${path}.collapsed`);
}

export function validateImportPayload(p) {
  ensure(isObj(p), 'payload must be an object', 'payload');
  if (p.kind === 'tab-vault-snapshot') {
    ensure(isObj(p.snapshot), 'snapshot must be an object', 'payload.snapshot');
    validateSnapshot(p.snapshot, 'payload.snapshot');
    return { kind: 'single', snapshots: [p.snapshot], profileId: p.profileId || null, profileLabel: p.profileLabel || null };
  }
  if (p.kind === 'tab-vault-export') {
    ensure(isArr(p.snapshots), 'snapshots must be an array', 'payload.snapshots');
    p.snapshots.forEach((s, i) => validateSnapshot(s, `payload.snapshots[${i}]`));
    return { kind: 'export', snapshots: p.snapshots, profileId: p.profileId || null, profileLabel: p.profileLabel || null };
  }
  // Bare snapshot (no envelope)
  if (isArr(p.windows)) {
    validateSnapshot(p, 'payload');
    return { kind: 'single', snapshots: [p], profileId: null, profileLabel: null };
  }
  throw new ValidationError('Unrecognized file format (expected tab-vault export or snapshot)', 'payload.kind');
}
