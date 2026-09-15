const test = require('node:test');
const assert = require('node:assert');
const { build, getFreePort } = require('./fixtures/build');

const seedTenant = async fastify => {
  const { models } = fastify.tenant;
  const tenant = await models.tenant.create({ name: '本地租户', status: 'open' });
  await models.setting.create({ tenantId: tenant.id, permissions: ['setting:org:view', 'coach:tenant:plan:view', 'other:x:view'] });
  const admin = await models.role.create({ tenantId: tenant.id, name: '管理员', code: 'admin', type: 'system', permissions: [] });
  const custom = await models.role.create({ tenantId: tenant.id, name: '教练', type: 'custom', permissions: ['coach:tenant:plan:view', 'setting:org:view'] });
  const org = await models.org.create({ tenantId: tenant.id, name: '研发部' });
  const user = await models.user.create({ tenantId: tenant.id, name: '张三', email: 'z@example.com', roles: [custom.id], tenantOrgIds: [org.id] });
  await org.update({ leaderUserId: user.id });
  return { tenant, admin, custom, org, user };
};

test('插件能正常装载并注册两侧路由', async t => {
  const fastify = await build();
  t.after(() => fastify.close());

  [
    '/api/integration/open-api/app/install',
    '/api/integration/open-api/app/manifest',
    '/api/integration/open-api/tenant/link',
    '/api/integration/open-api/tenant/unlink',
    '/api/integration/open-api/snapshot/apply',
    '/api/integration/open-api/snapshot/invalidate',
    '/api/integration/open-api/session',
    '/api/integration/open-api/federation/snapshot',
    '/api/integration/admin/app/list',
    '/api/integration/admin/diagnose',
    '/api/integration/tenant/app/list',
    '/api/integration/proxy/:appCode/*'
  ].forEach(url => {
    assert.ok(fastify.registeredRoutes.includes(url), `缺少路由 ${url}`);
  });

  assert.deepEqual(Object.keys(fastify.integration.models).sort(), ['app', 'host', 'tenant']);
  assert.equal(fastify.integration.models.app.tableName, 't_integration_app');
  assert.equal(fastify.integration.models.tenant.tableName, 't_integration_tenant');
  assert.equal(fastify.integration.models.host.tableName, 't_integration_host');
});

test('appCode 缺失时直接拒绝启动', async () => {
  await assert.rejects(() => build({ appCode: '' }), /必须配置 options.appCode/);
});

test('不能把自己注册成上下游，否则权限树递归立刻成环', async t => {
  const fastify = await build();
  t.after(() => fastify.close());
  const { services } = fastify.integration;

  await assert.rejects(() => services.registry.saveApp({ appCode: 'self-app', apiUrl: 'https://x' }), /不能把自己/);
  await assert.rejects(() => services.hostRegistry.saveHost({ hostAppCode: 'self-app', apiUrl: 'https://x' }), /不能把自己/);
});

test('快照导出按 appCode 过滤权限码并剥掉一层前缀', async t => {
  const fastify = await build();
  t.after(() => fastify.close());
  const { tenant, custom, org, user } = await seedTenant(fastify);

  const snapshot = await fastify.integration.services.federation.exportSnapshot({ appCode: 'coach', sourceTenantId: tenant.id });

  assert.equal(snapshot.hostAppCode, 'self-app');
  assert.equal(snapshot.tenant.sourceId, String(tenant.id));
  assert.deepEqual(snapshot.ceiling, ['tenant:plan:view'], '上游自身与其它下游的码都不应出现');

  const customRole = snapshot.roles.find(item => item.sourceId === String(custom.id));
  assert.deepEqual(customRole.permissions, ['tenant:plan:view']);
  const systemRole = snapshot.roles.find(item => item.type === 'system');
  assert.equal(systemRole.code, 'admin', 'system 角色须带 code 供下游按 code 映射');

  assert.equal(snapshot.orgs[0].sourceId, String(org.id));
  assert.equal(snapshot.orgs[0].leaderSourceId, String(user.id));
  assert.deepEqual(snapshot.users[0].roleSourceIds, [String(custom.id)]);
  assert.deepEqual(snapshot.users[0].tenantOrgSourceIds, [String(org.id)]);
});

