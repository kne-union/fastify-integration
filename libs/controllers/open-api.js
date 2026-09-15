const fp = require('fastify-plugin');
const { IntegrationError } = require('../utils/errors');
const federationPath = require('../utils/federationPath');
const context = require('../utils/context');

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
        summary: '上游安装：登记上游并接收其回调凭据',
        body: {
          type: 'object',
          properties: {
            protocol: { type: 'number' },
            hostAppCode: { type: 'string' },
            name: { type: 'string' },
            apiUrl: { type: 'string' },
            callback: {
              type: 'object',
              properties: {
                appId: { type: 'string' },
                secretKey: { type: 'string' }
              },
              required: ['appId', 'secretKey']
            }
          },
          required: ['protocol', 'hostAppCode', 'apiUrl', 'callback']
        }
      }
    },
    async request => await services.guest.install({ payload: request.body, inboundAppId: inboundAppId(request) })
  );

  fastify.get(
    `${options.prefix}/open-api/app/manifest`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        summary: '实时返回本应用的权限树与前端挂载声明',
        query: {
          type: 'object',
          properties: {
            sourceTenantId: { type: 'string' }
          }
        }
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
        summary: '开通租户：建立影子租户',
        body: {
          type: 'object',
          properties: {
            protocol: { type: 'number' },
            sourceTenantId: { type: 'string' },
            tenant: { type: 'object', additionalProperties: true }
          },
          required: ['sourceTenantId']
        }
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
        summary: '停用租户：关闭影子租户但保留业务数据',
        body: {
          type: 'object',
          properties: {
            protocol: { type: 'number' },
            sourceTenantId: { type: 'string' }
          },
          required: ['sourceTenantId']
        }
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
        summary: '上游主动推送全量快照并立即投影',
        body: {
          type: 'object',
          properties: {
            snapshot: { type: 'object', additionalProperties: true }
          },
          required: ['snapshot']
        }
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
        summary: '上游推送失效信号，由本应用去抖后回拉全量快照',
        body: {
          type: 'object',
          properties: {
            protocol: { type: 'number' },
            sourceTenantId: { type: 'string' },
            domains: { type: 'array', items: { type: 'string' }, default: [] }
          },
          required: ['sourceTenantId']
        }
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
        summary: '换票：按身份断言懒建影子用户并签发第三方登录票据',
        body: {
          type: 'object',
          properties: {
            protocol: { type: 'number' },
            sourceTenantId: { type: 'string' },
            sourceTenantUserId: { type: 'string' },
            tenant: { type: 'object', additionalProperties: true },
            user: { type: 'object', additionalProperties: true }
          },
          required: ['sourceTenantId', 'sourceTenantUserId']
        }
      }
    },
    async request => {
      const host = await resolveHost(request);
      return await services.guest.createSession({ hostAppCode: host.hostAppCode, assertion: request.body });
    }
  );
});
