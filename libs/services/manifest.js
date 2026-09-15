const fp = require('fastify-plugin');
const get = require('lodash/get');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  let nestingWarned = false;

  // manifest 是下游对上游的自我描述，实时生成不缓存（缓存在上游侧做）。
  //
  // permissionTree 与 mounts[].permission 都**不带 {appCode}: 前缀**：
  // 加前缀是上游 provider 的职责，下游始终只说自己的语言。
  // 这样下游作为独立系统运行时权限码完全不受集成影响。
  //
  // 带 sourceTenantId 时返回 resolvePermissions 的结果，把本应用自己下游的树也嵌进去，
  // 多级联邦的前缀因此逐级组合，不需要任何全局前缀表。
  const resolvePermissionModules = async ({ hostAppCode, sourceTenantId, federationPath: pathList }) => {
    const tenantNamespace = fastify[options.tenantName];
    const staticModules = get(tenantNamespace, 'permissions.modules', []);
    if (!sourceTenantId) {
      return staticModules;
    }
    if (typeof tenantNamespace.resolvePermissions !== 'function') {
      if (!nestingWarned) {
        nestingWarned = true;
        fastify.log.warn('[integration] 当前 @kne/fastify-tenant 不支持 resolvePermissions，manifest 只返回本地静态权限树，多级联邦的嵌套会在此断开');
      }
      return staticModules;
    }
    const tenant = await services.guest.findShadowTenant({ hostAppCode, sourceTenantId });
    if (!tenant) {
      return staticModules;
    }
    const resolved = await tenantNamespace.resolvePermissions({ tenantId: tenant.id, federationPath: pathList });
    return get(resolved, 'modules', staticModules);
  };

  const build = async ({ hostAppCode, sourceTenantId, federationPath: pathList } = {}) => ({
    protocol: options.protocol,
    appCode: options.appCode,
    name: options.appName,
    description: options.appDescription,
    apiBase: options.apiBase,
    web: options.web,
    mounts: options.mounts,
    permissionTree: await resolvePermissionModules({ hostAppCode, sourceTenantId, federationPath: pathList })
  });

  Object.assign(services, {
    manifest: { build }
  });
});
