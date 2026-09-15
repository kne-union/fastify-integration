const fp = require('fastify-plugin');
const replyFrom = require('@fastify/reply-from');
const { IntegrationError } = require('../utils/errors');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  // 阶段三：租户用户的正式使用走上游代理转发。
  //
  // 走代理而不是让浏览器直连下游，解决的是三件事：
  // 同源（免跨域与第三方 Cookie）、下游凭据不落前端、上游可在此统一注入身份。
  // 浏览器只带上游自己的登录态，下游票据由服务端换取并注入。
  await fastify.register(replyFrom, { undici: options.undici });

  const stripPrefix = new RegExp(`^${options.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/proxy/[^/]+`);

  fastify.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    url: `${options.prefix}/proxy/:appCode/*`,
    onRequest: [options.getUserAuthenticate(), options.getTenantUserAuthenticate()],
    // 转发时必须拿到原始请求体，不能让 fastify 先解析成对象再由我序列化回去：
    // 上传等 multipart 请求一旦被解析就无法原样重放
    preParsing: async (request, reply, payload) => payload,
    handler: async (request, reply) => {
      const { appCode } = request.params;
      const tenantUserInfo = request[options.tenantUserContextName];
      if (!tenantUserInfo) {
        throw new IntegrationError('INTEGRATION_TENANT_USER_REQUIRED', '缺少租户用户上下文，无法转发', 403);
      }

      const link = (await services.registry.listEnabledLinksByTenant({ tenantId: tenantUserInfo.tenantId })).find(item => item.app.appCode === appCode);
      if (!link) {
        throw new IntegrationError('INTEGRATION_TENANT_NOT_LINKED', `当前租户未开通 ${appCode}`, 403);
      }

      const session = await services.session.getSession({ appCode, tenantUserInfo });
      const target = String(session.apiBase || link.app.apiUrl).replace(/\/+$/, '');
      const suffix = request.url.replace(stripPrefix, '');

      return reply.from(`${target}${suffix}`, {
        rewriteRequestHeaders: (originalRequest, headers) => {
          const next = Object.assign({}, headers, {
            [session.tokenHeader]: session.token,
            'x-forwarded-host': headers.host,
            'x-integration-host-app-code': options.appCode
          });
          // 上游自己的登录凭据不能透传给下游：下游只认注入的第三方登录票据
          delete next.host;
          delete next.cookie;
          delete next.authorization;
          delete next[options.clientTokenHeader];
          return next;
        },
        // 上游与下游域名不同，重定向的 Location 必须改写回代理路径，
        // 否则浏览器会跳到下游裸域并丢掉身份
        rewriteHeaders: headers => {
          if (!headers.location) {
            return headers;
          }
          const next = Object.assign({}, headers);
          if (next.location.startsWith(target)) {
            next.location = `${options.prefix}/proxy/${appCode}${next.location.slice(target.length)}`;
          } else if (next.location.startsWith('/')) {
            next.location = `${options.prefix}/proxy/${appCode}${next.location}`;
          }
          return next;
        }
      });
    }
  });

  // 换票接口：前端若需要直连下游（例如加载下游前端资源或建立独立 SSE），
  // 可先取一次票据。返回值不含下游 secretKey，只有短时效 token。
  fastify.post(
    `${options.prefix}/tenant/app/session`,
    {
      onRequest: [options.getUserAuthenticate(), options.getTenantUserAuthenticate()],
      schema: {
        summary: '为当前租户用户换取下游应用的登录票据',
        body: {
          type: 'object',
          properties: {
            appCode: { type: 'string' },
            force: { type: 'boolean', default: false }
          },
          required: ['appCode']
        }
      }
    },
    async request => {
      const session = await services.session.getSession({
        appCode: request.body.appCode,
        tenantUserInfo: request[options.tenantUserContextName],
        force: request.body.force
      });
      return {
        appCode: request.body.appCode,
        token: session.token,
        tokenHeader: session.tokenHeader,
        proxyBase: `${options.prefix}/proxy/${request.body.appCode}`,
        expiresAt: session.expiresAt
      };
    }
  );
});
