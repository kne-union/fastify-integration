const fp = require('fastify-plugin');
const capability = require('../utils/capability');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const userAuthenticate = options.getUserAuthenticate();
  const adminAuthenticate = options.getAdminUserAuthenticate();
  const onRequest = [userAuthenticate, adminAuthenticate];

  const appCodeBody = {
    type: 'object',
    properties: { appCode: { type: 'string' } },
    required: ['appCode']
  };

  fastify.get(
    `${options.prefix}/admin/app/list`,
    {
      onRequest,
      schema: {
        summary: '下游应用列表',
        query: {
          type: 'object',
          properties: {
            filter: {
              type: 'object',
              default: {},
              properties: {
                keyword: { type: 'string' },
                status: { type: 'string', enum: ['enabled', 'disabled'] }
              },
              additionalProperties: true
            },
            perPage: { type: 'number', default: 20 },
            currentPage: { type: 'number', default: 1 }
          }
        }
      }
    },
    async request => await services.registry.listApps(request.query)
  );

  fastify.post(
    `${options.prefix}/admin/app/save`,
    {
      onRequest,
      schema: {
        summary: '注册或编辑下游应用（凭据留空表示不修改）',
        body: {
          type: 'object',
          properties: {
            appCode: { type: 'string' },
            name: { type: 'string' },
            apiUrl: { type: 'string' },
            appId: { type: 'string' },
            secretKey: { type: 'string' },
            status: { type: 'string', enum: ['enabled', 'disabled'] }
          },
          required: ['appCode', 'apiUrl']
        }
      }
    },
    async request => services.registry.toAppView(await services.registry.saveApp(request.body))
  );

  fastify.post(
    `${options.prefix}/admin/app/set-status`,
    {
      onRequest,
      schema: {
        summary: '启用或停用下游应用',
        body: {
          type: 'object',
          properties: {
            appCode: { type: 'string' },
            status: { type: 'string', enum: ['enabled', 'disabled'] }
          },
          required: ['appCode', 'status']
        }
      }
    },
    async request => {
      await services.registry.setAppStatus(request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/admin/app/remove`,
    {
      onRequest,
      schema: { summary: '删除下游应用注册', body: appCodeBody }
    },
    async request => {
      await services.registry.removeApp(request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/admin/app/install`,
    {
      onRequest,
      schema: { summary: '阶段一：向下游安装自己并下发回调凭据', body: appCodeBody }
    },
    async request =>
      await services.registry.install({
        appCode: request.body.appCode,
        authenticatePayload: options.getUserInfo(request)
      })
  );

  fastify.post(
    `${options.prefix}/admin/app/refresh-manifest`,
    {
      onRequest,
      schema: {
        summary: '强制刷新下游 manifest 缓存',
        body: {
          type: 'object',
          properties: {
            appCode: { type: 'string' },
            tenantId: { type: 'string' }
          },
          required: ['appCode']
        }
      }
    },
    async request =>
      await services.registry.getManifest({
        appCode: request.body.appCode,
        sourceTenantId: request.body.tenantId,
        force: true
      })
  );

  fastify.get(
    `${options.prefix}/admin/host/list`,
    {
      onRequest,
      schema: { summary: '上游应用列表（谁托管了我）' }
    },
    async () => ({ pageData: await services.hostRegistry.listHosts() })
  );

  fastify.post(
    `${options.prefix}/admin/host/set-status`,
    {
      onRequest,
      schema: {
        summary: '启用或停用上游应用',
        body: {
          type: 'object',
          properties: {
            hostAppCode: { type: 'string' },
            status: { type: 'string', enum: ['enabled', 'disabled'] }
          },
          required: ['hostAppCode', 'status']
        }
      }
    },
    async request => {
      await services.hostRegistry.setHostStatus(request.body);
      return {};
    }
  );

  fastify.get(
    `${options.prefix}/admin/tenant/list`,
    {
      onRequest,
      schema: {
        summary: '租户开通关系列表',
        query: {
          type: 'object',
          properties: { tenantId: { type: 'string' } }
        }
      }
    },
    async request => ({ pageData: await services.lifecycle.listLinks(request.query) })
  );

  fastify.post(
    `${options.prefix}/admin/tenant/link`,
    {
      onRequest,
      schema: {
        summary: '手动为租户开通下游应用',
        body: {
          type: 'object',
          properties: {
            tenantId: { type: 'string' },
            appCode: { type: 'string' }
          },
          required: ['tenantId', 'appCode']
        }
      }
    },
    async request => {
      await services.lifecycle.linkTenant(request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/admin/tenant/unlink`,
    {
      onRequest,
      schema: {
        summary: '手动停用租户对下游应用的开通',
        body: {
          type: 'object',
          properties: {
            tenantId: { type: 'string' },
            appCode: { type: 'string' }
          },
          required: ['tenantId', 'appCode']
        }
      }
    },
    async request => {
      await services.lifecycle.unlinkTenant(request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/admin/tenant/resync`,
    {
      onRequest,
      schema: {
        summary: '手动重投影：让下游重新回拉全量快照，用于自愈',
        body: {
          type: 'object',
          properties: {
            tenantId: { type: 'string' },
            appCode: { type: 'string' }
          },
          required: ['tenantId', 'appCode']
        }
      }
    },
    async request => {
      await services.lifecycle.resyncTenant(request.body);
      return {};
    }
  );

  fastify.get(
    `${options.prefix}/admin/diagnose`,
    {
      onRequest,
      schema: { summary: '自检：本机 appCode、tenant 联邦能力、下游快照投影状态' }
    },
    async () => ({
      appCode: options.appCode,
      protocol: options.protocol,
      capability: capability.inspect(fastify[options.tenantName]),
      snapshotStatus: services.guest.listSnapshotStatus()
    })
  );
});
