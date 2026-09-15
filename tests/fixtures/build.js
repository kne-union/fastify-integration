const fastifyFactory = require('fastify');
const crypto = require('node:crypto');

// 起一个装了本插件的最小实例：sqlite 内存库 + tenant 替身 + signature 替身。
const build = async (options = {}) => {
  const fastify = fastifyFactory({ logger: false });

  const registeredRoutes = [];
  fastify.addHook('onRoute', route => registeredRoutes.push(route.url));
  fastify.decorate('registeredRoutes', registeredRoutes);

  await fastify.register(require('@kne/fastify-sequelize'), {
    db: { dialect: 'sqlite', storage: ':memory:', logging: false },
    modelsPath: null
  });

  await fastify.register(require('./tenant'));
  await fastify.register(require('./signature'));

  fastify.decorate('jwt', {
    sign: (payload, signOptions) => `test-token.${crypto.createHash('sha1').update(JSON.stringify({ payload, signOptions })).digest('hex').slice(0, 12)}`
  });

  await fastify.register(
    require('../../index'),
    Object.assign(
      {
        appCode: 'self-app',
        appName: '自身应用',
        selfApiUrl: 'https://self.example.com/api/integration',
        apiBase: 'https://self.example.com/api',
        getAdminUserAuthenticate: () => async () => {}
      },
      options
    )
  );

  await fastify.ready();
  await fastify.sequelize.sync({ force: true });
  return fastify;
};

// autoload 会给每个子插件一份 options 浅拷贝，注册后再改 options 不会传播到 services，
// 所以需要跨实例互调的测试必须在 build 之前就把地址定下来
const getFreePort = async () => {
  const net = require('node:net');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
};

module.exports = { build, getFreePort };
