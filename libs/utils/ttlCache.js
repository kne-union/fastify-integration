// 带过期降级的 TTL 缓存。
// 两个方向的实时拉取都在请求路径上，延迟会互相叠加，所以缓存与降级是必需项而非优化项：
// 拉取失败时若还有过期数据，宁可返回过期数据也不要让上游的权限接口整体不可用。

const createTTLCache = ({ ttl = 60 * 1000, staleTTL = 24 * 60 * 60 * 1000, onStale = null } = {}) => {
  const store = new Map();
  const pending = new Map();

  const get = key => {
    const hit = store.get(key);
    if (!hit) {
      return undefined;
    }
    return Date.now() < hit.freshUntil ? hit.value : undefined;
  };

  const getStale = key => {
    const hit = store.get(key);
    if (!hit) {
      return undefined;
    }
    if (Date.now() > hit.staleUntil) {
      store.delete(key);
      return undefined;
    }
    return hit.value;
  };

  const set = (key, value) => {
    const now = Date.now();
    store.set(key, { value, freshUntil: now + ttl, staleUntil: now + Math.max(ttl, staleTTL) });
    return value;
  };

  const remove = key => store.delete(key);

  const clear = () => {
    store.clear();
    pending.clear();
  };

  // loader 并发去重：同一 key 同时有多个请求时只发一次出站调用
  const wrap = async (key, loader, { force = false, fallback = null } = {}) => {
    if (!force) {
      const fresh = get(key);
      if (fresh !== undefined) {
        return fresh;
      }
    }
    if (pending.has(key)) {
      return pending.get(key);
    }
    const task = (async () => {
      try {
        return set(key, await loader());
      } catch (e) {
        const stale = getStale(key);
        if (stale !== undefined) {
          if (typeof onStale === 'function') {
            onStale(key, e);
          }
          return stale;
        }
        if (typeof fallback === 'function') {
          const fallbackValue = await fallback(e);
          if (fallbackValue !== undefined && fallbackValue !== null) {
            if (typeof onStale === 'function') {
              onStale(key, e);
            }
            return set(key, fallbackValue);
          }
        }
        throw e;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, task);
    return task;
  };

  return { get, getStale, set, remove, clear, wrap };
};

module.exports = { createTTLCache };
