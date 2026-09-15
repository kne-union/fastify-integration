const fp = require('fastify-plugin');
const path = require('node:path');
const { IntegrationError } = require('./libs/utils/errors');
const capability = require('./libs/utils/capability');

// @kne/fastify-integration
//
// 租户级联邦：注册本插件即同时具备两侧能力，没有 host / guest 的模式开关。
// 一个部署可以既被上游托管（下游侧），又托管自己的下游（上游侧），
// 从而支持 A → B → C 的链式联邦。权限码前缀每跳只加/剥一层，天然逐级组合。
module.exports = fp(
  async (fastify, options) => {
    options = Object.assign(
      {},
      {
        name: 'integration',
        prefix: '/api/integration',
        dbTableNamePrefix: 't_',

        // 本应用在联邦中的身份。appCode 同时是它在上游权限树里的顶层模块 code，
        // 一经启用不可更改，否则上游已保存的权限码会全部失配。
        appCode: '',
        appName: '',
        appDescription: '',
        // 我暴露给上游的 integration 接口基地址，install 时下发给下游用于回拉
        selfApiUrl: '',
        // 我的业务接口基地址，写进 manifest 与换票响应，供上游代理转发定位
        apiBase: '',
        // 前端产物声明（cdnUrl / version / preset 等），由上游按需消费
        web: null,
        // 前端挂载点声明，例如 [{ code, name, permission, path, remote }]
        mounts: [],

        protocol: 1,
        // 联邦最大层级。manifest 是受控递归的，层级与成环都必须硬性兜住。
        maxDepth: 5,
        federationPathHeader: 'x-federation-path',

        manifestCacheTTL: 60 * 1000,
        manifestStaleTTL: 24 * 60 * 60 * 1000,
        // 上游连续改组织/角色时合并成一次失效信号，避免刷爆下游的全量拉取
        invalidateDebounce: 2000,
        snapshotDebounce: 2000,
        snapshotUserWarnThreshold: 5000,

        sessionExpiresIn: 2 * 60 * 60,
        sessionRefreshBuffer: 5 * 60 * 1000,
        signatureExpire: 3 * 60,
        requestTimeout: 15000,
        undici: undefined,

        autoLinkOnTenantCreated: true,

        tenantName: 'tenant',
        signatureName: 'signature',
        tenantUserContextName: 'tenantUserInfo',
        clientTokenHeader: 'x-client-user-token',

        getUserInfo: request => request.userInfo,
        getUserAuthenticate: () => {
          const tenant = fastify[options.tenantName];
          if (!tenant) {
            throw new Error('请先安装 @kne/fastify-tenant 插件或者实现 options.getUserAuthenticate');
          }
          return tenant.authenticate.user;
        },
        getTenantUserAuthenticate: () => {
          const tenant = fastify[options.tenantName];
          if (!tenant) {
            throw new Error('请先安装 @kne/fastify-tenant 插件或者实现 options.getTenantUserAuthenticate');
          }
          return tenant.authenticate.tenantUser;
        },
        getAdminUserAuthenticate: () => {
          if (!fastify.account) {
            throw new Error('请先安装 @kne/fastify-account 插件或者实现 options.getAdminUserAuthenticate');
          }
          return fastify.account.authenticate.admin;
        },
        // 入站 open-api 的身份收敛。默认要求签名绑定的是超管账号：
        // 这些接口能建租户、投影身份数据，仅凭一对密钥授权太宽。
        verifyOpenApiIdentity: async request => {
          const user = request.openApiPayload;
          if (!user) {
            throw new IntegrationError('INTEGRATION_OPEN_API_FORBIDDEN', '签名未绑定有效账号', 403);
          }
          const checkIsSuperAdmin = fastify.account && fastify.account.services && fastify.account.services.admin && fastify.account.services.admin.checkIsSuperAdmin;
          if (typeof checkIsSuperAdmin !== 'function') {
            return;
          }
          if (!(await checkIsSuperAdmin({ id: user.id }))) {
            throw new IntegrationError('INTEGRATION_OPEN_API_FORBIDDEN', '集成接口要求使用超级管理员签发的密钥', 403);
          }
        }
      },
      options
    );

    if (!options.appCode) {
      throw new Error('@kne/fastify-integration 必须配置 options.appCode');
    }
    if (!options.appName) {
      options.appName = options.appCode;
    }

    fastify.register(require('@kne/fastify-namespace'), {
      options,
      name: options.name,
      modules: [
        ['controllers', path.resolve(__dirname, './libs/controllers')],
        [
          'models',
          await fastify.sequelize.addModels(path.resolve(__dirname, './libs/models'), {
            prefix: options.dbTableNamePrefix,
            modelPrefix: options.name,
            tenantName: options.tenantName
          })
        ],
        ['services', path.resolve(__dirname, './libs/services')],
        [
          'utils',
          {
            code: require('./libs/utils/code'),
            federationPath: require('./libs/utils/federationPath'),
            capability
          }
        ]
      ]
    });

    // 权限树 provider 与生命周期钩子要等 fastify-tenant 与本插件的 services 都装配完，
    // 所以放到 onReady。这里只做同步注册，不发任何出站调用，避免占用 pluginTimeout。
    fastify.addHook('onReady', async () => {
      const namespace = fastify[options.name];
      const tenant = fastify[options.tenantName];
      const report = capability.inspect(tenant);

      if (!report.guest.ready) {
        fastify.log.warn({ missing: report.guest.missing }, `[integration] 下游能力不可用，需要 @kne/fastify-tenant ${report.requiredTenantVersion}；相关接口将返回 501`);
      }
      if (!report.host.ready) {
        fastify.log.warn({ missing: report.host.missing }, `[integration] 上游能力不可用，需要 @kne/fastify-tenant ${report.requiredTenantVersion}；权限树合并与租户联动将不生效`);
        return;
      }

      tenant.addPermissionProvider(namespace.services.provider.resolveModules);

      if (options.autoLinkOnTenantCreated) {
        tenant.addHook('tenantCreated', namespace.services.lifecycle.onTenantCreated);
      }
      tenant.addHook('tenantDataChanged', namespace.services.lifecycle.onTenantDataChanged);
      tenant.addHook('tenantStatusChanged', namespace.services.lifecycle.onTenantStatusChanged);
    });
  },
  {
    // 依赖填的是对端 fp 的注册名，与 npm 包名无关。
    // @kne/fastify-signature 未声明注册名，因此只能在运行时按命名空间检查。
    name: 'fastify-integration',
    dependencies: ['fastify-tenant']
  }
);
