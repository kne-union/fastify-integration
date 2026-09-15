const fp = require('fastify-plugin');
const get = require('lodash/get');
const { IntegrationError } = require('../utils/errors');
const { buildTenantSource, buildSyncSource } = require('../utils/code');
const { createKeyedDebouncer } = require('../utils/debounce');
const capability = require('../utils/capability');
const context = require('../utils/context');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  // 下游侧：接收上游驱动，并在需要时回拉上游快照。
  //
  // 投影策略是"推送只推失效信号，数据一律走全量快照拉取"：
  // 上游数据变更时只告诉我"这个租户的哪些域脏了"，我自己回拉全量快照做 upsert。
  // 好处是幂等、无顺序问题、漏推最多延迟一个兜底周期；代价只是流量略大，
  // 而租户级的组织与角色数据量本来就小。

  const snapshotStatus = new Map();

  const tenantNamespace = () => {
    const namespace = fastify[options.tenantName];
    if (!namespace) {
      throw new IntegrationError('TENANT_PLUGIN_MISSING', `未检测到 @kne/fastify-tenant（命名空间 ${options.tenantName}）`, 501);
    }
    return namespace;
  };

  const assertGuestReady = () => capability.assertReady(capability.inspect(fastify[options.tenantName]), 'guest');

  // 建影子租户会触发 tenantCreated，从而把这个租户继续级联开通到我的下游。
  // 去抖后的快照回拉不在任何入站请求里，此时联邦路径是空的，成环检测就会失效。
  // 兜底规则：我在替上游 hostAppCode 干活，路径至少含它一跳。
  const withHostContext = (hostAppCode, fn) => {
    const inherited = context.federationPath();
    return context.run({ federationPath: inherited.length > 0 ? inherited : [hostAppCode] }, fn);
  };

  const install = async ({ payload, inboundAppId }) => {
    if (Number(payload.protocol) !== options.protocol) {
      throw new IntegrationError('INTEGRATION_PROTOCOL_MISMATCH', `协议版本不匹配：上游 ${payload.protocol}，本地 ${options.protocol}`, 409);
    }
    const host = await services.hostRegistry.saveHost({
      hostAppCode: payload.hostAppCode,
      name: payload.name,
      apiUrl: payload.apiUrl,
      callback: payload.callback,
      inboundAppId
    });
    return {
      protocol: options.protocol,
      appCode: options.appCode,
      name: options.appName,
      hostAppCode: host.hostAppCode
    };
  };

  const findShadowTenant = async ({ hostAppCode, sourceTenantId }) => {
    const { models } = tenantNamespace();
    return await models.tenant.findOne({
      where: { source: buildTenantSource(hostAppCode), sourceId: String(sourceTenantId) }
    });
  };

  const getShadowTenant = async ({ hostAppCode, sourceTenantId }) => {
    const tenant = await findShadowTenant({ hostAppCode, sourceTenantId });
    if (!tenant) {
      throw new IntegrationError('INTEGRATION_TENANT_NOT_LINKED', `上游 ${hostAppCode} 的租户 ${sourceTenantId} 尚未开通`, 404);
    }
    return tenant;
  };

  // 阶段 2：上游开通租户时调我，建影子租户。
  // 建完立即在后台回拉一次全量快照，不阻塞上游拿 remoteTenantId 的响应。
  const linkTenant = async ({ hostAppCode, sourceTenantId, tenant: tenantMeta }) => {
    assertGuestReady();
    await services.hostRegistry.getHost({ hostAppCode });
    const { services: tenantServices } = tenantNamespace();
    const tenant = await withHostContext(hostAppCode, () =>
      tenantServices.tenant.ensureExternal(
        Object.assign({}, tenantMeta, {
          source: buildTenantSource(hostAppCode),
          sourceId: String(sourceTenantId)
        })
      )
    );

    scheduleSnapshot(hostAppCode, String(sourceTenantId), { reason: 'link' });

    return {
      protocol: options.protocol,
      appCode: options.appCode,
      remoteTenantId: String(tenant.id),
      name: tenant.name
    };
  };

  // 停用不删数据：下游的业务数据仍然挂在这个影子租户上，
  // 关掉状态即可让 enrichTenantUserInfo 拒绝登录。
  const unlinkTenant = async ({ hostAppCode, sourceTenantId }) => {
    assertGuestReady();
    const tenant = await getShadowTenant({ hostAppCode, sourceTenantId });
    const { services: tenantServices } = tenantNamespace();
    await tenantServices.federation.setExternalTenantStatus({ tenantId: tenant.id, status: 'closed' });
    snapshotStatus.delete(`${hostAppCode}:${sourceTenantId}`);
    return { remoteTenantId: String(tenant.id) };
  };

  const applySnapshot = async ({ hostAppCode, snapshot }) => {
    assertGuestReady();
    if (Number(snapshot.protocol) !== options.protocol) {
      throw new IntegrationError('INTEGRATION_PROTOCOL_MISMATCH', `快照协议版本不匹配：上游 ${snapshot.protocol}，本地 ${options.protocol}`, 409);
    }
    const sourceTenantId = get(snapshot, 'tenant.sourceId');
    if (!sourceTenantId) {
      throw new IntegrationError('INTEGRATION_SNAPSHOT_INVALID', '快照缺少 tenant.sourceId', 400);
    }
    const { services: tenantServices } = tenantNamespace();
    // 投影完成后 tenant 侧会触发 tenantDataChanged，把 ceiling 变更继续推给我的下游，
    // 链式联邦的权限上限就是靠这一步逐级传导的，所以整段都要带上联邦上下文
    return await withHostContext(hostAppCode, async () => {
      const tenant = await tenantServices.tenant.ensureExternal(
        Object.assign({}, snapshot.tenant, {
          source: buildTenantSource(hostAppCode),
          sourceId: String(sourceTenantId)
        })
      );
      const result = await tenantServices.federation.applySnapshot({
        tenantId: tenant.id,
        syncSource: buildSyncSource(hostAppCode),
        snapshot
      });
      snapshotStatus.set(`${hostAppCode}:${sourceTenantId}`, { at: new Date().toISOString(), ok: true, result });
      return Object.assign({ remoteTenantId: String(tenant.id) }, result);
    });
  };

  // 回拉上游全量快照。注意这里用的是上游 install 时下发的回调凭据。
  const pullSnapshot = async ({ hostAppCode, sourceTenantId }) => {
    const host = await services.hostRegistry.getHost({ hostAppCode });
    const snapshot = await services.client.request({
      apiUrl: host.apiUrl,
      appId: host.callbackAppId,
      secretKey: host.callbackSecretKey,
      method: 'GET',
      path: '/open-api/federation/snapshot',
      query: { sourceTenantId }
    });
    return await applySnapshot({ hostAppCode, snapshot });
  };

  const snapshotDebouncer = createKeyedDebouncer({
    wait: options.snapshotDebounce,
    merge: (prev, next) => ({
      reason: next.reason || prev.reason,
      domains: [...new Set([...(prev.domains || []), ...(next.domains || [])])]
    }),
    onFlush: async key => {
      const separator = key.lastIndexOf(':');
      const hostAppCode = key.slice(0, separator);
      const sourceTenantId = key.slice(separator + 1);
      await pullSnapshot({ hostAppCode, sourceTenantId });
    },
    onError: (e, key) => {
      snapshotStatus.set(key, { at: new Date().toISOString(), ok: false, message: e.message });
      fastify.log.error({ err: e, key }, '[integration] 回拉上游快照失败，将在下次失效信号或手动重投影时重试');
    }
  });

  const scheduleSnapshot = (hostAppCode, sourceTenantId, payload) => snapshotDebouncer.schedule(`${hostAppCode}:${sourceTenantId}`, payload || {});

  const invalidate = async ({ hostAppCode, sourceTenantId, domains }) => {
    await services.hostRegistry.getHost({ hostAppCode });
    scheduleSnapshot(hostAppCode, String(sourceTenantId), { reason: 'invalidate', domains });
    return { accepted: true, debounce: options.snapshotDebounce };
  };

  // 阶段 3：上游代理转发前来换票。
  // 懒 upsert 只处理当前登录的这一个人，兜住"上游刚建好的新人还没被对账到"的窗口。
  const createSession = async ({ hostAppCode, assertion }) => {
    assertGuestReady();
    const sourceTenantId = get(assertion, 'sourceTenantId') || get(assertion, 'tenant.sourceId');
    const sourceTenantUserId = get(assertion, 'sourceTenantUserId') || get(assertion, 'user.sourceId');
    if (!sourceTenantId || !sourceTenantUserId) {
      throw new IntegrationError('INTEGRATION_ASSERTION_INVALID', '身份断言缺少 sourceTenantId 或 sourceTenantUserId', 400);
    }

    const { services: tenantServices, options: tenantOptions } = tenantNamespace();
    let tenant = await findShadowTenant({ hostAppCode, sourceTenantId });
    if (!tenant && assertion.tenant) {
      tenant = await withHostContext(hostAppCode, () =>
        tenantServices.tenant.ensureExternal(
          Object.assign({}, assertion.tenant, {
            source: buildTenantSource(hostAppCode),
            sourceId: String(sourceTenantId)
          })
        )
      );
      scheduleSnapshot(hostAppCode, String(sourceTenantId), { reason: 'session' });
    }
    if (!tenant) {
      throw new IntegrationError('INTEGRATION_TENANT_NOT_LINKED', `上游 ${hostAppCode} 的租户 ${sourceTenantId} 尚未开通`, 404);
    }

    const tenantUser = await tenantServices.federation.ensureExternalUser({
      tenantId: tenant.id,
      syncSource: buildSyncSource(hostAppCode),
      sourceId: String(sourceTenantUserId),
      profile: get(assertion, 'user', {}),
      roleSourceIds: get(assertion, 'user.roleSourceIds', []),
      tenantOrgSourceIds: get(assertion, 'user.tenantOrgSourceIds', [])
    });

    // 复用 fastify-tenant 现成的第三方登录票据格式：payload.id 是租户用户 id 而非平台账号 id，
    // 因此影子用户不需要绑定 account user 也能通过认证。
    const token = fastify.jwt.sign({ payload: { id: tenantUser.id, tenantId: tenant.id } }, { expiresIn: options.sessionExpiresIn });

    return {
      protocol: options.protocol,
      appCode: options.appCode,
      token,
      tokenHeader: tenantOptions.thirdLoginTokenHeader,
      apiBase: options.apiBase,
      remoteTenantId: String(tenant.id),
      remoteTenantUserId: String(tenantUser.id),
      expiresAt: Date.now() + options.sessionExpiresIn * 1000
    };
  };

  const listSnapshotStatus = () => [...snapshotStatus.entries()].map(([key, value]) => Object.assign({ key }, value));

  Object.assign(services, {
    guest: {
      install,
      findShadowTenant,
      getShadowTenant,
      linkTenant,
      unlinkTenant,
      applySnapshot,
      pullSnapshot,
      invalidate,
      scheduleSnapshot,
      createSession,
      listSnapshotStatus
    }
  });
});
