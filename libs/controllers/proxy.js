const fp = require('fastify-plugin');
const replyFrom = require('@fastify/reply-from');
const { IntegrationError } = require('../utils/errors');
const { str, num, any, obj, success } = require('../schema/response');

const TAG = '集成-租户应用';

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  // 阶段三：租户用户的正式使用走上游代理转发。
  //
  // 走代理而不是让浏览器直连下游，解决的是三件事：
  // 同源（免跨域与第三方 Cookie）、下游凭据不落前端、上游可在此统一注入身份。
  // 浏览器只带上游自己的登录态，下游票据由服务端换取并注入。
  await fastify.register(replyFrom, { undici: options.undici });

  const stripPrefix = new RegExp(`^${options.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/proxy/[^/]+`);

  // 代理与换票共用：只有已开通（链接与应用均为启用）的下游才放行。
  // 换票时上游签发的身份断言带着租户信息，下游会据此懒建影子租户，这里不挡就等于绕过开通。
  const getEnabledLink = async ({ appCode, tenantUserInfo }) => {
    if (!tenantUserInfo) {
      throw new IntegrationError('INTEGRATION_TENANT_USER_REQUIRED', '缺少租户用户上下文，无法访问下游应用', 403);
    }
    const link = (await services.registry.listEnabledLinksByTenant({ tenantId: tenantUserInfo.tenantId })).find(item => item.app.appCode === appCode);
    if (!link) {
      throw new IntegrationError('INTEGRATION_TENANT_NOT_LINKED', `当前租户未开通 ${appCode}`, 403);
    }
    return link;
  };

  fastify.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    url: `${options.prefix}/proxy/:appCode/*`,
    // 返回的是下游原始响应（含非 JSON 与重定向），不声明 response，避免序列化干扰转发
    schema: {
      tags: [TAG],
      summary: '代理转发到下游应用',
      description:
        '把 {prefix}/proxy/{appCode}/ 之后的路径与查询串原样转发到下游业务接口（下游票据中的 apiBase，缺省为注册的 apiUrl），请求体不解析、原样转发。服务端自动换票并注入第三方登录票据请求头，剥掉上游的 cookie、authorization 与客户端登录 token；下游返回的重定向 Location 会改写回代理路径。返回下游的原始响应。当前租户须已开通该下游应用',
      params: {
        type: 'object',
        properties: {
          appCode: { description: '下游应用编码' },
          '*': { description: '转发到下游的路径（相对下游业务接口基地址）' }
        }
      }
    },
    onRequest: [options.getUserAuthenticate(), options.getTenantUserAuthenticate()],
    // 转发时必须拿到原始请求体，不能让 fastify 先解析成对象再由我序列化回去：
    // 上传等 multipart 请求一旦被解析就无法原样重放
    preParsing: async (request, reply, payload) => payload,
    handler: async (request, reply) => {
      const { appCode } = request.params;
      const tenantUserInfo = request[options.tenantUserContextName];
      const link = await getEnabledLink({ appCode, tenantUserInfo });

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
        tags: [TAG],
        summary: '为当前租户用户换取下游应用的登录票据',
        description:
          '供前端直连下游（加载下游前端资源、建立独立 SSE 等）时使用；票据按下游 + 租户 + 租户用户缓存，临近过期自动重新换取。返回值不含下游 secretKey。当前租户须已开通该下游应用（开通关系与应用均为启用），否则返回 403（INTEGRATION_TENANT_NOT_LINKED），与代理转发接口一致',
        body: {
          type: 'object',
          properties: {
            appCode: { type: 'string', description: '下游应用编码' },
            force: { type: 'boolean', default: false, description: '是否忽略缓存强制重新换票' }
          },
          required: ['appCode']
        },
        response: success(
          '下游登录票据',
          obj(undefined, {
            appCode: str('下游应用编码'),
            token: any('下游签发的第三方登录票据'),
            tokenHeader: any('携带票据的请求头名，下游未返回时为 x-third-login-token'),
            proxyBase: str('代理转发基路径：{prefix}/proxy/{appCode}'),
            expiresAt: num('票据过期时间戳（毫秒）')
          })
        )
      }
    },
    async request => {
      const tenantUserInfo = request[options.tenantUserContextName];
      await getEnabledLink({ appCode: request.body.appCode, tenantUserInfo });
      const session = await services.session.getSession({
        appCode: request.body.appCode,
        tenantUserInfo,
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
