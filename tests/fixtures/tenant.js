const fp = require('fastify-plugin');
const path = require('node:path');

// 测试用的 @kne/fastify-tenant 替身。
// 只实现本插件真正依赖的那部分接口，同时充当"tenant 侧需要补哪些能力"的参考实现。
module.exports = fp(
  async fastify => {
    const models = await fastify.sequelize.addModels(path.resolve(__dirname, './tenant-models'), {
      prefix: 't_',
      modelPrefix: 'tenant'
    });

    const permissionProviders = [];
    const hooks = new Map();

    const emit = async (name, payload) => {
      for (const fn of hooks.get(name) || []) {
        await fn(payload);
      }
    };

    const ensureExternal = async ({ source, sourceId, name, status, description }) => {
      const current = await models.tenant.findOne({ where: { source, sourceId: String(sourceId) } });
      if (current) {
        await current.update({ name: name || current.name, description });
        return current;
      }
      const tenant = await models.tenant.create({ source, sourceId: String(sourceId), name: name || `external-${sourceId}`, status: status || 'open', description });
      // 影子租户也必须触发 tenantCreated：中间层节点要据此把这个租户继续向自己的下游开通，
      // 链式联邦就是靠这一步自动往下传导的
      await emit('tenantCreated', { tenantId: tenant.id });
      return tenant;
    };

    const setExternalTenantStatus = async ({ tenantId, status }) => {
      const tenant = await models.tenant.findByPk(tenantId);
      await tenant.update({ status });
      return tenant;
    };

    // tenant / role 用 source 列，org / user 复用已有的 syncSource 列，
    // 协议层只传一个 syncSource 字符串，由 tenant 侧决定各模型写哪一列
    const sourceColumn = model => (model === models.role ? 'source' : 'syncSource');

    const mapSourceIds = async (model, { tenantId, syncSource, sourceIds }) => {
      if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
        return [];
      }
      const rows = await model.findAll({ where: { tenantId, [sourceColumn(model)]: syncSource } });
      const bySourceId = new Map(rows.map(row => [String(row.sourceId), String(row.id)]));
      return sourceIds.map(sourceId => bySourceId.get(String(sourceId))).filter(Boolean);
    };

    const applySnapshot = async ({ tenantId, syncSource, snapshot }) => {
      const setting = await models.setting.findOne({ where: { tenantId } });
      if (setting) {
        await setting.update({ permissions: snapshot.ceiling || [] });
      } else {
        await models.setting.create({ tenantId, permissions: snapshot.ceiling || [] });
      }

      for (const role of snapshot.roles || []) {
        // system 角色按 code 映射到下游自己已有的 admin / default，不建影子行
        const where = role.type === 'system' ? { tenantId, code: role.code } : { tenantId, source: syncSource, sourceId: String(role.sourceId) };
        const current = await models.role.findOne({ where });
        if (current) {
          await current.update({ name: role.name, status: role.status, permissions: role.permissions || [] });
          continue;
        }
        await models.role.create(
          Object.assign({ tenantId, name: role.name, code: role.code, type: role.type, status: role.status, permissions: role.permissions || [] }, role.type === 'system' ? {} : { source: syncSource, sourceId: String(role.sourceId) })
        );
      }

      for (const org of snapshot.orgs || []) {
        const current = await models.org.findOne({ where: { tenantId, syncSource, sourceId: String(org.sourceId) } });
        if (current) {
          await current.update({ name: org.name, index: org.index, status: org.status });
          continue;
        }
        await models.org.create({ tenantId, syncSource, sourceId: String(org.sourceId), synced: true, name: org.name, index: org.index, status: org.status });
      }

      for (const user of snapshot.users || []) {
        await ensureExternalUser({ tenantId, syncSource, sourceId: user.sourceId, profile: user, roleSourceIds: user.roleSourceIds, tenantOrgSourceIds: user.tenantOrgSourceIds });
      }

      // 投影完成后本节点的身份数据变了，必须继续向自己的下游推失效信号，
      // 否则中间层的 ceiling 更新不会传导下去，链式联邦会在这一跳断掉
      await emit('tenantDataChanged', { tenantId, domains: ['tenant', 'role', 'org', 'user', 'permission'] });

      return { roles: (snapshot.roles || []).length, orgs: (snapshot.orgs || []).length, users: (snapshot.users || []).length };
    };

    const ensureExternalUser = async ({ tenantId, syncSource, sourceId, profile = {}, roleSourceIds = [], tenantOrgSourceIds = [] }) => {
      const [roles, tenantOrgIds] = await Promise.all([mapSourceIds(models.role, { tenantId, syncSource, sourceIds: roleSourceIds }), mapSourceIds(models.org, { tenantId, syncSource, sourceIds: tenantOrgSourceIds })]);
      const patch = { name: profile.name, avatar: profile.avatar, email: profile.email, phone: profile.phone, status: profile.status || 'enabled', roles, tenantOrgIds };
      const current = await models.user.findOne({ where: { tenantId, syncSource, sourceId: String(sourceId) } });
      if (current) {
        await current.update(patch);
        return current;
      }
      return await models.user.create(Object.assign({ tenantId, syncSource, sourceId: String(sourceId), synced: true }, patch));
    };

    const basePermissions = { modules: [{ name: '设置', code: 'setting', modules: [{ name: '组织架构', code: 'org', permissions: [{ name: '查看', code: 'view' }] }] }] };

    const resolvePermissions = async ({ tenantId, federationPath } = {}) => {
      const extra = await Promise.all(permissionProviders.map(provider => provider({ tenantId, federationPath })));
      return { modules: [...basePermissions.modules, ...extra.flat()] };
    };

    fastify.decorate('tenant', {
      options: { thirdLoginTokenHeader: 'x-third-login-token', tenantUserContextName: 'tenantUserInfo' },
      models,
      permissions: basePermissions,
      services: {
        tenant: { ensureExternal },
        federation: { applySnapshot, ensureExternalUser, setExternalTenantStatus }
      },
      authenticate: {
        user: async request => {
          request.userInfo = { id: request.headers['x-test-user-id'] || '1' };
        },
        tenantUser: async request => {
          request.tenantUserInfo = { id: request.headers['x-test-tenant-user-id'] || '1', tenantId: request.headers['x-test-tenant-id'] || '1' };
        }
      },
      addPermissionProvider: provider => permissionProviders.push(provider),
      addHook: (name, fn) => {
        hooks.set(name, [...(hooks.get(name) || []), fn]);
      },
      resolvePermissions,
      emit,
      hooks
    });
  },
  { name: 'fastify-tenant' }
);
