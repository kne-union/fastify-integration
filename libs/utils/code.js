const SEPARATOR = ':';

// 上游侧的权限码 = appCode + 一层分隔符 + 下游侧的权限码。
// 加/剥前缀都只处理一层，多级联邦时每一跳各做一次，前缀自然逐级组合。

const toHostCode = (appCode, code) => `${appCode}${SEPARATOR}${code}`;

const toGuestCode = (appCode, code) => {
  const prefix = `${appCode}${SEPARATOR}`;
  if (typeof code !== 'string' || !code.startsWith(prefix)) {
    return null;
  }
  const stripped = code.slice(prefix.length);
  return stripped.length > 0 ? stripped : null;
};

const toHostCodes = (appCode, codes) => [...new Set((codes || []).filter(code => typeof code === 'string' && code.length > 0))].map(code => toHostCode(appCode, code));

// 把上游的权限码集合裁剪成只属于 appCode 的部分，并剥掉这一层前缀。
// 这既是功能要求（下游只认自己的码），也是安全边界（下游不得看到其它下游或上游自身的码）。
const toGuestCodes = (appCode, codes) => {
  const result = new Set();
  (codes || []).forEach(code => {
    const stripped = toGuestCode(appCode, code);
    if (stripped) {
      result.add(stripped);
    }
  });
  return [...result];
};

const buildTenantSource = hostAppCode => hostAppCode;

const buildSyncSource = hostAppCode => `federation:${hostAppCode}`;

module.exports = {
  SEPARATOR,
  toHostCode,
  toGuestCode,
  toHostCodes,
  toGuestCodes,
  buildTenantSource,
  buildSyncSource
};
