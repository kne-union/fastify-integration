const fp = require('fastify-plugin');
const { IntegrationError } = require('../utils/errors');
const federationPath = require('../utils/federationPath');
const context = require('../utils/context');
const { str, num, bool, obj, success, manifest } = require('../schema/response');

const TAG = '集成开放接口-下游';
const PROTOCOL = { type: 'number', description: '上游使用的集成协议版本' };

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  // 下游侧 open-api：上游驱动我。全部经签名验证，且全部幂等。
  const openApiAuthenticate = async request => {
    const signature = fastify[options.signatureName];
    if (!signature || !signature.authenticate || typeof signature.authenticate.openApi !== 'function') {
      throw new IntegrationError('SIGNATURE_PLUGIN_MISSING', `未检测到 @kne/fastify-signature（命名空间 ${options.signatureName}）`, 501);
    }
    await signature.authenticate.openApi(request);
    await options.verifyOpenApiIdentity(request, fastify);
  };

  const inboundAppId = request => request.headers['x-openapi-appid'];

  // install 之前还没有 host 记录，所以此时只能相信签名本身；
  // install 之后的所有接口都必须能反查出是哪个上游在调。
  const resolveHost = async request => {
    const host = await services.hostRegistry.getHostByInboundAppId(inboundAppId(request));
    if (!host) {
      throw new IntegrationError('INTEGRATION_HOST_NOT_FOUND', '无法从入站签名反查上游应用，请先调用 /open-api/app/install', 403);
    }
    return host;
  };

  fastify.post(
    `${options.prefix}/open-api/app/install`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '上游安装：登记上游并接收其回调凭据',
        description: '由上游签名调用（默认要求签名绑定超级管理员）。协议版本须与本应用一致；按 hostAppCode 新建或更新上游记录并设为启用，保存回调凭据并记下本次入站签名 appId，之后的 open-api 调用据此反查上游。重复调用幂等',
        body: {
          type: 'object',
          properties: {
            protocol: { type: 'number', description: '上游使用的集成协议版本，须与本应用一致' },
            hostAppCode: { type: 'string', description: '上游应用编码，不能与本应用相同' },
            name: { type: 'string', description: '上游应用名称' },
            apiUrl: { type: 'string', description: '上游 integration 接口基地址，用于回拉快照' },
            callback: {
              type: 'object',
              description: '上游签发给本应用的回调凭据，用于回拉快照',
              properties: {
                appId: { type: 'string', description: '回调签名 appId' },
                secretKey: { type: 'string', description: '回调签名 secretKey' }
              },
              required: ['appId', 'secretKey']
            }
          },
          required: ['protocol', 'hostAppCode', 'apiUrl', 'callback']
        },
        response: success(
          '安装结果',
          obj(undefined, {
            protocol: num('本应用的集成协议版本'),
            appCode: str('本应用编码'),
            name: str('本应用名称'),
            hostAppCode: str('已登记的上游应用编码')
          })
        )
      }
    },
    async request => await services.guest.install({ payload: request.body, inboundAppId: inboundAppId(request) })
  );

  fastify.get(
    `${options.prefix}/open-api/app/manifest`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '实时返回本应用的权限树与前端挂载声明',
        description: '上游拉取本应用 manifest（实时生成不缓存）。权限码不带 appCode 前缀；按请求头中的联邦路径做成环与层级检测，成环或超过最大层级时返回 508',
        query: {
          type: 'object',
          properties: {
            sourceTenantId: { type: 'string', description: '租户在上游的 ID；传入且影子租户已建立时，权限树会嵌入该租户开通的更下游应用' }
          }
        },
        response: success('本应用 manifest', manifest)
      }
    },
    async request => {
      const host = await resolveHost(request);
      const pathList = federationPath.assertAcyclic({
        path: request.headers[options.federationPathHeader],
        appCode: options.appCode,
        maxDepth: options.maxDepth
      });
      return await services.manifest.build({
        hostAppCode: host.hostAppCode,
        sourceTenantId: request.query.sourceTenantId,
        federationPath: pathList
      });
    }
  );

  fastify.post(
    `${options.prefix}/open-api/tenant/link`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '开通租户：建立影子租户',
        description: '按上游 + sourceTenantId 幂等建立或更新影子租户，随后在后台去抖回拉全量快照；新建影子租户会触发 tenantCreated，进而级联开通到本应用自己的下游',
        body: {
          type: 'object',
          properties: {
            protocol: PROTOCOL,
            sourceTenantId: { type: 'string', description: '租户在上游的 ID' },
            tenant: { type: 'object', additionalProperties: true, description: '租户基本信息（name、status、description、logo、themeColor 等），用于建立影子租户' }
          },
          required: ['sourceTenantId']
        },
        response: success(
          '开通结果',
          obj(undefined, {
            protocol: num('本应用的集成协议版本'),
            appCode: str('本应用编码'),
            remoteTenantId: str('影子租户 ID'),
            name: str('影子租户名称')
          })
        )
      }
    },
    async request => {
      const host = await resolveHost(request);
      // 建影子租户会触发 tenantCreated，进而把这个租户继续开通到我的下游。
      // 把入站联邦路径放进上下文，级联出站时才能带上，成环拓扑才不会无限递归。
      const pathList = federationPath.assertAcyclic({
        path: request.headers[options.federationPathHeader],
        appCode: options.appCode,
        maxDepth: options.maxDepth
      });
      return await context.run({ federationPath: pathList }, () =>
        services.guest.linkTenant({
          hostAppCode: host.hostAppCode,
          sourceTenantId: request.body.sourceTenantId,
          tenant: request.body.tenant || {}
        })
      );
    }
  );

  fastify.post(
    `${options.prefix}/open-api/tenant/unlink`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '停用租户：关闭影子租户但保留业务数据',
        description: '把影子租户状态设为 closed，影子用户随之无法登录；业务数据保留。影子租户不存在时返回 404',
        body: {
          type: 'object',
          properties: {
            protocol: PROTOCOL,
            sourceTenantId: { type: 'string', description: '租户在上游的 ID' }
          },
          required: ['sourceTenantId']
        },
        response: success('停用结果', obj(undefined, { remoteTenantId: str('被停用的影子租户 ID') }))
      }
    },
    async request => {
      const host = await resolveHost(request);
      return await services.guest.unlinkTenant({ hostAppCode: host.hostAppCode, sourceTenantId: request.body.sourceTenantId });
    }
  );

  fastify.post(
    `${options.prefix}/open-api/snapshot/apply`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '上游主动推送全量快照并立即投影',
        description: '同步把快照投影到影子租户（权限上限、角色、组织、用户），幂等；快照协议版本须一致且须含 tenant.sourceId。投影完成后会继续向本应用自己的下游推失效信号',
        body: {
          type: 'object',
          properties: {
            snapshot: { type: 'object', additionalProperties: true, description: '全量快照，结构同上游 /open-api/federation/snapshot 的返回' }
          },
          required: ['snapshot']
        },
        response: success('投影结果：remoteTenantId 加上 @kne/fastify-tenant applySnapshot 的返回（如各类数据的投影条数）', obj(undefined, { remoteTenantId: str('影子租户 ID') }))
      }
    },
    async request => {
      const host = await resolveHost(request);
      return await services.guest.applySnapshot({ hostAppCode: host.hostAppCode, snapshot: request.body.snapshot });
    }
  );

  fastify.post(
    `${options.prefix}/open-api/snapshot/invalidate`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '上游推送失效信号，由本应用去抖后回拉全量快照',
        description: '只登记失效并立即返回；同一租户的多次信号在去抖窗口内合并为一次全量快照回拉，回拉结果可在 /admin/diagnose 查看',
        body: {
          type: 'object',
          properties: {
            protocol: PROTOCOL,
            sourceTenantId: { type: 'string', description: '租户在上游的 ID' },
            domains: {
              type: 'array',
              items: { type: 'string', description: '数据域' },
              default: [],
              description: '变更的数据域，如 tenant、role、org、user、permission；仅用于合并记录，回拉始终是全量'
            }
          },
          required: ['sourceTenantId']
        },
        response: success(
          '已受理',
          obj(undefined, {
            accepted: bool('是否已受理，固定为 true'),
            debounce: num('去抖等待时长（毫秒）')
          })
        )
      }
    },
    async request => {
      const host = await resolveHost(request);
      return await services.guest.invalidate({
        hostAppCode: host.hostAppCode,
        sourceTenantId: request.body.sourceTenantId,
        domains: request.body.domains
      });
    }
  );

  fastify.post(
    `${options.prefix}/open-api/session`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '换票：按身份断言懒建影子用户并签发第三方登录票据',
        description: '按上游身份断言 upsert 影子用户（影子租户不存在且断言带 tenant 时顺带建立），再签发 @kne/fastify-tenant 第三方登录票据，票据 payload 为影子租户用户 ID 与租户 ID',
        body: {
          type: 'object',
          properties: {
            protocol: PROTOCOL,
            sourceTenantId: { type: 'string', description: '租户在上游的 ID' },
            sourceTenantUserId: { type: 'string', description: '租户用户在上游的 ID' },
            tenant: { type: 'object', additionalProperties: true, description: '租户基本信息；影子租户尚未建立时用于懒建' },
            user: {
              type: 'object',
              additionalProperties: true,
              description: '用户资料（name、avatar、email、phone、status 等），以及 roleSourceIds、tenantOrgSourceIds（角色、组织在上游的 ID）'
            }
          },
          required: ['sourceTenantId', 'sourceTenantUserId']
        },
        response: success(
          '登录票据',
          obj(undefined, {
            protocol: num('本应用的集成协议版本'),
            appCode: str('本应用编码'),
            token: str('第三方登录票据'),
            tokenHeader: str('携带票据的请求头名'),
            apiBase: str('本应用业务接口基地址'),
            remoteTenantId: str('影子租户 ID'),
            remoteTenantUserId: str('影子租户用户 ID'),
            expiresAt: num('票据过期时间戳（毫秒）')
          })
        )
      }
    },
    async request => {
      const host = await resolveHost(request);
      return await services.guest.createSession({ hostAppCode: host.hostAppCode, assertion: request.body });
    }
  );
});
