const { IntegrationError } = require('./errors');

// 联邦路径用于成环检测。权限树方向是受控递归的：
// 上游拉下游 manifest 时会触发下游自己的 permissionProvider，继续向它的下游拉。
// 若拓扑成环（A 托管 B、B 又托管 A）就会无限递归，因此每一跳都把自己的 appCode 追加进路径头。

const parse = value => {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
};

const serialize = list => (list || []).join(',');

const append = (list, appCode) => [...parse(list), appCode];

const assertAcyclic = ({ path, appCode, maxDepth }) => {
  const list = parse(path);
  if (list.includes(appCode)) {
    throw new IntegrationError('FEDERATION_CYCLE', `检测到联邦调用环路：${serialize([...list, appCode])}`, 508);
  }
  if (maxDepth > 0 && list.length >= maxDepth) {
    throw new IntegrationError('FEDERATION_TOO_DEEP', `联邦调用层级超过上限 ${maxDepth}：${serialize(list)}`, 508);
  }
  return list;
};

module.exports = { parse, serialize, append, assertAcyclic };
