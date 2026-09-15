const fp = require('fastify-plugin');
const generateSignature = require('@kne/fastify-signature/generateSignature');
const { IntegrationError } = require('../utils/errors');
const federationPath = require('../utils/federationPath');

module.exports = fp(async (fastify, options) => {
  // 签名算法必须与 @kne/fastify-signature 的 verify 完全一致，
  // 所以直接复用它导出的 generateSignature，不在本仓重复实现 HMAC。
  const buildSignatureHeaders = ({ appId, secretKey }) => {
    if (!appId || !secretKey) {
      throw new IntegrationError('INTEGRATION_CREDENTIAL_MISSING', '缺少调用凭据 appId / secretKey，请先完成安装配置', 412);
    }
    const { timestamp, expire, signature } = generateSignature(appId, secretKey, options.signatureExpire);
    return {
      'x-openapi-appid': String(appId),
      'x-openapi-timestamp': String(timestamp),
      'x-openapi-expire': String(expire),
      'x-openapi-signature': signature
    };
  };

  const buildUrl = (apiUrl, path, query) => {
    const url = new URL(`${String(apiUrl).replace(/\/+$/, '')}${path}`);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(item => url.searchParams.append(key, String(item)));
        return;
      }
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  };

  const request = async ({ apiUrl, appId, secretKey, method = 'GET', path = '', query, body, federationPath: pathList, timeout }) => {
    const url = buildUrl(apiUrl, path, query);
    const headers = Object.assign({ accept: 'application/json' }, buildSignatureHeaders({ appId, secretKey }));
    if (pathList && pathList.length > 0) {
      headers[options.federationPathHeader] = federationPath.serialize(pathList);
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout || options.requestTimeout)
      });
    } catch (e) {
      throw new IntegrationError('INTEGRATION_REQUEST_FAILED', `调用 ${url} 失败：${e.message}`, 502);
    }

    const text = await response.text();
    const payload = (() => {
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        return text;
      }
    })();

    if (!response.ok) {
      const message = (payload && (payload.message || payload.error)) || `HTTP ${response.status}`;
      throw new IntegrationError('INTEGRATION_REQUEST_REJECTED', `调用 ${url} 被拒绝：${message}`, response.status === 404 ? 502 : response.status);
    }

    return payload;
  };

  Object.assign(fastify[options.name].services, {
    client: { request, buildSignatureHeaders, buildUrl }
  });
});
