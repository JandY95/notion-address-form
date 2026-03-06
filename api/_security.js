import crypto from "node:crypto";

export function setCommonSecurityHeaders(res, { noStore = true } = {}) {
  if (noStore) res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

export function getRequestHost(req) {
  return String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
}

export function isAllowedSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === getRequestHost(req);
  } catch {
    return false;
  }
}

export function denyIfCrossOrigin(req, res) {
  if (!isAllowedSameOrigin(req)) {
    res.status(403).json({ error: "Forbidden" });
    return true;
  }
  return false;
}

export function getClientIp(req) {
  const xfwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xfwd || req.socket?.remoteAddress || "unknown";
}

export function createLimiterStore() {
  return new Map();
}

export function isRateLimited(store, key, limit, windowMs) {
  const now = Date.now();
  const prev = store.get(key);
  const entry = !prev || now > prev.resetAt
    ? { count: 0, resetAt: now + windowMs }
    : prev;

  entry.count += 1;
  store.set(key, entry);

  return entry.count > limit;
}

export function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

export function normalizeText(v, max = 200) {
  return String(v || "").trim().replace(/\s+/g, " ").slice(0, max);
}

export function digitsOnly(v) {
  return String(v || "").replace(/\D/g, "");
}

export function isValidKoreanPhone(v) {
  const d = digitsOnly(v);
  if (!d.startsWith("0")) return false;
  if (d.length < 9 || d.length > 11) return false;
  if (d.startsWith("02")) return d.length === 9 || d.length === 10;
  if (/^01[016789]/.test(d)) return d.length === 10 || d.length === 11;
  if (/^0\d{2}/.test(d)) return d.length === 10 || d.length === 11;
  return false;
}
