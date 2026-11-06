export function createRateLimiter({ windowMs, max }) {
  const windows = new Map();

  return {
    check(key, now = Date.now()) {
      let entry = windows.get(key);
      if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        windows.set(key, entry);
      }
      entry.count++;
      return { allowed: entry.count <= max, retryAfterMs: Math.max(0, entry.resetAt - now) };
    },
    prune(now = Date.now()) {
      for (const [key, entry] of windows) {
        if (now >= entry.resetAt) windows.delete(key);
      }
    },
    get size() {
      return windows.size;
    },
  };
}
