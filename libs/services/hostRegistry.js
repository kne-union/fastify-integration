const fp = require('fastify-plugin');
const { IntegrationError } = require('../utils/errors');

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];

  const normalizeApiUrl = apiUrl => String(apiUrl || '').replace(/\/+$/, '');

  // 上游调 install 时把自己登记进来，并记下它这次用的 inboundAppId，
  // 后续它再调我时就能从入站签名反查是哪个上游（进而决定权限码用哪个前缀过滤）。
  const saveHost = async ({ hostAppCode, name, apiUrl, callback, inboundAppId }) => {
    if (!hostAppCode) {
      throw new IntegrationError('INTEGRATION_HOST_CODE_REQUIRED', 'hostAppCode 不能为空', 400);
    }
    if (hostAppCode === options.appCode) {
      throw new IntegrationError('INTEGRATION_SELF_REFERENCE', `不能把自己（${options.appCode}）登记为上游应用`, 400);
    }
    const patch = {
      name,
      apiUrl: normalizeApiUrl(apiUrl),
      inboundAppId: inboundAppId ? String(inboundAppId) : undefined,
      installedAt: new Date(),
      status: 'enabled'
    };
    if (callback && callback.appId) {
      patch.callbackAppId = String(callback.appId);
    }
    if (callback && callback.secretKey) {
      patch.callbackSecretKey = callback.secretKey;
    }
    Object.keys(patch).forEach(key => patch[key] === undefined && delete patch[key]);

    const current = await models.host.findOne({ where: { hostAppCode } });
    if (!current) {
      return await models.host.create(Object.assign({ hostAppCode }, patch));
    }
    await current.update(patch);
    return current;
  };

  const getHost = async ({ hostAppCode, requireEnabled = true }) => {
    const host = await models.host.findOne({ where: { hostAppCode } });
    if (!host) {
      throw new IntegrationError('INTEGRATION_HOST_NOT_FOUND', `上游应用 ${hostAppCode} 未安装`, 404);
    }
    if (requireEnabled && host.status !== 'enabled') {
      throw new IntegrationError('INTEGRATION_HOST_DISABLED', `上游应用 ${hostAppCode} 已停用`, 403);
    }
    return host;
  };

  const getHostByInboundAppId = async inboundAppId => {
    if (!inboundAppId) {
      return null;
    }
    return await models.host.findOne({ where: { inboundAppId: String(inboundAppId), status: 'enabled' } });
  };

  const toHostView = host => ({
    id: host.id,
    hostAppCode: host.hostAppCode,
    name: host.name,
    apiUrl: host.apiUrl,
    inboundAppId: host.inboundAppId,
    hasCallbackCredential: !!(host.callbackAppId && host.callbackSecretKey),
    status: host.status,
    installedAt: host.installedAt,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt
  });

  const listHosts = async () => (await models.host.findAll({ order: [['createdAt', 'DESC']] })).map(toHostView);

  const setHostStatus = async ({ hostAppCode, status }) => {
    const host = await getHost({ hostAppCode, requireEnabled: false });
    await host.update({ status });
  };

  Object.assign(fastify[options.name].services, {
    hostRegistry: {
      saveHost,
      getHost,
      getHostByInboundAppId,
      listHosts,
      toHostView,
      setHostStatus
    }
  });
});
