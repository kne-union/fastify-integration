const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  // 租户端：当前租户开通了哪些下游应用，供前端决定渲染哪些挂载点。
  // manifest 拉不到时不让整个接口失败，降级成只返回注册信息。
  fastify.get(
    `${options.prefix}/tenant/app/list`,
    {
      onRequest: [options.getUserAuthenticate(), options.getTenantUserAuthenticate()],
      schema: { summary: '当前租户已开通的下游应用及其前端挂载声明' }
    },
    async request => {
      const tenantUserInfo = request[options.tenantUserContextName];
      const links = await services.registry.listEnabledLinksByTenant({ tenantId: tenantUserInfo.tenantId });
      const pageData = await Promise.all(
        links.map(async ({ app, link }) => {
          const base = {
            appCode: app.appCode,
            name: app.name,
            proxyBase: `${options.prefix}/proxy/${app.appCode}`,
            linkedAt: link.linkedAt
          };
          try {
            const manifest = await services.registry.getManifest({ appCode: app.appCode, sourceTenantId: tenantUserInfo.tenantId });
            return Object.assign(base, {
              name: manifest.name || app.name,
              description: manifest.description,
              web: manifest.web,
              mounts: manifest.mounts || [],
              available: true
            });
          } catch (e) {
            fastify.log.warn({ err: e, appCode: app.appCode }, '[integration] 拉取下游 manifest 失败，降级返回注册信息');
            return Object.assign(base, { mounts: [], available: false });
          }
        })
      );
      return { pageData };
    }
  );
});
