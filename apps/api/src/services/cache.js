/**
 * Creates an in-memory LRU cache backed by a Map.
 *
 * @param {Object} [options]
 * @param {number} [options.ttlMs=60000] - Time to live in milliseconds (0 or less for no expiration).
 * @param {number} [options.maxEntries=100] - Maximum capacity before evicting least recently used item.
 * @param {() => number} [options.now=Date.now] - Function returning current timestamp in milliseconds.
 * @returns {Object} LRU cache instance.
 */
export function createCache({
  ttlMs = 60000,
  maxEntries = 100,
  now = Date.now,
} = {}) {
  const map = new Map();

  function isExpired(entry) {
    if (ttlMs == null || ttlMs <= 0 || !Number.isFinite(ttlMs)) {
      return false;
    }
    return now() - entry.timestamp > ttlMs;
  }

  function get(key) {
    if (!map.has(key)) {
      return undefined;
    }
    const entry = map.get(key);
    if (isExpired(entry)) {
      map.delete(key);
      return undefined;
    }
    map.delete(key);
    map.set(key, entry);
    return entry.value;
  }

  function set(key, value) {
    if (map.has(key)) {
      map.delete(key);
    } else if (maxEntries > 0 && map.size >= maxEntries) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
    map.set(key, {
      value,
      timestamp: now(),
    });
  }

  function del(key) {
    return map.delete(key);
  }

  function has(key) {
    if (!map.has(key)) {
      return false;
    }
    const entry = map.get(key);
    if (isExpired(entry)) {
      map.delete(key);
      return false;
    }
    return true;
  }

  function clear() {
    map.clear();
  }

  return {
    get,
    set,
    delete: del,
    invalidate: del,
    has,
    clear,
    get size() {
      return map.size;
    },
  };
}

export default createCache;
