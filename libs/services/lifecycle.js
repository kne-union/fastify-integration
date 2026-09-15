const fp = require('fastify-plugin');
const { createKeyedDebouncer } = require('../utils/debounce');
const federationPath = require('../utils/federationPath');
const context = require('../utils/context');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];

  // 上游侧：把本地租户生命周期联动到各下游。
  // 所有联动都不得阻断上游主流程——下游宕机不应拖垮上游的租户管理。

  const linkTenantToApp = async ({ tenantId, app }) => {
    // 开通链路同样会级联，因此必须做成环检测。
    // 在出站前用目标 appCode 判一次，成环时连请求都不用发。
    const inboundPath = context.federationPath();
    federationPath.assertAcyclic({ path: inboundPath, appCode: app.appCode, maxDepth: options.maxDepth });

    const tenantMeta = await services.federation.exportTenantMeta({ sourceTenantId: tenantId });
    const result = await services.client.request({
      apiUrl: app.apiUrl,
      appId: app.appId,
      secretKey: app.secretKey,
      method: 'POST',
      path: '/open-api/tenant/link',
      federationPath: federationPath.append(inboundPath, options.appCode),
      body: {
        protocol: options.protocol,
        hostAppCode: options.appCode,
        sourceTenantId: String(tenantId),
        tenant: tenantMeta
      }
    });
    const current = await models.tenant.findOne({ where: { tenantId, appCode: app.appCode } });
    const patch = {
      remoteTenantId: result && result.remoteTenantId ? String(result.remoteTenantId) : null,
      status: 'enabled',
      linkedAt: new Date(),
      lastSnapshotError: null
    };
    if (current) {
      await current.update(patch);
      return current;
    }
    return await models.tenant.create(Object.assign({ tenantId, appCode: app.appCode }, patch));
  };

  const linkTenant = async ({ tenantId, appCode }) => {
    const app = await services.registry.getApp({ appCode });
    return await linkTenantToApp({ tenantId, app });
  };

  const unlinkTenant = async ({ tenantId, appCode }) => {
    const app = await services.registry.getApp({ appCode, requireEnabled: false });
    const link = await models.tenant.findOne({ where: { tenantId, appCode } });
    try {
      await services.client.request({
        apiUrl: app.apiUrl,
        appId: app.appId,
        secretKey: app.secretKey,
        method: 'POST',
        path: '/open-api/tenant/unlink',
        body: { protocol: options.protocol, hostAppCode: options.appCode, sourceTenantId: String(tenantId) }
      });
    } catch (e) {
      fastify.log.warn({ err: e, tenantId, appCode }, '[integration] 通知下游停用租户失败，仅在本地标记停用');
    }
    if (link) {
      await link.update({ status: 'disabled' });
    }
    services.session.invalidateSession({ appCode, tenantId });
    services.registry.manifestCache.remove(services.registry.manifestCacheKey({ appCode, sourceTenantId: tenantId }));
  };

  // 租户创建后自动向所有已启用下游开通。
  //
  // 这里刻意不阻塞：影子租户创建也会触发本钩子，于是开通会沿 A → B → C 逐级级联。
  // 若每一跳都同步等待，入站的 link 请求耗时就会随链路深度线性叠加。
  // 级联改成后台执行，但显式带上联邦上下文，成环检测照旧生效。
  const onTenantCreated = async ({ tenantId }) => {
    const apps = await services.registry.listEnabledApps();
    apps.forEach(app => {
      context.runInBackground(
        () => linkTenantToApp({ tenantId, app }),
        e => fastify.log.error({ err: e, tenantId, appCode: app.appCode }, '[integration] 租户自动开通下游失败，可在管理端手动补建')
      );
    });
  };

  const invalidateDebouncer = createKeyedDebouncer({
    wait: options.invalidateDebounce,
    merge: (prev, next) => ({ domains: [...new Set([...(prev.domains || []), ...(next.domains || [])])] }),
    onFlush: async (key, payload) => {
      const separator = key.lastIndexOf(':');
      const appCode = key.slice(0, separator);
      const tenantId = key.slice(separator + 1);
      const app = await services.registry.getApp({ appCode });
      const link = await models.tenant.findOne({ where: { tenantId, appCode, status: 'enabled' } });
      if (!link) {
        return;
      }
      await services.client.request({
        apiUrl: app.apiUrl,
        appId: app.appId,
        secretKey: app.secretKey,
        method: 'POST',
        path: '/open-api/snapshot/invalidate',
        body: {
          protocol: options.protocol,
          hostAppCode: options.appCode,
          sourceTenantId: String(tenantId),
          domains: payload.domains || []
        }
      });
      // 权限或角色变化后，已发出的票据里带的身份可能已过时，顺手清掉换票缓存
      services.session.invalidateSession({ appCode, tenantId });
      services.registry.manifestCache.remove(services.registry.manifestCacheKey({ appCode, sourceTenantId: tenantId }));
    },
    onError: (e, key) => fastify.log.warn({ err: e, key }, '[integration] 推送失效信号失败，下游将在下次对账时补齐')
  });

  const onTenantDataChanged = async ({ tenantId, domains }) => {
    const links = await services.registry.listEnabledLinksByTenant({ tenantId });
    links.forEach(({ app }) => invalidateDebouncer.schedule(`${app.appCode}:${tenantId}`, { domains: domains || [] }));
  };

  const onTenantStatusChanged = async ({ tenantId }) => await onTenantDataChanged({ tenantId, domains: ['tenant'] });

  const resyncTenant = async ({ tenantId, appCode }) => {
    const app = await services.registry.getApp({ appCode });
    const link = await models.tenant.findOne({ where: { tenantId, appCode } });
    if (!link) {
      return await linkTenantToApp({ tenantId, app });
    }
    await services.client.request({
      apiUrl: app.apiUrl,
      appId: app.appId,
      secretKey: app.secretKey,
      method: 'POST',
      path: '/open-api/snapshot/invalidate',
      body: { protocol: options.protocol, hostAppCode: options.appCode, sourceTenantId: String(tenantId), domains: ['tenant', 'role', 'org', 'user', 'permission'] }
    });
    await link.update({ lastSnapshotAt: new Date(), lastSnapshotError: null });
    services.session.invalidateSession({ appCode, tenantId });
    services.registry.manifestCache.remove(services.registry.manifestCacheKey({ appCode, sourceTenantId: tenantId }));
    return link;
  };

  const listLinks = async ({ tenantId }) => {
    const where = tenantId ? { tenantId } : {};
    const links = await models.tenant.findAll({ where, order: [['createdAt', 'DESC']] });
    return links.map(link => ({
      id: link.id,
      tenantId: link.tenantId,
      appCode: link.appCode,
      remoteTenantId: link.remoteTenantId,
      status: link.status,
      linkedAt: link.linkedAt,
      lastSnapshotAt: link.lastSnapshotAt,
      lastSnapshotError: link.lastSnapshotError
    }));
  };

  Object.assign(services, {
    lifecycle: {
      linkTenant,
      unlinkTenant,
      resyncTenant,
      listLinks,
      onTenantCreated,
      onTenantDataChanged,
      onTenantStatusChanged
    }
  });
});
