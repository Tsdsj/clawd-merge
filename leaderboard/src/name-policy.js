// New-name admission is separate from legacy display and login-handle parsing.
// No network calls, account lookups, fuzzy pinyin or blanket category blocking.
const NAME_PATTERN = /^[\p{Script=Han}A-Za-z0-9_\-·]+$/u;
const UNSAFE_UNICODE = /[\p{Cc}\p{Cf}\p{Cs}]/u;
export const normalizeName = (raw) =>
  typeof raw === "string" ? raw.normalize("NFKC").trim() : "";
const key = (value) => normalizeName(value).toLowerCase();
const compact = (value) => value.replace(/[_\-·]/g, "");
const validRule = (r) =>
  r &&
  typeof r.id === "string" &&
  r.id &&
  typeof r.term === "string" &&
  r.term &&
  ["word", "substring"].includes(r.match);

export async function compileNamePolicy(data, expectedDigest) {
  try {
    if (!data || !/^[a-f0-9]{64}$/.test(expectedDigest || "")) return null;
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(data)),
    );
    if (
      [...new Uint8Array(hash)]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("") !== expectedDigest
    )
      return null;
    if (
      typeof data.version !== "string" ||
      !data.version ||
      !Array.isArray(data.reserved) ||
      !data.reserved.length ||
      !data.reserved.every((x) => typeof x === "string" && x) ||
      !Array.isArray(data.base) ||
      !data.base.length ||
      !Array.isArray(data.project) ||
      ![...data.base, ...data.project].every(validRule) ||
      !Array.isArray(data.variants) ||
      !Array.isArray(data.exceptions)
    )
      return null;
    const allIds = new Set([...data.base, ...data.project].map((r) => r.id));
    if (allIds.size !== data.base.length + data.project.length) return null;
    const baseIds = new Set(data.base.map((r) => r.id));
    if (
      !data.variants.every(
        (v) =>
          v &&
          typeof v.from === "string" &&
          v.from &&
          typeof v.to === "string" &&
          v.to,
      )
    )
      return null;
    if (
      !data.exceptions.every(
        (e) =>
          e &&
          typeof e.name === "string" &&
          e.name &&
          typeof e.reason === "string" &&
          e.reason &&
          e.version === data.version &&
          Array.isArray(e.ruleIds) &&
          e.ruleIds.length &&
          e.ruleIds.every((id) => baseIds.has(id)),
      )
    )
      return null;
    // Clone before compiling: callers cannot mutate the policy after validation.
    const snapshot = structuredClone(data);
    const rules = (rs) =>
      rs.map((r) => Object.freeze({ ...r, term: key(r.term) }));
    return Object.freeze({
      version: snapshot.version,
      reserved: Object.freeze(snapshot.reserved.map(key)),
      base: Object.freeze(rules(snapshot.base)),
      project: Object.freeze(rules(snapshot.project)),
      variants: Object.freeze(
        snapshot.variants.map((v) =>
          Object.freeze({ from: key(v.from), to: key(v.to) }),
        ),
      ),
      exceptions: Object.freeze(
        snapshot.exceptions.map((e) =>
          Object.freeze({
            name: key(e.name),
            ruleIds: Object.freeze(e.ruleIds),
          }),
        ),
      ),
    });
  } catch {
    return null;
  }
}

async function loadDefaultPolicy() {
  try {
    const { data, sha256 } = await import("../data/name-policy-v1.js");
    return await compileNamePolicy(data, sha256);
  } catch {
    return null;
  } // A missing/broken data file must not take gameplay down.
}
export const defaultPolicy = await loadDefaultPolicy();
export const NAME_POLICY_VERSION = defaultPolicy?.version ?? null;

function matches(rule, value) {
  if (rule.match === "substring") return value.includes(rule.term);
  // ASCII word boundaries prevent harmless substrings such as "shirt".
  const escaped = rule.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "u").test(value);
}
function denied(name, policy, blockedWords) {
  const lower = key(name),
    stripped = compact(lower);
  if (policy.reserved.includes(lower) || policy.reserved.includes(stripped))
    return "reserved";
  const variants = [lower, stripped];
  for (const v of policy.variants) {
    variants.push(
      lower.replaceAll(v.from, v.to),
      stripped.replaceAll(v.from, v.to),
    );
  }
  const extra =
    typeof blockedWords === "string"
      ? blockedWords.split(",").map(key).filter(Boolean)
      : [];
  if (
    extra.some((word) =>
      variants.some(
        (v) => v.includes(word) || compact(v).includes(compact(word)),
      ),
    )
  )
    return "project-config";
  const project = policy.project.find((r) =>
    variants.some((v) => matches(r, v)),
  );
  if (project) return project.id;
  const except = policy.exceptions.find((e) => e.name === lower);
  const base = policy.base.find(
    (r) =>
      !except?.ruleIds.includes(r.id) && variants.some((v) => matches(r, v)),
  );
  return base?.id ?? null;
}

export function checkName(
  raw,
  { policy = defaultPolicy, blockedWords = "" } = {},
) {
  if (!policy)
    return { ok: false, error: "name_policy_unavailable", status: 503 };
  if (typeof raw !== "string" || raw.length > 256 || UNSAFE_UNICODE.test(raw))
    return { ok: false, error: "bad_name", ruleId: "format", status: 400 };
  const name = normalizeName(raw),
    length = [...name].length;
  if (length < 2 || length > 12 || !NAME_PATTERN.test(name))
    return { ok: false, error: "bad_name", ruleId: "format", status: 400 };
  const ruleId = denied(name, policy, blockedWords);
  return ruleId
    ? { ok: false, error: "bad_name", ruleId, status: 400 }
    : { ok: true, name, version: policy.version };
}

export function displayName(
  player,
  { policy = defaultPolicy, blockedWords = "" } = {},
) {
  const raw = player.name;
  // Legacy/external names aren't new names: no new-name length/character limits.
  // Their stored value is never rewritten or used as a credential decision.
  if (
    policy &&
    typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= 160 &&
    !UNSAFE_UNICODE.test(raw) &&
    !denied(raw, policy, blockedWords)
  )
    return raw;
  return player.public_alias || "玩家";
}

export function loginHandleKey(raw) {
  if (typeof raw !== "string" || raw.length > 256 || UNSAFE_UNICODE.test(raw))
    return null;
  const normalized = key(raw);
  return /^.+#[0-9]{4}$/u.test(normalized) ? normalized : null;
}

export function inspectDisplayName(player, options = {}) {
  const policy = options.policy === undefined ? defaultPolicy : options.policy;
  if (!policy) return { status: "unavailable", ruleId: null, version: null };
  const raw = player.name;
  const ruleId =
    typeof raw !== "string" ||
    !raw ||
    raw.length > 160 ||
    UNSAFE_UNICODE.test(raw)
      ? "format"
      : denied(raw, policy, options.blockedWords || "");
  return {
    status: ruleId ? "masked" : "allowed",
    ruleId,
    version: policy.version,
  };
}
