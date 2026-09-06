// Canonical redaction rules, shared by the extension (which captures the data)
// and the MCP server (which applies them again before anything reaches Claude).
// Redacting twice is cheap; redacting zero times is a leak.

export const MASK = '[REDACTED]';

// Field names that mean "this value is a secret", regardless of input type.
const SENSITIVE_NAME = /(pass(wo?r?d)?|passphrase|secret|token|api[-_]?key|auth|credential|otp|mfa|2fa|cvv|cvc|ssn|social.?security|card.?number|cc.?num|pin|private.?key|session.?id)/i;

// Autocomplete hints that identify secret-bearing fields.
const SENSITIVE_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-number|cc-csc)$/i;

// Value shapes that look like credentials wherever they appear in text.
const VALUE_PATTERNS = [
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED:jwt]'],
  // Provider-prefixed keys: sk-..., pk_live_..., ghp_..., xoxb-..., AIza...
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g, '[REDACTED:api-key]'],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, '[REDACTED:api-key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:api-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:api-key]'],
  // AWS access key id + secret access key
  [/\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\baws_secret_access_key\s*[=:]\s*\S+/gi, 'aws_secret_access_key=[REDACTED]'],
  // Authorization headers and bearer tokens
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]'],
  // PEM private key blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  // key=value / "key": "value" where the key name reads as a secret
  [/((?:pass(?:wo?r?d)?|secret|token|api[-_]?key|auth|credential)["']?\s*[:=]\s*["']?)([^\s"',;&}]{4,})/gi, '$1[REDACTED]'],
  // Bare card numbers (13-19 digits, optionally grouped)
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[REDACTED:card?]'],
];

/**
 * True when a form field must never have its value captured.
 * `type` is the input's type attribute; the other fields are hints.
 */
export function isSensitiveField({ type, name, id, placeholder, autocomplete, ariaLabel } = {}) {
  if (typeof type === 'string' && type.toLowerCase() === 'password') return true;
  if (typeof autocomplete === 'string' && SENSITIVE_AUTOCOMPLETE.test(autocomplete.trim())) return true;
  for (const hint of [name, id, placeholder, ariaLabel]) {
    if (typeof hint === 'string' && SENSITIVE_NAME.test(hint)) return true;
  }
  return false;
}

/** Mask secret-shaped substrings inside free text. */
export function redactText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Redact one field's value, given the field's descriptor. */
export function redactFieldValue(descriptor, value) {
  if (isSensitiveField(descriptor)) return MASK;
  return redactText(value);
}

/**
 * Deep-redact an arbitrary structure: every string value is pattern-masked and
 * any value whose *key* reads as a secret is masked outright.
 */
export function redactDeep(value, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_NAME.test(k) && typeof v !== 'object' ? MASK : redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** URLs often carry tokens in the query string; keep the shape, drop the values. */
export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    let touched = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_NAME.test(key) || /^(code|id_token|access_token|refresh_token)$/i.test(key)) {
        u.searchParams.set(key, MASK);
        touched = true;
      }
    }
    if (u.hash && /(access_token|id_token|token)=/i.test(u.hash)) {
      u.hash = '#[REDACTED:fragment]';
      touched = true;
    }
    return touched ? u.toString() : redactText(url);
  } catch {
    return redactText(url);
  }
}
