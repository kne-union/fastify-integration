'use strict';

const assert = require('node:assert/strict');
const { build } = require('./fixtures/build');

describe('openapi docs', () => {
  it('所有路由都有 tags、summary，参数都有用途说明，并声明 200 响应', async () => {
    const fastify = await build();
    // 代理路由返回下游原始响应，不声明 response schema
    const rawResponseRoutes = ['/api/integration/proxy/:appCode/*'];
    const routes = fastify.registeredRouteOptions.filter(route => route.method !== 'HEAD');

    const missing = [];
    const checkProps = (where, schema) => {
      if (!schema) return;
      [].concat(schema.oneOf || [], schema.anyOf || [], schema).forEach(item => {
        Object.entries(item.properties || {}).forEach(([key, prop]) => {
          if (!prop.description) missing.push(`${where}.${key}`);
          if (prop.type === 'object') checkProps(`${where}.${key}`, prop);
          if (prop.type === 'array' && prop.items) checkProps(`${where}.${key}[]`, prop.items);
        });
      });
    };
    routes.forEach(route => {
      const { schema = {} } = route;
      const name = `${route.method} ${route.url}`;
      if (!(schema.tags && schema.tags.length)) missing.push(`${name} tags`);
      if (!schema.summary) missing.push(`${name} summary`);
      if (!rawResponseRoutes.includes(route.url) && !(schema.response && schema.response[200] && schema.response[200].description)) missing.push(`${name} response`);
      checkProps(`${name} body`, schema.body);
      checkProps(`${name} query`, schema.querystring || schema.query);
      checkProps(`${name} params`, schema.params);
    });
    await fastify.close();
    assert.equal(routes.length, 24);
    assert.deepEqual(missing, []);
  });
});
