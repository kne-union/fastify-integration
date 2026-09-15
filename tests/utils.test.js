'use strict';

const assert = require('node:assert/strict');
const code = require('../libs/utils/code');
const federationPath = require('../libs/utils/federationPath');
const { createTTLCache } = require('../libs/utils/ttlCache');
const { createKeyedDebouncer } = require('../libs/utils/debounce');

describe('utils', () => {
  it('前缀只加剥一层，多级联邦时逐级组合', () => {
    assert.equal(code.toHostCode('coach', 'tenant:project:view'), 'coach:tenant:project:view');
    // b 站点收到 a:b:x 时只剥自己那一层，剩下的留给下一跳
    assert.equal(code.toGuestCode('a', 'a:b:x'), 'b:x');
    assert.equal(code.toGuestCode('a', 'b:x'), null);
    assert.equal(code.toGuestCode('a', 'a:'), null);
  });

  it('过滤只保留属于该下游的码，其它下游与上游自身的码不外泄', () => {
    const hostCodes = ['setting:org:view', 'coach:tenant:plan:view', 'coach:tenant:plan:edit', 'other:tenant:x:view'];
    assert.deepEqual(code.toGuestCodes('coach', hostCodes), ['tenant:plan:view', 'tenant:plan:edit']);
    assert.deepEqual(code.toGuestCodes('coach', []), []);
  });

  it('联邦路径能挡住成环与超深递归', () => {
    assert.deepEqual(federationPath.parse('a, b ,,c'), ['a', 'b', 'c']);
    assert.deepEqual(federationPath.append('a,b', 'c'), ['a', 'b', 'c']);
    assert.doesNotThrow(() => federationPath.assertAcyclic({ path: 'a,b', appCode: 'c', maxDepth: 5 }));
    assert.throws(() => federationPath.assertAcyclic({ path: 'a,b', appCode: 'a', maxDepth: 5 }), /环路/);
    assert.throws(() => federationPath.assertAcyclic({ path: 'a,b,c', appCode: 'd', maxDepth: 3 }), /层级超过上限/);
  });

  it('TTL 缓存在拉取失败时用过期数据降级', async () => {
    const cache = createTTLCache({ ttl: 10, staleTTL: 10000 });
    assert.equal(await cache.wrap('k', async () => 'v1'), 'v1');
    assert.equal(await cache.wrap('k', async () => 'v2'), 'v1', '未过期时不应重新拉取');

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(
      await cache.wrap('k', async () => {
        throw new Error('下游不可用');
      }),
      'v1',
      '过期后拉取失败应返回过期值'
    );

    const empty = createTTLCache({ ttl: 10 });
    await assert.rejects(
      empty.wrap('k', async () => {
        throw new Error('下游不可用');
      }),
      /下游不可用/,
      '没有任何缓存时应把错误抛出去'
    );
  });

  it('TTL 缓存在无缓存且拉取失败时可用 fallback 兜底', async () => {
    const cache = createTTLCache({ ttl: 10 });
    const value = await cache.wrap(
      'k',
      async () => {
        throw new Error('下游不可用');
      },
      { fallback: () => ({ from: 'db' }) }
    );
    assert.deepEqual(value, { from: 'db' });
  });

  it('去抖把同一租户的多次变更合并成一次，并合并域集合', async () => {
    const flushed = [];
    const debouncer = createKeyedDebouncer({
      wait: 10,
      merge: (prev, next) => ({ domains: [...new Set([...(prev.domains || []), ...(next.domains || [])])] }),
      onFlush: async (key, payload) => flushed.push([key, payload.domains])
    });
    debouncer.schedule('app:1', { domains: ['org'] });
    debouncer.schedule('app:1', { domains: ['role'] });
    debouncer.schedule('app:1', { domains: ['org'] });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(flushed.length, 1);
    assert.deepEqual(flushed[0][1].sort(), ['org', 'role']);
  });
});
