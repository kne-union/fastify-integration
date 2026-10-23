// 响应 schema 只用于 OpenAPI 文档：字段可空、对象允许额外字段，避免序列化改变实际输出
const str = description => ({ type: 'string', nullable: true, description });
const num = description => ({ type: 'number', nullable: true, description });
const bool = description => ({ type: 'boolean', nullable: true, description });
// ID（BIGINT）、日期、JSON 列以及下游原样透传的数据类型不确定，不声明类型，原样输出
const any = description => ({ description });
const obj = (description, properties) => ({ type: 'object', nullable: true, additionalProperties: true, description, properties });
const arr = (description, items) => ({ type: 'array', items, description });

const success = (description, schema) => ({ 200: Object.assign({}, schema || { type: 'object', additionalProperties: true }, { description }) });
const empty = description => success(description || '操作成功，返回空对象');

const STATUS = '状态：enabled 启用，disabled 停用';

const appView = obj('下游应用（secretKey 已脱敏，只返回是否配置）', {
  id: any('记录 ID'),
  appCode: str('下游应用编码，同时是它在本应用权限树里的顶层模块 code'),
  name: str('下游应用名称'),
  apiUrl: str('下游 integration 接口基地址'),
  appId: str('调用下游 open-api 的签名 appId'),
  hasSecretKey: bool('是否已配置调用下游的 secretKey'),
  callbackAppId: str('install 时签发给下游、供其回拉快照的回调凭据 appId；未安装为 null'),
  status: str(STATUS),
  installedAt: any('最近一次 install 成功时间'),
  manifestCachedAt: any('最近一次成功拉取 manifest 的时间'),
  manifestName: any('缓存 manifest 中的应用名称'),
  manifestVersion: any('缓存 manifest 中的前端版本（web.version）'),
  createdAt: any('创建时间'),
  updatedAt: any('更新时间')
});

const hostView = obj('上游应用（回调密钥已脱敏）', {
  id: any('记录 ID'),
  hostAppCode: str('上游应用编码'),
  name: str('上游应用名称'),
  apiUrl: str('上游 integration 接口基地址，用于回拉快照'),
  inboundAppId: str('上游调用本应用 open-api 时使用的签名 appId，用于反查上游'),
  hasCallbackCredential: bool('是否已保存上游下发的回调凭据'),
  status: str(STATUS),
  installedAt: any('最近一次被上游 install 的时间'),
  createdAt: any('创建时间'),
  updatedAt: any('更新时间')
});

const tenantLink = obj('租户开通关系', {
  id: any('记录 ID'),
  tenantId: any('本地租户 ID'),
  appCode: str('下游应用编码'),
  remoteTenantId: str('下游影子租户 ID'),
  status: str(STATUS),
  linkedAt: any('开通时间'),
  lastSnapshotAt: any('最近一次手动重投影时间'),
  lastSnapshotError: str('最近一次投影错误信息')
});

const manifest = obj('应用 manifest', {
  protocol: num('集成协议版本'),
  appCode: str('应用编码'),
  name: str('应用名称'),
  description: str('应用描述'),
  apiBase: str('业务接口基地址，供上游代理转发定位'),
  web: any('前端产物声明（cdnUrl / version / preset 等），未配置为 null'),
  mounts: any('前端挂载点声明数组，如 [{ code, name, permission, path, remote }]，权限码不带 appCode 前缀'),
  permissionTree: any('权限树模块数组，不带 appCode 前缀；带 sourceTenantId 时嵌入本应用自己下游的权限树')
});

const capabilitySide = description =>
  obj(description, {
    ready: bool('能力是否可用'),
    missing: arr('缺失的 @kne/fastify-tenant 接口路径', str('接口路径'))
  });

const snapshotUser = obj('租户用户', {
  sourceId: str('用户在上游的 ID'),
  name: str('姓名'),
  avatar: str('头像'),
  gender: str('性别'),
  email: str('邮箱'),
  phone: str('手机号'),
  description: str('描述'),
  status: str('用户状态'),
  roleSourceIds: arr('所属角色在上游的 ID', str('角色 ID')),
  tenantOrgSourceIds: arr('所属组织在上游的 ID', str('组织 ID'))
});

const snapshotTenant = obj('租户信息', {
  sourceId: str('租户在上游的 ID'),
  name: str('租户名称'),
  status: str('租户状态'),
  description: str('描述'),
  logo: str('Logo，只透传 http(s) 绝对地址，其他为 null'),
  themeColor: str('主题色')
});

module.exports = {
  str,
  num,
  bool,
  any,
  obj,
  arr,
  success,
  empty,
  STATUS,
  appView,
  hostView,
  tenantLink,
  manifest,
  capabilitySide,
  snapshotUser,
  snapshotTenant
};