test('快照投影是幂等的，重复应用不会产生重复影子行', async t => {
  const fastify = await build();
  t.after(() => fastify.close());
  const { tenant } = await seedTenant(fastify);
  const { services } = fastify.integration;
  const { models } = fastify.tenant;

  await services.hostRegistry.saveHost({ hostAppCode: 'upstream', apiUrl: 'https://up.example.com/api/integration', callback: { appId: 'a', secretKey: 'b' }, inboundAppId: 'in-1' });
  const snapshot = await services.federation.exportSnapshot({ appCode: 'self-app', sourceTenantId: tenant.id });
  // 换个 appCode 让本地既是导出方也是投影方，只为验证投影幂等
  snapshot.hostAppCode = 'upstream';

  await services.guest.applySnapshot({ hostAppCode: 'upstream', snapshot });
  const afterFirst = await models.user.count({ where: { syncSource: 'federation:upstream' } });
  await services.guest.applySnapshot({ hostAppCode: 'upstream', snapshot });
  const afterSecond = await models.user.count({ where: { syncSource: 'federation:upstream' } });

  assert.equal(afterFirst, 1);
  assert.equal(afterSecond, 1, '同一份快照重复应用不应新增影子行');

  const shadow = await services.guest.getShadowTenant({ hostAppCode: 'upstream', sourceTenantId: tenant.id });
  assert.equal(shadow.source, 'upstream');
  const shadowSetting = await models.setting.findOne({ where: { tenantId: shadow.id } });
  assert.deepEqual(shadowSetting.permissions, snapshot.ceiling);
});

test('协议版本不一致时拒绝安装与投影', async t => {
  const fastify = await build();
  t.after(() => fastify.close());
  const { services } = fastify.integration;

  await assert.rejects(() => services.guest.install({ payload: { protocol: 99, hostAppCode: 'up', apiUrl: 'https://x' }, inboundAppId: 'in-1' }), /协议版本不匹配/);
  await assert.rejects(() => services.guest.applySnapshot({ hostAppCode: 'up', snapshot: { protocol: 99, tenant: { sourceId: '1' } } }), /协议版本不匹配/);
});

test('manifest 不带前缀，权限树前缀由上游 provider 负责', async t => {
  const fastify = await build();
  t.after(() => fastify.close());

  const manifest = await fastify.integration.services.manifest.build({});
  assert.equal(manifest.appCode, 'self-app');
  assert.equal(manifest.protocol, 1);
  assert.ok(Array.isArray(manifest.permissionTree));
  assert.equal(manifest.permissionTree[0].code, 'setting', '下游始终只说自己的语言，不带 {appCode}: 前缀');
});

test('权限树 provider 把下游整棵树挂在 appCode 顶层模块下', async t => {
  const fastify = await build();
  t.after(() => fastify.close());
  const { tenant } = await seedTenant(fastify);
  const { services, models } = fastify.integration;

  await services.registry.saveApp({ appCode: 'coach', name: '教练', apiUrl: 'https://coach.example.com/api/integration', appId: 'x', secretKey: 'y' });
  await models.tenant.create({ tenantId: tenant.id, appCode: 'coach', remoteTenantId: '999', status: 'enabled' });
  // 直接种下 manifest 缓存，避免测试里真的发出站请求。
  // 缓存 key 用的是本地 tenantId，因为 manifest 的 sourceTenantId 语义是"租户在我这边的 ID"。
  services.registry.manifestCache.set(services.registry.manifestCacheKey({ appCode: 'coach', sourceTenantId: tenant.id }), {
    name: '教练系统',
    permissionTree: [{ name: '管理端', code: 'tenant', modules: [{ name: '训练计划', code: 'plan', permissions: [{ name: '查看', code: 'view' }] }] }]
  });

  const modules = await services.provider.resolveModules({ tenantId: tenant.id });
  assert.equal(modules.length, 1);
  assert.equal(modules[0].code, 'coach');
  assert.equal(modules[0].name, '教练系统');
  assert.equal(modules[0].modules[0].code, 'tenant');

  // 上游合并后的完整码即 coach:tenant:plan:view
  const resolved = await fastify.tenant.resolvePermissions({ tenantId: tenant.id });
  const coachModule = resolved.modules.find(item => item.code === 'coach');
  assert.ok(coachModule, '下游权限树应作为顶层模块出现在上游权限树里');
});

test('下游拉取失败时权限树降级为跳过该下游而不是整体失败', async t => {
  const fastify = await build();
  t.after(() => fastify.close());
  const { tenant } = await seedTenant(fastify);
  const { services, models } = fastify.integration;

  await services.registry.saveApp({ appCode: 'broken', apiUrl: 'http://127.0.0.1:1/api/integration', appId: 'x', secretKey: 'y' });
  await models.tenant.create({ tenantId: tenant.id, appCode: 'broken', remoteTenantId: '1', status: 'enabled' });

  const modules = await services.provider.resolveModules({ tenantId: tenant.id });
  assert.deepEqual(modules, [], '拉不到的下游应被跳过，上游权限接口仍可用');
});

