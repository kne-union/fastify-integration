const fp = require('fastify-plugin');
const { IntegrationError } = require('../utils/errors');
const { str, num, obj, arr, success, snapshotTenant, snapshotUser } = require('../schema/response');

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
        tags: ['集成开放接口-上游回调'],
        summary: '导出租户全量快照（纯本地只读，按下游 appCode 过滤并剥一层权限码前缀）',
        description: '下游用 install 时下发的回调凭据签名调用，由入站 appId 反查是哪个下游；租户须已向该下游开通。权限码只保留属于该下游的部分并剥掉一层 appCode 前缀',
        query: {
          type: 'object',
          properties: {
            sourceTenantId: { type: 'string', description: '本应用（上游）的租户 ID' }
          },
          required: ['sourceTenantId']
        },
        response: success(
          '租户全量快照',
          obj(undefined, {
            protocol: num('集成协议版本'),
            hostAppCode: str('上游（本应用）编码'),
            appCode: str('下游应用编码'),
            exportedAt: str('导出时间，ISO 字符串'),
            tenant: snapshotTenant,
            ceiling: arr('租户权限上限：上游租户为该下游开通的权限码（已剥前缀）', str('权限码')),
            roles: arr(
              '角色列表',
              obj('角色', {
                sourceId: str('角色在上游的 ID'),
                code: str('角色编码；system 角色由下游按 code 映射到自己已有的角色'),
                type: str('角色类型：system 系统，custom 自定义'),
                name: str('角色名称'),
                description: str('描述'),
                status: str('角色状态'),
                permissions: arr('角色权限码（已剥前缀）', str('权限码'))
              })
            ),
            orgs: arr(
              '组织列表',
              obj('组织', {
                sourceId: str('组织在上游的 ID'),
                parentSourceId: str('上级组织在上游的 ID'),
                name: str('组织名称'),
                description: str('描述'),
                index: num('排序'),
                status: str('组织状态'),
                leaderSourceId: str('负责人在上游的用户 ID')
              })
            ),
            users: arr('租户用户列表', snapshotUser)
          })
        )
      }
    },
    async request => {
      const app = request.integrationApp;
      await assertLinked({ app, sourceTenantId: request.query.sourceTenantId });
      return await services.federation.exportSnapshot({ appCode: app.appCode, sourceTenantId: request.query.sourceTenantId });
    }
  );
});
