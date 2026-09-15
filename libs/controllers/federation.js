const fp = require('fastify-plugin');
const { IntegrationError } = require('../utils/errors');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  // 上游侧回拉接口：下游用我 install 时下发的回调凭据来调。
  //
  // 这里**严格纯本地只读，不得触发任何出站调用**，否则会与投影方向形成死锁环。
  // 另一条硬约束是必须由入站 appId 反查出是哪个下游在调，
  // 再据此过滤权限码——上游的角色里混着自己的码和多个下游的码，
  // 下游只应看到剥掉自己那层前缀后的部分，看不到其它下游或上游自身的码。
  const callbackAuthenticate = async request => {
    const signature = fastify[options.signatureName];
    if (!signature || !signature.authenticate || typeof signature.authenticate.openApi !== 'function') {
      throw new IntegrationError('SIGNATURE_PLUGIN_MISSING', `未检测到 @kne/fastify-signature（命名空间 ${options.signatureName}）`, 501);
    }
    await signature.authenticate.openApi(request);
    const app = await services.registry.getAppByCallbackAppId(request.headers['x-openapi-appid']);
    if (!app) {
      throw new IntegrationError('INTEGRATION_APP_NOT_FOUND', '无法从入站签名反查下游应用，请重新执行安装以刷新回调凭据', 403);
    }
    request.integrationApp = app;
  };

  const assertLinked = async ({ app, sourceTenantId }) => {
    const link = await fastify[options.name].models.tenant.findOne({
      where: { tenantId: sourceTenantId, appCode: app.appCode, status: 'enabled' }
    });
    if (!link) {
      throw new IntegrationError('INTEGRATION_TENANT_NOT_LINKED', `租户 ${sourceTenantId} 未向 ${app.appCode} 开通`, 403);
    }
    return link;
  };

  fastify.get(
    `${options.prefix}/open-api/federation/snapshot`,
    {
      onRequest: [callbackAuthenticate],
      schema: {
        summary: '导出租户全量快照（纯本地只读，按下游 appCode 过滤并剥一层权限码前缀）',
        query: {
          type: 'object',
          properties: {
            sourceTenantId: { type: 'string' }
          },
          required: ['sourceTenantId']
        }
      }
    },
    async request => {
      const app = request.integrationApp;
      await assertLinked({ app, sourceTenantId: request.query.sourceTenantId });
      return await services.federation.exportSnapshot({ appCode: app.appCode, sourceTenantId: request.query.sourceTenantId });
    }
  );
});
