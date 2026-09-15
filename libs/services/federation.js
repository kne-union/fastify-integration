const fp = require('fastify-plugin');
const get = require('lodash/get');
const { IntegrationError } = require('../utils/errors');
const { toGuestCodes } = require('../utils/code');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  // 上游侧快照导出器。
  //
  // 这个模块必须**严格纯本地只读**：一次出站调用都不许有。
  // 原因是投影方向（上游导出 → 下游拉取）与权限树方向（上游拉下游 manifest）是相反的两条链，
  // 如果导出过程中再触发出站调用，两个方向就会形成真正的死锁环。
  // 与之相对，manifest 接口是有意受控递归的，靠联邦路径做成环检测。
  //
  // 中间层节点的影子行在本地是只读的，但它们正是本节点向自己下游投影的数据来源——
  // 只读保护约束的是管理端 UI 与业务代码，不约束这里的导出，因为导出是纯读。

  const tenantNamespace = () => {
    const namespace = fastify[options.tenantName];
    if (!namespace) {
      throw new IntegrationError('TENANT_PLUGIN_MISSING', `未检测到 @kne/fastify-tenant（命名空间 ${options.tenantName}）`, 501);
    }
    return namespace;
  };

  const asId = value => (value === null || value === undefined ? null : String(value));

  const asIdList = value => (Array.isArray(value) ? value.map(asId).filter(Boolean) : []);

  // 跨系统的图片路径无法解析，只透传绝对 URL
  const exportableLogo = logo => (typeof logo === 'string' && /^https?:\/\//.test(logo) ? logo : null);

  const exportTenantMeta = async ({ sourceTenantId }) => {
    const { models } = tenantNamespace();
    const tenant = await models.tenant.findByPk(sourceTenantId);
    if (!tenant) {
      throw new IntegrationError('TENANT_NOT_FOUND', `租户 ${sourceTenantId} 不存在`, 404);
    }
    return {
      sourceId: asId(tenant.id),
      name: tenant.name,
      status: tenant.status,
      description: tenant.description,
      logo: exportableLogo(tenant.logo),
      themeColor: tenant.themeColor
    };
  };

  const exportSnapshot = async ({ appCode, sourceTenantId }) => {
    if (!appCode) {
      throw new IntegrationError('INTEGRATION_APP_CODE_REQUIRED', 'appCode 不能为空', 400);
    }
    const { models } = tenantNamespace();

    const tenant = await models.tenant.findByPk(sourceTenantId);
    if (!tenant) {
      throw new IntegrationError('TENANT_NOT_FOUND', `租户 ${sourceTenantId} 不存在`, 404);
    }

    const [setting, roles, orgs, users] = await Promise.all([
      models.setting.findOne({ where: { tenantId: tenant.id } }),
      models.role.findAll({ where: { tenantId: tenant.id } }),
      models.org.findAll({ where: { tenantId: tenant.id } }),
      models.user.findAll({ where: { tenantId: tenant.id } })
    ]);

    if (users.length > options.snapshotUserWarnThreshold) {
      fastify.log.warn({ appCode, sourceTenantId, userCount: users.length }, '[integration] 快照用户数超过阈值，投影耗时可能较长');
    }

    return {
      protocol: options.protocol,
      hostAppCode: options.appCode,
      appCode,
      exportedAt: new Date().toISOString(),
      tenant: {
        sourceId: asId(tenant.id),
        name: tenant.name,
        status: tenant.status,
        description: tenant.description,
        logo: exportableLogo(tenant.logo),
        themeColor: tenant.themeColor
      },
      // 租户权限上限：上游租户为这个下游开通了哪些模块。
      // 下游写进自己的 setting.permissions，其 combinedPermissions 的求交逻辑就能原样工作。
      ceiling: toGuestCodes(appCode, get(setting, 'permissions', [])),
      roles: roles.map(role => ({
        sourceId: asId(role.id),
        // system 角色让下游按 code 映射到它自己已有的 admin / default，不新建影子行，
        // 这样 admin 短路返回全量 ceiling 的语义天然对齐
        code: role.code,
        type: role.type,
        name: role.name,
        description: role.description,
        status: role.status,
        permissions: toGuestCodes(appCode, role.permissions)
      })),
      orgs: orgs.map(org => ({
        sourceId: asId(org.id),
        parentSourceId: asId(org.parentId),
        name: org.name,
        description: org.description,
        index: org.index,
        status: org.status,
        leaderSourceId: asId(org.leaderUserId)
      })),
      users: users.map(user => ({
        sourceId: asId(user.id),
        name: user.name,
        avatar: user.avatar,
        gender: user.gender,
        email: user.email,
        phone: user.phone,
        description: user.description,
        status: user.status,
        roleSourceIds: asIdList(user.roles),
        tenantOrgSourceIds: asIdList(user.tenantOrgIds)
      }))
    };
  };

  // 供 session 换票时组装身份断言，语义与快照里的 users[] 单项一致，
  // 让下游可以在还没对账到这个人时先按需建好影子行
  const exportTenantUserAssertion = async ({ appCode, tenantUserInfo }) => {
    const { models } = tenantNamespace();
    const tenantId = get(tenantUserInfo, 'tenantId');
    const tenantUserId = get(tenantUserInfo, 'id');
    const tenant = await models.tenant.findByPk(tenantId);
    const tenantUser = await models.user.findByPk(tenantUserId);
    if (!tenant || !tenantUser) {
      throw new IntegrationError('TENANT_USER_NOT_FOUND', '当前租户用户不存在', 403);
    }
    return {
      protocol: options.protocol,
      hostAppCode: options.appCode,
      sourceTenantId: asId(tenant.id),
      tenant: {
        sourceId: asId(tenant.id),
        name: tenant.name,
        status: tenant.status,
        description: tenant.description,
        logo: exportableLogo(tenant.logo),
        themeColor: tenant.themeColor
      },
      sourceTenantUserId: asId(tenantUser.id),
      user: {
        sourceId: asId(tenantUser.id),
        name: tenantUser.name,
        avatar: tenantUser.avatar,
        gender: tenantUser.gender,
        email: tenantUser.email,
        phone: tenantUser.phone,
        status: tenantUser.status,
        roleSourceIds: asIdList(tenantUser.roles),
        tenantOrgSourceIds: asIdList(tenantUser.tenantOrgIds)
      }
    };
  };

  Object.assign(services, {
    federation: { exportTenantMeta, exportSnapshot, exportTenantUserAssertion }
  });
});
