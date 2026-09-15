'use strict';

const assert = require('node:assert/strict');
const { build, getFreePort } = require('./fixtures/build');

describe('chain federation', () => {
  let apps = [];

  const track = app => {
    apps.push(app);
    return app;
  };

  afterEach(async () => {
    await Promise.all(apps.map(app => app.close()));
    apps = [];
  });

  // 链式联邦：A 托管 B，B 同时被 A 托管又托管 C。
  // 注册本插件即两侧能力齐备，中间层不需要任何特殊配置。
  it('A → B → C 三级联邦：权限码前缀逐级组合，租户开通逐级传导', async () => {
    const ports = { a: await getFreePort(), b: await getFreePort(), c: await getFreePort() };
    const url = key => `http://127.0.0.1:${ports[key]}/api/integration`;

    const a = track(await build({ appCode: 'a', appName: '顶层', selfApiUrl: url('a'), snapshotDebounce: 20, invalidateDebounce: 20 }));
    const b = track(await build({ appCode: 'b', appName: '中间层', selfApiUrl: url('b'), snapshotDebounce: 20, invalidateDebounce: 20 }));
    const c = track(await build({ appCode: 'c', appName: '末端', selfApiUrl: url('c'), snapshotDebounce: 20, invalidateDebounce: 20 }));

    await Promise.all([a.listen({ port: ports.a, host: '127.0.0.1' }), b.listen({ port: ports.b, host: '127.0.0.1' }), c.listen({ port: ports.c, host: '127.0.0.1' })]);

    // 拓扑：B 装 C，A 装 B
    await b.integration.services.registry.saveApp({ appCode: 'c', name: '末端', apiUrl: url('c'), appId: 'x', secretKey: 'y' });
    await b.integration.services.registry.install({ appCode: 'c', authenticatePayload: { id: '1' } });
    await a.integration.services.registry.saveApp({ appCode: 'b', name: '中间层', apiUrl: url('b'), appId: 'x', secretKey: 'y' });
    await a.integration.services.registry.install({ appCode: 'b', authenticatePayload: { id: '1' } });

    // A 的租户：ceiling 里 c 的能力写成两层前缀 b:c:...
    const tenant = await a.tenant.models.tenant.create({ name: '顶层租户', status: 'open' });
    await a.tenant.models.setting.create({ tenantId: tenant.id, permissions: ['setting:org:view', 'b:tenant:course:view', 'b:c:tenant:plan:view'] });
    const role = await a.tenant.models.role.create({ tenantId: tenant.id, name: '教练', type: 'custom', permissions: ['b:c:tenant:plan:view'] });
    const org = await a.tenant.models.org.create({ tenantId: tenant.id, name: '研发部' });
    const user = await a.tenant.models.user.create({ tenantId: tenant.id, name: '张三', roles: [role.id], tenantOrgIds: [org.id] });

    // A 开通 B。B 建影子租户时会触发自己的 tenantCreated，从而自动把这个租户继续开通到 C。
    await a.integration.services.lifecycle.linkTenant({ tenantId: tenant.id, appCode: 'b' });
    await new Promise(resolve => setTimeout(resolve, 800));

    const bStatus = b.integration.services.guest.listSnapshotStatus();
    assert.ok(bStatus[0] && bStatus[0].ok, `B 回拉 A 的快照失败：${bStatus[0] && bStatus[0].message}`);

    const bShadow = await b.integration.services.guest.getShadowTenant({ hostAppCode: 'a', sourceTenantId: tenant.id });
    const bSetting = await b.tenant.models.setting.findOne({ where: { tenantId: bShadow.id } });
    assert.deepEqual(bSetting.permissions.sort(), ['c:tenant:plan:view', 'tenant:course:view'], 'B 只剥自己那一层，c: 前缀原样留给下一跳');

    const cStatus = c.integration.services.guest.listSnapshotStatus();
    assert.ok(cStatus[0] && cStatus[0].ok, `C 回拉 B 的快照失败：${cStatus[0] && cStatus[0].message}`);

    const cShadow = await c.integration.services.guest.getShadowTenant({ hostAppCode: 'b', sourceTenantId: bShadow.id });
    const cSetting = await c.tenant.models.setting.findOne({ where: { tenantId: cShadow.id } });
    assert.deepEqual(cSetting.permissions, ['tenant:plan:view'], 'C 收到的是剥掉两层前缀后的码');

    // 身份也应逐级传导到末端
    const cUser = await c.tenant.models.user.findOne({ where: { tenantId: cShadow.id } });
    assert.ok(cUser, '用户身份应一路投影到末端');
    assert.equal(cUser.name, '张三');
    const cRole = await c.tenant.models.role.findOne({ where: { tenantId: cShadow.id, type: 'custom' } });
    assert.deepEqual(cRole.permissions, ['tenant:plan:view'], '角色授权也须逐级剥前缀');

    // A 的权限树里应看到 b，b 下面应嵌着 c
    const aModules = await a.integration.services.provider.resolveModules({ tenantId: tenant.id });
    const bModule = aModules.find(item => item.code === 'b');
    assert.ok(bModule, 'A 的权限树应含顶层模块 b');
    const nestedC = bModule.modules.find(item => item.code === 'c');
    assert.ok(nestedC, 'b 的子树里应嵌着 c，前缀因此组合成 b:c:...');
    assert.equal(nestedC.modules[0].code, 'setting', 'C 的权限树原样嵌在两层前缀之下');

    // 末端换票：A 的用户可一路换到 C 的登录票据
    const bSession = await a.integration.services.session.getSession({ appCode: 'b', tenantUserInfo: { id: user.id, tenantId: tenant.id } });
    assert.ok(bSession.token);
    const bShadowUser = await b.tenant.models.user.findOne({ where: { tenantId: bShadow.id } });
    const cSession = await b.integration.services.session.getSession({ appCode: 'c', tenantUserInfo: { id: bShadowUser.id, tenantId: bShadow.id } });
    assert.ok(cSession.token, '中间层可以用自己的影子用户继续向末端换票');
  });

  it('成环拓扑不会导致无限递归：A 托管 B 且 B 托管 A 时权限树拉取被挡下', async () => {
    const ports = { a: await getFreePort(), b: await getFreePort() };
    const url = key => `http://127.0.0.1:${ports[key]}/api/integration`;

    const a = track(await build({ appCode: 'a', selfApiUrl: url('a'), snapshotDebounce: 20 }));
    const b = track(await build({ appCode: 'b', selfApiUrl: url('b'), snapshotDebounce: 20 }));

    await Promise.all([a.listen({ port: ports.a, host: '127.0.0.1' }), b.listen({ port: ports.b, host: '127.0.0.1' })]);

    await a.integration.services.registry.saveApp({ appCode: 'b', apiUrl: url('b'), appId: 'x', secretKey: 'y' });
    await a.integration.services.registry.install({ appCode: 'b', authenticatePayload: { id: '1' } });
    await b.integration.services.registry.saveApp({ appCode: 'a', apiUrl: url('a'), appId: 'x', secretKey: 'y' });
    await b.integration.services.registry.install({ appCode: 'a', authenticatePayload: { id: '1' } });

    const tenant = await a.tenant.models.tenant.create({ name: '成环租户', status: 'open' });
    await a.tenant.models.setting.create({ tenantId: tenant.id, permissions: ['b:tenant:x:view'] });
    await a.integration.services.lifecycle.linkTenant({ tenantId: tenant.id, appCode: 'b' });
    await new Promise(resolve => setTimeout(resolve, 500));

    // A 拉 B 的 manifest 时路径为 a；B 回头拉 A 的 manifest 时路径为 a,b，
    // A 发现自己已在路径中，返回 508，B 降级为跳过该下游，递归就此终止。
    const modules = await a.integration.services.provider.resolveModules({ tenantId: tenant.id });
    const bModule = modules.find(item => item.code === 'b');
    assert.ok(bModule, '成环时仍应拿到 B 自己的权限树');
    assert.equal(
      bModule.modules.find(item => item.code === 'a'),
      undefined,
      'B 的子树里不应再出现 A，递归必须在成环处终止'
    );
  });
});