test('换票缓存按 tenantUserId 隔离，不同用户不会串号', async t => {
  const fastify = await build();
  t.after(() => fastify.close());
  const { tenant, user } = await seedTenant(fastify);
  const { services } = fastify.integration;

  await services.hostRegistry.saveHost({ hostAppCode: 'upstream', apiUrl: 'https://up.example.com/api/integration', callback: { appId: 'a', secretKey: 'b' }, inboundAppId: 'in-1' });
  const snapshot = await services.federation.exportSnapshot({ appCode: 'self-app', sourceTenantId: tenant.id });
  await services.guest.applySnapshot({ hostAppCode: 'upstream', snapshot });

  const first = await services.guest.createSession({
    hostAppCode: 'upstream',
    assertion: { protocol: 1, sourceTenantId: String(tenant.id), sourceTenantUserId: String(user.id), user: { sourceId: String(user.id), name: '张三' } }
  });
  assert.ok(first.token);
  assert.equal(first.tokenHeader, 'x-third-login-token');
  assert.ok(first.remoteTenantUserId);

  const second = await services.guest.createSession({
    hostAppCode: 'upstream',
    assertion: { protocol: 1, sourceTenantId: String(tenant.id), sourceTenantUserId: '888888', user: { sourceId: '888888', name: '新同事' } }
  });
  assert.notEqual(second.remoteTenantUserId, first.remoteTenantUserId, '未对账到的新用户应被懒建为独立影子用户');
});

test('未开通的租户不允许换票，也不允许导出快照', async t => {
  const fastify = await build();
  t.after(() => fastify.close());
  const { services } = fastify.integration;

  await services.hostRegistry.saveHost({ hostAppCode: 'upstream', apiUrl: 'https://up.example.com/api/integration', callback: { appId: 'a', secretKey: 'b' }, inboundAppId: 'in-1' });
  await assert.rejects(() => services.guest.createSession({ hostAppCode: 'upstream', assertion: { sourceTenantId: '404', sourceTenantUserId: '1' } }), /尚未开通/);
  await assert.rejects(() => services.federation.exportSnapshot({ appCode: 'coach', sourceTenantId: '404' }), /不存在/);
});

test('open-api 入站必须带签名', async t => {
  const fastify = await build();
  t.after(() => fastify.close());

  const noSignature = await fastify.inject({ method: 'GET', url: '/api/integration/open-api/app/manifest' });
  assert.equal(noSignature.statusCode, 401);

  // 签名通过但还没 install，反查不到上游，须拒绝
  const notInstalled = await fastify.inject({ method: 'GET', url: '/api/integration/open-api/app/manifest', headers: { 'x-openapi-appid': 'unknown' } });
  assert.equal(notInstalled.statusCode, 403);
});

