const fp = require('fastify-plugin');
const get = require('lodash/get');
const { IntegrationError } = require('../utils/errors');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  // 上游侧换票与 token 缓存。
  // 缓存 key 必须含 tenantUserId，否则同一租户下的不同用户会串号拿到别人的票。
  const tokenStore = new Map();
  const pending = new Map();

  const cacheKey = ({ appCode, tenantId, tenantUserId }) => `${appCode}:${tenantId}:${tenantUserId}`;

  const isUsable = entry => entry && entry.expiresAt - Date.now() > options.sessionRefreshBuffer;

  const requestSession = async ({ appCode, tenantUserInfo }) => {
    const app = await services.registry.getApp({ appCode });
    const assertion = await services.federation.exportTenantUserAssertion({ appCode, tenantUserInfo });
    const session = await services.client.request({
      apiUrl: app.apiUrl,
      appId: app.appId,
      secretKey: app.secretKey,
      method: 'POST',
      path: '/open-api/session',
      body: assertion
    });
    if (!session || !session.token) {
      throw new IntegrationError('INTEGRATION_SESSION_FAILED', `下游 ${appCode} 未返回有效票据`, 502);
    }
    return {
      token: session.token,
      tokenHeader: session.tokenHeader || 'x-third-login-token',
      apiBase: session.apiBase,
      remoteTenantId: session.remoteTenantId,
      remoteTenantUserId: session.remoteTenantUserId,
      expiresAt: Number(session.expiresAt) || Date.now() + options.sessionExpiresIn * 1000
    };
  };

  const getSession = async ({ appCode, tenantUserInfo, force = false }) => {
    const tenantId = get(tenantUserInfo, 'tenantId');
    const tenantUserId = get(tenantUserInfo, 'id');
    if (!tenantId || !tenantUserId) {
      throw new IntegrationError('INTEGRATION_TENANT_USER_REQUIRED', '缺少租户用户上下文，无法换票', 403);
    }
    const key = cacheKey({ appCode, tenantId, tenantUserId });
    if (!force && isUsable(tokenStore.get(key))) {
      return tokenStore.get(key);
    }
    if (pending.has(key)) {
      return pending.get(key);
    }
    const task = (async () => {
      try {
        const session = await requestSession({ appCode, tenantUserInfo });
        tokenStore.set(key, session);
        return session;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, task);
    return task;
  };

  const invalidateSession = ({ appCode, tenantId, tenantUserId }) => {
    if (tenantUserId) {
      tokenStore.delete(cacheKey({ appCode, tenantId, tenantUserId }));
      return;
    }
    const scope = tenantId ? `${appCode}:${tenantId}:` : `${appCode}:`;
    [...tokenStore.keys()].filter(key => key.startsWith(scope)).forEach(key => tokenStore.delete(key));
  };

  Object.assign(services, {
    session: { getSession, invalidateSession }
  });
});
