const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  // 上游侧权限树 provider。
  //
  // appCode 本身就是上游权限树的一个新顶层模块，下游整棵树（含它自己的 tenant / client 顶层）
  // 原样嵌在下面，因此不需要任何顶层映射配置：下游的 tenant:project:view
  // 在上游就是 {appCode}:tenant:project:view。
  //
  // 合并发生在请求时且带 tenantId，所以只会合并该租户已开通下游的树。
  // 单个下游拉取失败不能让上游整个角色管理界面挂掉，因此逐个 catch。
  const resolveModules = async ({ tenantId, federationPath } = {}) => {
    if (!tenantId) {
      return [];
    }
    const links = await services.registry.listEnabledLinksByTenant({ tenantId });
    if (links.length === 0) {
      return [];
    }
    const modules = await Promise.all(
      links.map(async ({ app }) => {
        try {
          const manifest = await services.registry.getManifest({
            appCode: app.appCode,
            sourceTenantId: tenantId,
            federationPath
          });
          const children = manifest && Array.isArray(manifest.permissionTree) ? manifest.permissionTree : [];
          if (children.length === 0) {
            return null;
          }
          return {
            name: (manifest && manifest.name) || app.name || app.appCode,
            code: app.appCode,
            description: manifest && manifest.description,
            modules: children
          };
        } catch (e) {
          fastify.log.warn({ err: e, appCode: app.appCode, tenantId }, '[integration] 拉取下游权限树失败，本次合并跳过该下游');
          return null;
        }
      })
    );
    return modules.filter(Boolean);
  };

  Object.assign(services, {
    provider: { resolveModules }
  });
});