test('manifest 接口按联邦路径挡住成环', async t => {
  const fastify = await build();
  t.after(() => fastify.close());
  await fastify.integration.services.hostRegistry.saveHost({ hostAppCode: 'upstream', apiUrl: 'https://up.example.com/api/integration', callback: { appId: 'a', secretKey: 'b' }, inboundAppId: 'in-1' });

  const ok = await fastify.inject({ method: 'GET', url: '/api/integration/open-api/app/manifest', headers: { 'x-openapi-appid': 'in-1', 'x-federation-path': 'upstream' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().appCode, 'self-app');

  const cycle = await fastify.inject({ method: 'GET', url: '/api/integration/open-api/app/manifest', headers: { 'x-openapi-appid': 'in-1', 'x-federation-path': 'upstream,self-app' } });
  assert.equal(cycle.statusCode, 508);

  const tooDeep = await fastify.inject({ method: 'GET', url: '/api/integration/open-api/app/manifest', headers: { 'x-openapi-appid': 'in-1', 'x-federation-path': 'a,b,c,d,e' } });
  assert.equal(tooDeep.statusCode, 508);
});

test('install 会向下游下发我签发的回调凭据并记下 callbackAppId', async t => {
  const upstream = await build({ appCode: 'host-app', appName: '上游' });
  const downstream = await build({ appCode: 'guest-app', appName: '下游', prefix: '/api/integration' });
  t.after(() => Promise.all([upstream.close(), downstream.close()]));

  await downstream.listen({ port: 0, host: '127.0.0.1' });
  const address = downstream.server.address();
  const apiUrl = `http://127.0.0.1:${address.port}/api/integration`;

  await upstream.integration.services.registry.saveApp({ appCode: 'guest-app', name: '下游', apiUrl, appId: 'any', secretKey: 'any' });
  const result = await upstream.integration.services.registry.install({ appCode: 'guest-app', authenticatePayload: { id: '1' } });

  assert.equal(result.appCode, 'guest-app');
  const app = await upstream.integration.services.registry.getApp({ appCode: 'guest-app' });
  assert.ok(app.callbackAppId, '上游须记下签发给下游的 callbackAppId 以便反查');
  assert.ok(app.installedAt);

  const host = await downstream.integration.services.hostRegistry.getHost({ hostAppCode: 'host-app' });
  assert.equal(host.apiUrl, 'https://self.example.com/api/integration');
  assert.equal(host.callbackAppId, app.callbackAppId);
  assert.ok(host.inboundAppId, '下游须记下上游入站用的 appId 以便从签名反查上游');
});

test('两个实例可跑通开通与回拉快照的完整链路', async t => {
  const [upstreamPort, downstreamPort] = await Promise.all([getFreePort(), getFreePort()]);
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}/api/integration`;
  const downstreamUrl = `http://127.0.0.1:${downstreamPort}/api/integration`;

  // selfApiUrl 必须在注册时就给对，下游才回拉得到
  const upstream = await build({ appCode: 'host-app', appName: '上游', selfApiUrl: upstreamUrl });
  const downstream = await build({ appCode: 'guest-app', appName: '下游', selfApiUrl: downstreamUrl, snapshotDebounce: 20 });
  t.after(() => Promise.all([upstream.close(), downstream.close()]));

  const { tenant, user } = await seedTenant(upstream);
  await upstream.tenant.models.setting.update({ permissions: ['setting:org:view', 'guest-app:tenant:plan:view'] }, { where: { tenantId: tenant.id } });
  await upstream.tenant.models.role.update({ permissions: ['guest-app:tenant:plan:view'] }, { where: { tenantId: tenant.id, type: 'custom' } });

  await Promise.all([upstream.listen({ port: upstreamPort, host: '127.0.0.1' }), downstream.listen({ port: downstreamPort, host: '127.0.0.1' })]);

  // 阶段一：配置并安装
  await upstream.integration.services.registry.saveApp({ appCode: 'guest-app', name: '下游', apiUrl: downstreamUrl, appId: 'any', secretKey: 'any' });
  await upstream.integration.services.registry.install({ appCode: 'guest-app', authenticatePayload: { id: '1' } });

  // 阶段二：开通租户。link 之后下游会去抖回拉全量快照。
  const link = await upstream.integration.services.lifecycle.linkTenant({ tenantId: tenant.id, appCode: 'guest-app' });
  assert.ok(link.remoteTenantId);

  await new Promise(resolve => setTimeout(resolve, 300));
  const [snapshotStatus] = downstream.integration.services.guest.listSnapshotStatus();
  assert.ok(snapshotStatus && snapshotStatus.ok, `回拉快照失败：${snapshotStatus && snapshotStatus.message}`);

  const shadow = await downstream.integration.services.guest.getShadowTenant({ hostAppCode: 'host-app', sourceTenantId: tenant.id });
  assert.equal(String(shadow.id), String(link.remoteTenantId));
  const shadowSetting = await downstream.tenant.models.setting.findOne({ where: { tenantId: shadow.id } });
  assert.deepEqual(shadowSetting.permissions, ['tenant:plan:view'], '下游只应看到剥掉自己前缀后的码');
  const shadowUser = await downstream.tenant.models.user.findOne({ where: { tenantId: shadow.id, sourceId: String(user.id) } });
  assert.ok(shadowUser, '快照回拉后应建好影子用户');

  // 阶段三：换票。上游拿到的票据可直接作为下游的第三方登录凭据。
  const session = await upstream.integration.services.session.getSession({ appCode: 'guest-app', tenantUserInfo: { id: user.id, tenantId: tenant.id } });
  assert.ok(session.token);
  assert.equal(String(session.remoteTenantId), String(shadow.id));
  assert.equal(String(session.remoteTenantUserId), String(shadowUser.id));

  const cached = await upstream.integration.services.session.getSession({ appCode: 'guest-app', tenantUserInfo: { id: user.id, tenantId: tenant.id } });
  assert.equal(cached.token, session.token, '未到续期窗口应复用缓存票据');

  // 上游权限树里应出现下游整棵树
  const modules = await upstream.integration.services.provider.resolveModules({ tenantId: tenant.id });
  assert.equal(modules.length, 1);
  assert.equal(modules[0].code, 'guest-app');
  assert.equal(modules[0].modules[0].code, 'setting', '下游的权限树原样嵌在 appCode 顶层模块下');

  // 停用后不删数据，只关状态
  await upstream.integration.services.lifecycle.unlinkTenant({ tenantId: tenant.id, appCode: 'guest-app' });
  await shadow.reload();
  assert.equal(shadow.status, 'closed');
  assert.ok(await downstream.tenant.models.user.findByPk(shadowUser.id), '停用不得删除下游业务身份数据');
});
