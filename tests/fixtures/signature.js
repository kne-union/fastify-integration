const fp = require('fastify-plugin');
const crypto = require('node:crypto');

// 测试用的 @kne/fastify-signature 替身。
// 真实包未声明 fp 注册名，所以本插件是按命名空间在运行时检查它的，这里只需形状一致。
module.exports = fp(async fastify => {
  const secrets = new Map();

  fastify.decorate('signature', {
    services: {
      create: async (authenticatePayload, { description }) => {
        const appId = crypto.randomUUID();
        const secretKey = crypto.randomBytes(16).toString('hex');
        secrets.set(appId, { secretKey, description, userId: authenticatePayload && authenticatePayload.id });
        return { appId, secretKey };
      }
    },
    authenticate: {
      openApi: async request => {
        const appId = request.headers['x-openapi-appid'];
        if (!appId) {
          const error = new Error('missing signature');
          error.statusCode = 401;
          throw error;
        }
        request.openApiPayload = { id: '1', isSuperAdmin: true };
      }
    },
    secrets
  });
});
