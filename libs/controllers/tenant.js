const fp = require('fastify-plugin');
const { str, bool, any, obj, arr, success } = require('../schema/response');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  // 租户端：当前租户开通了哪些下游应用，供前端决定渲染哪些挂载点。
  // manifest 拉不到时不让整个接口失败，降级成只返回注册信息。
  fastify.get(
    `${options.prefix}/tenant/app/list`,
    {
      onRequest: [options.getUserAuthenticate(), options.getTenantUserAuthenticate()],
      schema: {
        tags: ['集成-租户应用'],
        summary: '当前租户已开通的下游应用及其前端挂载声明',
        description: '列出当前租户已开通且启用的下游应用，并合并其 manifest（走缓存）供前端决定渲染哪些挂载点；某个下游 manifest 拉取失败时不影响整个接口，该项 available 为 false 且只返回注册信息',
        response: success(
          '已开通的下游应用',
          obj(undefined, {
            pageData: arr(
              '下游应用列表',
              obj('下游应用', {
                appCode: str('下游应用编码'),
                name: any('应用名称，优先取 manifest 中的名称'),
                proxyBase: str('代理转发基路径：{prefix}/proxy/{appCode}'),
                linkedAt: any('开通时间'),
                description: any('manifest 中的应用描述；manifest 不可用时不返回'),
                web: any('manifest 中的前端产物声明；manifest 不可用时不返回'),
                mounts: any('manifest 中的前端挂载点声明数组；manifest 不可用时为空数组'),
                available: bool('manifest 是否可用')
              })
            )
          })
        )
      }
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
