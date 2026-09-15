const { AsyncLocalStorage } = require('node:async_hooks');

// 联邦调用上下文。
//
// 开通租户的链路是会级联的：上游给我建影子租户 → 触发我的 tenantCreated
// → 我把这个租户继续开通到我的下游。拓扑成环时（A 托管 B，B 又托管 A）
// 这条链会无限递归，把两边的连接数打满。
//
// 成环检测需要把入站的联邦路径带到出站调用上，但中间隔着 fastify-tenant 的钩子，
// 没法靠函数参数一路传下去。用 AsyncLocalStorage 就不需要让 tenant 包理解联邦概念。
const storage = new AsyncLocalStorage();

const run = (context, fn) => storage.run(Object.assign({}, current(), context), fn);

const current = () => storage.getStore() || {};

const federationPath = () => current().federationPath || [];

// 后台任务要显式带上捕获到的上下文：级联开通不能阻塞入站请求，
// 但脱离请求后仍然需要成环检测。
const runInBackground = (fn, onError) => {
  const captured = current();
  setImmediate(() => {
    Promise.resolve()
      .then(() => storage.run(captured, fn))
      .catch(e => {
        if (typeof onError === 'function') {
          onError(e);
        }
      });
  });
};

module.exports = { run, current, federationPath, runInBackground };
