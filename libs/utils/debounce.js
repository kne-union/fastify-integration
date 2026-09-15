// 按 key 去抖并合并载荷。
// 上游批量导入组织或批量改角色时会连续触发 tenantDataChanged，
// 若每次都向下游推一条失效信号，下游就会被同一个租户的重复全量拉取刷爆。

const createKeyedDebouncer = ({ wait = 2000, onFlush, onError = null, merge = (prev, next) => next }) => {
  const entries = new Map();

  const flush = async key => {
    const entry = entries.get(key);
    if (!entry) {
      return;
    }
    entries.delete(key);
    try {
      await onFlush(key, entry.payload);
    } catch (e) {
      if (typeof onError === 'function') {
        onError(e, key, entry.payload);
      }
    }
  };

  const schedule = (key, payload) => {
    const entry = entries.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      entry.payload = merge(entry.payload, payload);
      entry.timer = setTimeout(() => flush(key), wait);
      entry.timer.unref?.();
      return;
    }
    const timer = setTimeout(() => flush(key), wait);
    timer.unref?.();
    entries.set(key, { payload, timer });
  };

  const cancelAll = () => {
    entries.forEach(entry => clearTimeout(entry.timer));
    entries.clear();
  };

  return { schedule, flush, cancelAll };
};

module.exports = { createKeyedDebouncer };
