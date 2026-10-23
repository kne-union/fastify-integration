const fp = require('fastify-plugin');
const capability = require('../utils/capability');
const { str, num, bool, any, obj, arr, success, empty, appView, hostView, tenantLink, capabilitySide } = require('../schema/response');

const APP_TAG = '集成管理后台-下游应用';
const HOST_TAG = '集成管理后台-上游应用';
const TENANT_TAG = '集成管理后台-租户开通';
const DIAGNOSE_TAG = '集成管理后台-诊断';

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const userAuthenticate = options.getUserAuthenticate();
  const adminAuthenticate = options.getAdminUserAuthenticate();
  const onRequest = [userAuthenticate, adminAuthenticate];

  const appCodeBody = {
    type: 'object',
    properties: { appCode: { type: 'string', description: '下游应用编码' } },
    required: ['appCode']
  };

  const tenantAppBody = {
    type: 'object',
    properties: {
      tenantId: { type: 'string', description: '本地租户 ID' },
      appCode: { type: 'string', description: '下游应用编码' }
    },
    required: ['tenantId', 'appCode']
  };

  fastify.get(
    `${options.prefix}/admin/app/list`,
    {
      onRequest,
      schema: {
        tags: [APP_TAG],
        summary: '下游应用列表',
        description: '分页查询本应用托管的下游应用，按创建时间倒序；secretKey 只返回是否已配置',
        query: {
          type: 'object',
          properties: {
            filter: {
              type: 'object',
              default: {},
              description: '筛选条件',
              properties: {
                keyword: { type: 'string', description: '关键字，模糊匹配应用编码与名称' },
                status: { type: 'string', enum: ['enabled', 'disabled'], description: '按状态筛选：enabled 启用，disabled 停用' }
              },
              additionalProperties: true
            },
            perPage: { type: 'number', default: 20, description: '每页条数' },
            currentPage: { type: 'number', default: 1, description: '页码，从 1 开始' }
          }
        },
        response: success('下游应用分页列表', {
          type: 'object',
          additionalProperties: true,
          properties: {
            pageData: arr('当前页下游应用', appView),
            totalCount: num('符合条件的下游应用总数')
          }
        })
      }
    },
    async request => await services.registry.listApps(request.query)
  );

  fastify.post(
    `${options.prefix}/admin/app/save`,
    {
      onRequest,
      schema: {
        tags: [APP_TAG],
        summary: '注册或编辑下游应用（凭据留空表示不修改）',
        description: '按 appCode 新建或更新下游应用注册信息；不能把本应用自己注册为下游。编辑时 apiUrl、appId、secretKey 留空表示不修改，保存后清空 manifest 缓存',
        body: {
          type: 'object',
          properties: {
            appCode: { type: 'string', description: '下游应用编码，同时是它在本应用权限树里的顶层模块 code，启用后不应再修改' },
            name: { type: 'string', description: '下游应用名称' },
            apiUrl: { type: 'string', description: '下游 integration 接口基地址，末尾斜杠会被去掉；编辑时留空表示不修改' },
            appId: { type: 'string', description: '调用下游 open-api 的签名 appId（由下游签发）；编辑时留空表示不修改' },
            secretKey: { type: 'string', description: '调用下游 open-api 的签名 secretKey；编辑时留空表示不修改' },
            status: { type: 'string', enum: ['enabled', 'disabled'], description: '状态：enabled 启用，disabled 停用；新建时不传为 enabled' }
          },
          required: ['appCode', 'apiUrl']
        },
        response: success('保存后的下游应用', appView)
      }
    },
    async request => services.registry.toAppView(await services.registry.saveApp(request.body))
  );

  fastify.post(
    `${options.prefix}/admin/app/set-status`,
    {
      onRequest,
      schema: {
        tags: [APP_TAG],
        summary: '启用或停用下游应用',
        description: '停用后不再向该下游转发、换票或开通租户，并清空 manifest 缓存',
        body: {
          type: 'object',
          properties: {
            appCode: { type: 'string', description: '下游应用编码' },
            status: { type: 'string', enum: ['enabled', 'disabled'], description: '目标状态：enabled 启用，disabled 停用' }
          },
          required: ['appCode', 'status']
        },
        response: empty('设置成功，返回空对象')
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
      schema: {
        tags: [APP_TAG],
        summary: '删除下游应用注册',
        description: '删除下游应用及其全部租户开通关系（不通知下游），并清空 manifest 缓存',
        body: appCodeBody,
        response: empty('删除成功，返回空对象')
      }
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
      schema: {
        tags: [APP_TAG],
        summary: '阶段一：向下游安装自己并下发回调凭据',
        description: '用当前用户通过 @kne/fastify-signature 签发一对回调凭据，调用下游 /open-api/app/install 登记本应用并下发凭据，供下游回拉快照；成功后记录 callbackAppId 与安装时间。下游应用须为启用状态',
        body: appCodeBody,
        response: success('下游 /open-api/app/install 的原样返回，通常为 { protocol, appCode, name, hostAppCode }', any())
      }
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
        tags: [APP_TAG],
        summary: '强制刷新下游 manifest 缓存',
        description: '忽略缓存实时拉取下游 manifest 并写回缓存；拉取失败时按缓存降级规则返回过期数据或报错',
        body: {
          type: 'object',
          properties: {
            appCode: { type: 'string', description: '下游应用编码' },
            tenantId: { type: 'string', description: '本地租户 ID；传入时下游会把该租户开通的更下游权限树一并嵌入' }
          },
          required: ['appCode']
        },
        response: success('下游 manifest（原样返回），含 protocol、appCode、name、description、apiBase、web、mounts、permissionTree', any())
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
      schema: {
        tags: [HOST_TAG],
        summary: '上游应用列表（谁托管了我）',
        description: '列出所有 install 过本应用的上游，按创建时间倒序；回调密钥只返回是否已保存',
        response: success('上游应用列表', obj(undefined, { pageData: arr('上游应用', hostView) }))
      }
    },
    async () => ({ pageData: await services.hostRegistry.listHosts() })
  );

  fastify.post(
    `${options.prefix}/admin/host/set-status`,
    {
      onRequest,
      schema: {
        tags: [HOST_TAG],
        summary: '启用或停用上游应用',
        description: '停用后该上游调用本应用 open-api 会因无法反查上游而被拒绝',
        body: {
          type: 'object',
          properties: {
            hostAppCode: { type: 'string', description: '上游应用编码' },
            status: { type: 'string', enum: ['enabled', 'disabled'], description: '目标状态：enabled 启用，disabled 停用' }
          },
          required: ['hostAppCode', 'status']
        },
        response: empty('设置成功，返回空对象')
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
        tags: [TENANT_TAG],
        summary: '租户开通关系列表',
        description: '列出本地租户向下游应用的开通关系，按创建时间倒序',
        query: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: '只看该本地租户的开通关系；不传返回全部' } }
        },
        response: success('租户开通关系列表', obj(undefined, { pageData: arr('开通关系', tenantLink) }))
      }
    },
    async request => ({ pageData: await services.lifecycle.listLinks(request.query) })
  );

  fastify.post(
    `${options.prefix}/admin/tenant/link`,
    {
      onRequest,
      schema: {
        tags: [TENANT_TAG],
        summary: '手动为租户开通下游应用',
        description: '调用下游 /open-api/tenant/link 建立影子租户并记录开通关系（已存在则重新启用）；下游随后会回拉全量快照。下游应用须为启用状态，联邦路径成环时报错',
        body: tenantAppBody,
        response: empty('开通成功，返回空对象')
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
        tags: [TENANT_TAG],
        summary: '手动停用租户对下游应用的开通',
        description: '通知下游关闭影子租户（通知失败只记日志），本地开通关系标记为停用，并清除该租户的换票与 manifest 缓存；下游业务数据保留',
        body: tenantAppBody,
        response: empty('停用成功，返回空对象')
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
        tags: [TENANT_TAG],
        summary: '手动重投影：让下游重新回拉全量快照，用于自愈',
        description: '尚未开通时等同于开通；已开通时向下游推送全域失效信号，下游去抖后回拉全量快照，并清除该租户的换票与 manifest 缓存',
        body: tenantAppBody,
        response: empty('已触发重投影，返回空对象')
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
      schema: {
        tags: [DIAGNOSE_TAG],
        summary: '自检：本机 appCode、tenant 联邦能力、下游快照投影状态',
        description: '用于排查集成问题：返回本应用身份、@kne/fastify-tenant 是否具备上下游联邦能力，以及作为下游时各上游租户最近一次快照投影结果（进程内存，重启后清空）',
        response: success(
          '自检结果',
          obj(undefined, {
            appCode: str('本应用编码'),
            protocol: num('集成协议版本'),
            capability: obj('@kne/fastify-tenant 联邦能力检查', {
              guest: capabilitySide('下游能力（影子租户、快照投影、影子用户）'),
              host: capabilitySide('上游能力（权限树 provider、生命周期钩子）'),
              requiredTenantVersion: str('要求的 @kne/fastify-tenant 版本范围')
            }),
            snapshotStatus: arr(
              '各上游租户最近一次快照投影状态',
              obj('投影状态', {
                key: str('{hostAppCode}:{sourceTenantId}'),
                at: str('投影时间，ISO 字符串'),
                ok: bool('是否成功'),
                result: any('成功时 tenant 侧 applySnapshot 的返回'),
                message: str('失败时的错误信息')
              })
            )
          })
        )
      }
    },
    async () => ({
      appCode: options.appCode,
      protocol: options.protocol,
      capability: capability.inspect(fastify[options.tenantName]),
      snapshotStatus: services.guest.listSnapshotStatus()
    })
  );
});
