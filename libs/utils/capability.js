const get = require('lodash/get');
const { IntegrationError } = require('./errors');

// 本插件的联邦能力依赖 @kne/fastify-tenant 提供的几个特权接口：
// 影子租户建立、快照投影、影子用户 upsert 都需要绕过外部租户只读保护，
// 只有 tenant 包内部能安全地做这件事；权限树合并与生命周期联动则需要它的注册钩子。
// 这些接口缺失时不让整个服务起不来，而是关掉对应能力并在调用时给出明确的升级提示。

const GUEST_CAPABILITIES = ['services.tenant.ensureExternal', 'services.federation.applySnapshot', 'services.federation.ensureExternalUser', 'services.federation.setExternalTenantStatus'];

const HOST_CAPABILITIES = ['addPermissionProvider', 'addHook'];

const requiredTenantVersion = () => {
  try {
    return require('../../package.json').peerDependencies['@kne/fastify-tenant'];
  } catch (e) {
    return '';
  }
};

const missingOf = (tenant, capabilities) => (tenant ? capabilities.filter(path => typeof get(tenant, path) !== 'function') : [...capabilities]);

const inspect = tenant => {
  const guest = missingOf(tenant, GUEST_CAPABILITIES);
  const host = missingOf(tenant, HOST_CAPABILITIES);
  return {
    guest: { ready: guest.length === 0, missing: guest },
    host: { ready: host.length === 0, missing: host },
    requiredTenantVersion: requiredTenantVersion()
  };
};

const assertReady = (report, side) => {
  const target = report[side];
  if (target.ready) {
    return;
  }
  throw new IntegrationError('TENANT_CAPABILITY_MISSING', `当前 @kne/fastify-tenant 缺少联邦${side === 'guest' ? '下游' : '上游'}能力：${target.missing.join('、')}。请升级到 ${report.requiredTenantVersion || '支持联邦协议的版本'}`, 501);
};

module.exports = { GUEST_CAPABILITIES, HOST_CAPABILITIES, inspect, assertReady };
