const fp = require('fastify-plugin');
const { IntegrationError } = require('../utils/errors');
const { createTTLCache } = require('../utils/ttlCache');
const federationPath = require('../utils/federationPath');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;

  // manifest 实时拉取 + TTL 缓存 + 过期降级。
  // 缓存 key 必须含租户，因为带 sourceTenantId 的 manifest 会把下游自己的下游也嵌进权限树，
  // 不同租户开通的下游不同，树也就不同。
  const manifestCache = createTTLCache({
    ttl: options.manifestCacheTTL,
    staleTTL: options.manifestStaleTTL,
    onStale: (key, e) => fastify.log.warn({ err: e, key }, '[integration] manifest 拉取失败，使用过期缓存降级')
  });

  const normalizeApiUrl = apiUrl => String(apiUrl || '').replace(/\/+$/, '');

  const manifestCacheKey = ({ appCode, sourceTenantId }) => `${appCode}:${sourceTenantId || '-'}`;

  const saveApp = async ({ appCode, name, apiUrl, appId, secretKey, status }) => {
    if (!appCode) {
      throw new IntegrationError('INTEGRATION_APP_CODE_REQUIRED', 'appCode 不能为空', 400);
    }
    if (appCode === options.appCode) {
      // 自引用会让权限树递归立刻成环
      throw new IntegrationError('INTEGRATION_SELF_REFERENCE', `不能把自己（${options.appCode}）注册为下游应用`, 400);
    }
    const current = await models.app.findOne({ where: { appCode } });
    if (!current) {
      return await models.app.create({
        appCode,
        name,
        apiUrl: normalizeApiUrl(apiUrl),
        appId,
        secretKey,
        status: status || 'enabled'
      });
    }
    const patch = { name, status };
    if (apiUrl) {
      patch.apiUrl = normalizeApiUrl(apiUrl);
    }
    // 凭据留空表示不改，避免编辑名称时把密钥抹掉
    if (appId) {
      patch.appId = appId;
    }
    if (secretKey) {
      patch.secretKey = secretKey;
    }
    Object.keys(patch).forEach(key => patch[key] === undefined && delete patch[key]);
    await current.update(patch);
    manifestCache.clear();
    return current;
  };

  const getApp = async ({ appCode, requireEnabled = true }) => {
    const app = await models.app.findOne({ where: { appCode } });
    if (!app) {
      throw new IntegrationError('INTEGRATION_APP_NOT_FOUND', `下游应用 ${appCode} 未注册`, 404);
    }
    if (requireEnabled && app.status !== 'enabled') {
      throw new IntegrationError('INTEGRATION_APP_DISABLED', `下游应用 ${appCode} 已停用`, 403);
    }
    return app;
  };

  const getAppByCallbackAppId = async callbackAppId => {
    if (!callbackAppId) {
      return null;
    }
    return await models.app.findOne({ where: { callbackAppId: String(callbackAppId), status: 'enabled' } });
  };

  const listApps = async ({ currentPage = 1, perPage = 20, filter = {} } = {}) => {
    const where = {};
    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.keyword) {
      where[Op.or] = [{ appCode: { [Op.like]: `%${filter.keyword}%` } }, { name: { [Op.like]: `%${filter.keyword}%` } }];
    }
    const { count, rows } = await models.app.findAndCountAll({
      where,
      limit: perPage,
      offset: (currentPage - 1) * perPage,
      order: [['createdAt', 'DESC']]
    });
    return {
      pageData: rows.map(item => toAppView(item)),
      totalCount: count
    };
  };

  // secretKey 一律脱敏后返回，管理端只需要确认"配没配"，不需要看明文
  const toAppView = app => ({
    id: app.id,
    appCode: app.appCode,
    name: app.name,
    apiUrl: app.apiUrl,
    appId: app.appId,
    hasSecretKey: !!app.secretKey,
    callbackAppId: app.callbackAppId,
    status: app.status,
    installedAt: app.installedAt,
    manifestCachedAt: app.manifestCachedAt,
    manifestName: app.manifestCache && app.manifestCache.name,
    manifestVersion: app.manifestCache && app.manifestCache.web && app.manifestCache.web.version,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt
  });

  const setAppStatus = async ({ appCode, status }) => {
    const app = await getApp({ appCode, requireEnabled: false });
    await app.update({ status });
    manifestCache.clear();
  };

  const removeApp = async ({ appCode }) => {
    const app = await getApp({ appCode, requireEnabled: false });
    await models.tenant.destroy({ where: { appCode } });
    await app.destroy();
    manifestCache.clear();
  };

  // 阶段 1：向下游安装自己。
  // 同时下发一对我签发的回调凭据，下游用它回拉快照——"装了包天然可用"，
  // 不要求运维在两侧各配一遍。
  const install = async ({ appCode, authenticatePayload }) => {
    const app = await getApp({ appCode });
    const signature = fastify[options.signatureName];
    if (!signature || !signature.services || typeof signature.services.create !== 'function') {
      throw new IntegrationError('SIGNATURE_PLUGIN_MISSING', `未检测到 @kne/fastify-signature（命名空间 ${options.signatureName}），无法签发回调凭据`, 501);
    }
    const callback = await signature.services.create(authenticatePayload, {
      description: `integration callback for ${appCode}`
    });
    const result = await services.client.request({
      apiUrl: app.apiUrl,
      appId: app.appId,
      secretKey: app.secretKey,
      method: 'POST',
      path: '/open-api/app/install',
      body: {
        protocol: options.protocol,
        hostAppCode: options.appCode,
        name: options.appName,
        apiUrl: options.selfApiUrl,
        callback: {
          appId: callback.appId,
          secretKey: callback.secretKey
        }
      }
    });
    await app.update({ callbackAppId: String(callback.appId), installedAt: new Date() });
    manifestCache.remove(appCode);
    return result;
  };

  const fetchManifest = async ({ app, sourceTenantId, pathList }) => {
    const manifest = await services.client.request({
      apiUrl: app.apiUrl,
      appId: app.appId,
      secretKey: app.secretKey,
      method: 'GET',
      path: '/open-api/app/manifest',
      // sourceTenantId 始终是"租户在我这边的 ID"，由下游按 source+sourceId 反查影子租户。
      // 传下游的 remoteTenantId 会让它查不到，多级嵌套就此断开。
      query: { sourceTenantId },
      federationPath: pathList
    });
    await app.update({ manifestCache: manifest, manifestCachedAt: new Date() });
    return manifest;
  };

  const getManifest = async ({ appCode, sourceTenantId, federationPath: pathList, force = false }) => {
    const app = await getApp({ appCode });
    const key = manifestCacheKey({ appCode, sourceTenantId });
    return await manifestCache.wrap(key, () => fetchManifest({ app, sourceTenantId, pathList: federationPath.append(pathList, options.appCode) }), {
      force,
      // 进程重启后内存缓存是空的，此时用库里的缓存列兜底，避免冷启动即不可用
      fallback: () => app.manifestCache || null
    });
  };

  const listEnabledLinksByTenant = async ({ tenantId }) => {
    const links = await models.tenant.findAll({ where: { tenantId, status: 'enabled' } });
    if (links.length === 0) {
      return [];
    }
    const apps = await models.app.findAll({
      where: { appCode: { [Op.in]: links.map(item => item.appCode) }, status: 'enabled' }
    });
    const appByCode = new Map(apps.map(item => [item.appCode, item]));
    return links.filter(link => appByCode.has(link.appCode)).map(link => ({ link, app: appByCode.get(link.appCode) }));
  };

  const listEnabledApps = async () => await models.app.findAll({ where: { status: 'enabled' } });

  Object.assign(fastify[options.name].services, {
    registry: {
      saveApp,
      getApp,
      getAppByCallbackAppId,
      listApps,
      toAppView,
      setAppStatus,
      removeApp,
      install,
      getManifest,
      manifestCacheKey,
      listEnabledLinksByTenant,
      listEnabledApps,
      manifestCache
    }
  });
});
