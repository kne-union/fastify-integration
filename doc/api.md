### 配置项

插件注册时通过 `options` 传入。未列出的项保持代码默认值。

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| appCode | string | 是 | — | 本应用编码；同时是上游权限树中的顶层模块 code，启用后不可改 |
| appName | string | 否 | 等于 `appCode` | 本应用展示名称 |
| appDescription | string | 否 | `''` | 应用描述，写入 manifest |
| selfApiUrl | string | 否* | `''` | 本应用 integration 接口基地址；install 时下发给下游用于回拉 |
| apiBase | string | 否* | `''` | 本应用业务接口基地址；写入 manifest 与换票响应，供代理定位 |
| web | object / null | 否 | `null` | 前端产物声明（如 `cdnUrl` / `version` / `preset`） |
| mounts | array | 否 | `[]` | 前端挂载点声明，写入 manifest |
| name | string | 否 | `integration` | 命名空间名，对应 `fastify.integration` |
| prefix | string | 否 | `/api/integration` | HTTP 路由前缀 |
| dbTableNamePrefix | string | 否 | `t_` | 数据表前缀 |
| protocol | number | 否 | `1` | 协议版本；双方不一致时 install / 快照返回 409 |
| maxDepth | number | 否 | `5` | 联邦最大层级；超过抛 `FEDERATION_TOO_DEEP` |
| federationPathHeader | string | 否 | `x-federation-path` | 成环检测请求头名 |
| manifestCacheTTL | number | 否 | `60000` | manifest 内存缓存新鲜期（毫秒） |
| manifestStaleTTL | number | 否 | `86400000` | 拉取失败时允许使用的过期缓存时长（毫秒） |
| invalidateDebounce | number | 否 | `2000` | 上游推失效信号的去抖窗口（毫秒） |
| snapshotDebounce | number | 否 | `2000` | 下游回拉全量快照的去抖窗口（毫秒） |
| snapshotUserWarnThreshold | number | 否 | `5000` | 快照用户数超过该值打 warn 日志 |
| sessionExpiresIn | number | 否 | `7200` | 换票 JWT 有效期（秒） |
| sessionRefreshBuffer | number | 否 | `300000` | 距过期不足该毫秒时提前刷新票据 |
| signatureExpire | number | 否 | `180` | 出站签名有效期（秒） |
| requestTimeout | number | 否 | `15000` | 出站 HTTP 超时（毫秒） |
| undici | object | 否 | `undefined` | 传给 `@fastify/reply-from` 的 undici 选项 |
| autoLinkOnTenantCreated | boolean | 否 | `true` | 是否在 `tenantCreated` 时自动向所有已启用下游开通 |
| tenantName | string | 否 | `tenant` | `@kne/fastify-tenant` 命名空间名 |
| signatureName | string | 否 | `signature` | `@kne/fastify-signature` 命名空间名 |
| tenantUserContextName | string | 否 | `tenantUserInfo` | 请求上的租户用户上下文字段名 |
| clientTokenHeader | string | 否 | `x-client-user-token` | 代理转发时剔除的上游客户端 token 头 |
| getUserAuthenticate | function | 否 | tenant.authenticate.user | 用户认证钩子 |
| getTenantUserAuthenticate | function | 否 | tenant.authenticate.tenantUser | 租户用户认证钩子 |
| getAdminUserAuthenticate | function | 否 | account.authenticate.admin | 管理端认证钩子 |
| getUserInfo | function | 否 | `request => request.userInfo` | 安装时签发回调凭据所用账号 |
| verifyOpenApiIdentity | function | 否 | 校验超管 | 入站 open-api 身份收敛；默认要求签名绑定超管 |

\* 作为上游安装下游、或作为下游被代理访问时，`selfApiUrl` / `apiBase` 实际上需要配置正确，否则回拉与转发会失败。

```javascript
fastify.register(require('@kne/fastify-integration'), {
  appCode: 'coach',
  appName: '教练系统',
  selfApiUrl: 'https://coach.example.com/api/integration',
  apiBase: 'https://coach.example.com/api',
  web: { cdnUrl: process.env.COACH_CDN_URL, version: '0.1.0', preset: 'ComponentPreset' },
  mounts: [{ type: 'route', path: 'coach', module: 'Tenant', permission: 'tenant:project:view' }]
});
```

### HTTP 接口

默认前缀为 `/api/integration`。下列路径均相对该前缀。

#### 下游侧 open-api（上游驱动）

全部经 `@kne/fastify-signature` 的 `authenticate.openApi` 验签，并走 `verifyOpenApiIdentity`。`install` 之外的接口还会用入站 `x-openapi-appid` 反查 `t_integration_host`。

##### POST /open-api/app/install

上游安装：登记上游并接收其回调凭据。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| protocol | body | number | 是 | 协议版本，须与本地一致 |
| hostAppCode | body | string | 是 | 上游应用编码 |
| name | body | string | 否 | 上游名称 |
| apiUrl | body | string | 是 | 上游 integration 基地址 |
| callback.appId | body | string | 是 | 下游回拉上游用的 appId |
| callback.secretKey | body | string | 是 | 下游回拉上游用的 secretKey |

返回示例：

```json
{
  "protocol": 1,
  "appCode": "coach",
  "name": "教练系统",
  "hostAppCode": "talent-saas"
}
```

##### GET /open-api/app/manifest

实时返回本应用权限树与前端挂载声明。带 `x-federation-path` 做成环检测。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| sourceTenantId | query | string | 否 | 上游本地租户 ID；有值时返回含嵌套下游的 `resolvePermissions` 结果 |

> **关键设计**：`permissionTree` 与 `mounts[].permission` 都不带 `{appCode}:` 前缀。加前缀是上游 provider 的职责。

返回示例：

```json
{
  "protocol": 1,
  "appCode": "coach",
  "name": "AI 教练",
  "description": "",
  "apiBase": "https://coach.example.com/api",
  "web": { "cdnUrl": "...", "version": "0.1.73", "preset": "ComponentPreset" },
  "mounts": [{ "type": "route", "path": "coach", "module": "Tenant", "permission": "tenant:project:view" }],
  "permissionTree": [{ "name": "管理端", "code": "tenant", "modules": [] }]
}
```

##### POST /open-api/tenant/link

开通租户：建立影子租户，并异步调度全量快照回拉。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| sourceTenantId | body | string | 是 | 上游租户 ID |
| tenant | body | object | 否 | 租户元数据（name / logo 等） |
| protocol | body | number | 否 | 协议版本 |

返回含 `remoteTenantId`（下游影子租户 ID）。

##### POST /open-api/tenant/unlink

停用租户：关闭影子租户状态，保留业务数据。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| sourceTenantId | body | string | 是 | 上游租户 ID |

##### POST /open-api/snapshot/apply

上游主动推送全量快照并立即投影。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| snapshot | body | object | 是 | 与 federation/snapshot 同形状的快照 |

##### POST /open-api/snapshot/invalidate

上游推送失效信号；下游去抖后回拉全量快照。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| sourceTenantId | body | string | 是 | 上游租户 ID |
| domains | body | array | 否 | 脏域提示，如 `['org','role']` |

返回 `{ accepted: true, debounce }`。

##### POST /open-api/session

换票：按身份断言懒建影子用户并签发第三方登录票据。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| sourceTenantId | body | string | 是 | 上游租户 ID |
| sourceTenantUserId | body | string | 是 | 上游租户用户 ID |
| tenant | body | object | 否 | 租户元数据（未开通时可顺带 ensure） |
| user | body | object | 否 | 用户资料与 roleSourceIds / tenantOrgSourceIds |

返回示例：

```json
{
  "protocol": 1,
  "appCode": "coach",
  "token": "<jwt>",
  "tokenHeader": "x-third-login-token",
  "apiBase": "https://coach.example.com/api",
  "remoteTenantId": "12",
  "remoteTenantUserId": "34",
  "expiresAt": 1710000000000
}
```

#### 上游侧回拉 open-api（下游主动调）

下游用 install 时拿到的回调凭据签名。验签后由 `callbackAppId` 反查下游 `appCode`，并校验租户已开通。

##### GET /open-api/federation/snapshot

导出租户全量快照。**严格纯本地只读**，按下游 `appCode` 过滤权限码并剥一层前缀。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| sourceTenantId | query | string | 是 | 上游本地租户 ID |

返回形状见「协议载荷 → 快照」。

#### 管理端接口

认证：`getUserAuthenticate` + `getAdminUserAuthenticate`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /admin/app/list | 下游应用分页列表 |
| POST | /admin/app/save | 注册或编辑下游（凭据留空表示不修改） |
| POST | /admin/app/set-status | 启用或停用下游 |
| POST | /admin/app/remove | 删除下游注册及其开通关系 |
| POST | /admin/app/install | 阶段一：向下游安装自己并下发回调凭据 |
| POST | /admin/app/refresh-manifest | 强制刷新下游 manifest 缓存 |
| GET | /admin/host/list | 上游应用列表（谁托管了我） |
| POST | /admin/host/set-status | 启用或停用上游 |
| GET | /admin/tenant/list | 租户开通关系列表 |
| POST | /admin/tenant/link | 手动为租户开通下游 |
| POST | /admin/tenant/unlink | 手动停用租户对下游的开通 |
| POST | /admin/tenant/resync | 手动重投影（推失效信号让下游回拉） |
| GET | /admin/diagnose | 自检：appCode、tenant 联邦能力、快照投影状态 |

`POST /admin/app/save` 请求体：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appCode | string | 是 | 下游编码；不能等于本机 `appCode` |
| apiUrl | string | 是 | 下游 integration 基地址 |
| name | string | 否 | 名称 |
| appId | string | 否 | 调用下游用的 appId |
| secretKey | string | 否 | 调用下游用的 secretKey；留空不改 |
| status | string | 否 | `enabled` / `disabled` |

列表接口返回中的 `secretKey` 一律脱敏为 `hasSecretKey` 布尔值。

#### 租户端接口

认证：用户 + 租户用户。

##### GET /tenant/app/list

当前租户已开通的下游应用及其前端挂载声明。manifest 拉失败时降级为只返回注册信息，`available: false`。

##### POST /tenant/app/session

为当前租户用户换取下游登录票据（不含下游 secretKey）。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| appCode | body | string | 是 | 下游编码 |
| force | body | boolean | 否 | 强制刷新缓存票据，默认 `false` |

返回含 `token`、`tokenHeader`、`proxyBase`、`expiresAt`。

#### 代理转发

##### ALL /proxy/:appCode/*

阶段三正式使用入口。认证后校验开通关系，换票并注入下游第三方登录头，剔除上游自身登录凭据后转发。

| 行为 | 说明 |
|------|------|
| 注入 | `session.tokenHeader`（通常 `x-third-login-token`）、`x-integration-host-app-code` |
| 剔除 | `cookie`、`authorization`、`clientTokenHeader`、`host` |
| 重定向改写 | 将下游 `Location` 改写回代理路径，避免浏览器跳出到下游裸域 |

一期基于 `@fastify/reply-from`，支持 JSON 与常见流式响应；WebSocket / 超大 multipart 另议。

多级串联时路径可嵌套，例如 `/proxy/coach/integration/proxy/assessment/...`，每一跳都用本地 `authenticate.user`（含 third-login 分支）。

### 程序化 API

命名空间默认挂在 `fastify.integration`（由 `options.name` 决定）。

| 子模块 | 说明 |
|--------|------|
| `services.registry` | 下游注册、安装、manifest 缓存 |
| `services.hostRegistry` | 上游登记与查询 |
| `services.lifecycle` | 租户开通联动、失效推送、重投影 |
| `services.federation` | 快照导出、换票断言导出 |
| `services.guest` | 下游侧 install / link / 投影 / 换票 |
| `services.manifest` | 生成本地 manifest |
| `services.provider` | 权限树 provider（注册进 tenant） |
| `services.session` | 换票与 token 缓存 |
| `services.client` | 签名出站 HTTP 客户端 |
| `utils.code` | 权限码加/剥前缀、source 构造 |
| `utils.federationPath` | 联邦路径解析与成环检测 |
| `utils.capability` | 探测 tenant 联邦能力是否齐全 |

#### services.registry

| 方法签名 | 说明 |
|----------|------|
| `saveApp({ appCode, name, apiUrl, appId, secretKey, status })` | 注册或更新下游 |
| `getApp({ appCode, requireEnabled })` | 按编码取下游 |
| `listApps({ currentPage, perPage, filter })` | 分页列表（脱敏视图） |
| `install({ appCode, authenticatePayload })` | 向下游 install 并签发回调凭据 |
| `getManifest({ appCode, sourceTenantId, federationPath, force })` | 拉取并缓存 manifest |
| `listEnabledLinksByTenant({ tenantId })` | 租户已开通且下游仍启用的关联 |
| `listEnabledApps()` | 全部已启用下游 |

#### services.lifecycle

| 方法签名 | 说明 |
|----------|------|
| `linkTenant({ tenantId, appCode })` | 向指定下游开通租户 |
| `unlinkTenant({ tenantId, appCode })` | 停用开通（下游通知失败仅记本地） |
| `resyncTenant({ tenantId, appCode })` | 推失效信号触发下游重投影 |
| `listLinks({ tenantId })` | 开通关系列表 |
| `onTenantCreated / onTenantDataChanged / onTenantStatusChanged` | 钩子实现，由插件在 `onReady` 注册 |

#### services.federation

| 方法签名 | 说明 |
|----------|------|
| `exportSnapshot({ appCode, sourceTenantId })` | 纯本地导出全量快照 |
| `exportTenantMeta({ sourceTenantId })` | 导出租户元数据（开通时用） |
| `exportTenantUserAssertion({ appCode, tenantUserInfo })` | 组装换票身份断言 |

#### services.guest

| 方法签名 | 说明 |
|----------|------|
| `install({ payload, inboundAppId })` | 登记上游 |
| `linkTenant / unlinkTenant` | 建/关影子租户 |
| `applySnapshot / pullSnapshot / invalidate` | 投影与失效处理 |
| `createSession({ hostAppCode, assertion })` | 懒 upsert 用户并签票 |
| `listSnapshotStatus()` | 进程内最近投影状态（诊断用） |

#### utils.code

| 方法签名 | 说明 |
|----------|------|
| `toHostCode(appCode, code)` | 加一层 `{appCode}:` 前缀 |
| `toGuestCode(appCode, code)` | 剥一层前缀；不属于该 app 返回 `null` |
| `toHostCodes / toGuestCodes` | 批量加/剥并去重 |
| `buildTenantSource(hostAppCode)` | 影子租户 `source` 值 |
| `buildSyncSource(hostAppCode)` | 返回 `federation:{hostAppCode}` |

### 数据模型

表前缀默认 `t_`，模型前缀默认 `integration`（由 namespace `name` 决定）。

#### app（下游注册表）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| appCode | STRING | 下游编码；软删范围内唯一 |
| name | STRING | 名称 |
| apiUrl | STRING | 下游 integration 基地址 |
| appId | STRING | 我调下游用的 appId |
| secretKey | STRING | 我调下游用的 secretKey |
| callbackAppId | STRING | 我签发给下游、供其回拉时用的 appId |
| status | ENUM | `enabled` / `disabled` |
| installedAt | DATE | 最近一次 install 成功时间 |
| manifestCache | JSONB | manifest 降级缓存，非权威 |
| manifestCachedAt | DATE | 缓存时间 |
| options | JSONB | 扩展字段 |

唯一索引：`(app_code) WHERE deleted_at IS NULL`。另有 `callback_app_id` 普通索引。

#### host（上游注册表）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| hostAppCode | STRING | 上游编码；软删范围内唯一；影子租户 `source` 取值来源 |
| name | STRING | 名称 |
| apiUrl | STRING | 上游 integration 基地址 |
| callbackAppId | STRING | 我回拉上游用的 appId |
| callbackSecretKey | STRING | 我回拉上游用的 secretKey |
| inboundAppId | STRING | 上游调我时用的 appId，用于反查上游 |
| status | ENUM | `enabled` / `disabled` |
| installedAt | DATE | 最近被 install 时间 |
| options | JSONB | 扩展字段 |

唯一索引：`(host_app_code) WHERE deleted_at IS NULL`。另有 `inbound_app_id` 普通索引。

#### tenant（租户开通关系）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| tenantId | FK | 本系统租户 ID（关联 `fastify.tenant.models.tenant`） |
| appCode | STRING | 下游编码 |
| remoteTenantId | STRING | 下游影子租户 ID |
| status | ENUM | `enabled` / `disabled` |
| linkedAt | DATE | 开通时间 |
| lastSnapshotAt | DATE | 最近投影成功时间 |
| lastSnapshotError | TEXT | 最近投影失败原因 |
| options | JSONB | 扩展字段 |

唯一索引：`(tenant_id, app_code) WHERE deleted_at IS NULL`。

> **关键设计**：开通关系的唯一权威是本表。租户权限上限（ceiling）只表达「开通了哪些模块」，不承担「开通了哪些下游」的职责。

### 协议载荷

#### 快照

由 `GET /open-api/federation/snapshot` 返回，亦可经 `POST /open-api/snapshot/apply` 推送。

```json
{
  "protocol": 1,
  "hostAppCode": "talent-saas",
  "appCode": "coach",
  "exportedAt": "2026-09-15T08:00:00.000Z",
  "tenant": {
    "sourceId": "1001",
    "name": "示例公司",
    "status": "open",
    "description": null,
    "logo": "https://cdn.example.com/logo.png",
    "themeColor": null
  },
  "ceiling": ["tenant:project:view", "tenant:project:edit"],
  "roles": [
    { "sourceId": "1", "code": "admin", "type": "system", "name": "租户管理员", "status": "open", "permissions": [] },
    { "sourceId": "77", "code": null, "type": "custom", "name": "项目经理", "status": "open", "permissions": ["tenant:project:view"] }
  ],
  "orgs": [
    { "sourceId": "5", "parentSourceId": null, "name": "总部", "leaderSourceId": "88", "status": "open", "index": 0 }
  ],
  "users": [
    {
      "sourceId": "88",
      "name": "张三",
      "email": "a@example.com",
      "status": "open",
      "roleSourceIds": ["77"],
      "tenantOrgSourceIds": ["5"]
    }
  ]
}
```

| 字段约定 | 说明 |
|----------|------|
| ceiling / role.permissions | 已按 `appCode` 过滤并剥一层前缀 |
| roles[].type=system | 下游按 `code` 映射到本地已有 admin/default，不新建影子行 |
| orgs/users 关系 | 一律用 sourceId 表达；下游投影时映射成本地主键 |
| logo | 仅透传绝对 URL；相对路径跨系统无法解析，导出为 `null` |

#### 换票断言

由上游 `exportTenantUserAssertion` 组装，字段语义与快照中 `users[]` 单项一致，并带上 `sourceTenantId` / `sourceTenantUserId` / `tenant`。

### 机制说明

#### 权限树合并

```
上游 permission.list(tenantId)
       ↓
resolvePermissions = 本地 permissions ∪ providers
       ↓
integration.provider.resolveModules
       ↓
按租户查已开通下游 → 并发拉 manifest → 包成顶层模块 { code: appCode, modules: permissionTree }
```

单个下游拉取失败只跳过该下游，不拖垮整个角色管理界面。结果按 `tenantId` + appCode 做 TTL 缓存，过期后仍可在 `staleTTL` 内用过期缓存降级。

#### 失效与投影

```
上游 org/role/user/ceiling 写入
       ↓
tenantDataChanged({ tenantId, domains })
       ↓
去抖合并 → POST 下游 /snapshot/invalidate
       ↓
下游去抖 → GET 上游 /federation/snapshot → applySnapshot
```

换票路径会对当前用户做懒 upsert，兜住「新人刚建好、对账还没跑」的窗口。

#### 成环检测

| 场景 | 携带路径方式 | 超限行为 |
|------|--------------|----------|
| manifest 拉取 | `x-federation-path` 请求头 | 自身已在路径中 → `FEDERATION_CYCLE`；深度超限 → `FEDERATION_TOO_DEEP` |
| 租户开通级联 | 入站头解析后写入 AsyncLocalStorage，出站再追加 | 同上；成环时连请求都不发 |
| 快照导出 | 不允许出站 | — |

#### 错误码

错误体为 `IntegrationError`，HTTP status 与 `code`（业务码字符串）同时返回。

| codeMessage | 典型 status | 说明 |
|-------------|-------------|------|
| INTEGRATION_PROTOCOL_MISMATCH | 409 | 协议版本不一致 |
| INTEGRATION_SELF_REFERENCE | 400 | 把自身注册为上/下游 |
| INTEGRATION_APP_NOT_FOUND / HOST_NOT_FOUND | 404 | 注册表无记录 |
| INTEGRATION_APP_DISABLED / HOST_DISABLED | 403 | 已停用 |
| INTEGRATION_TENANT_NOT_LINKED | 403/404 | 租户未开通 |
| INTEGRATION_OPEN_API_FORBIDDEN | 403 | 入站签名非超管 |
| FEDERATION_CYCLE / FEDERATION_TOO_DEEP | 508 | 联邦环路或过深 |
| TENANT_CAPABILITY_MISSING | 501 | tenant 缺联邦接口 |
| SIGNATURE_PLUGIN_MISSING | 501 | 未装 signature |
| INTEGRATION_REQUEST_FAILED / REJECTED | 502/对端 status | 出站调用失败 |

#### 安全边界

| 边界 | 做法 |
|------|------|
| 下游可见权限码 | 快照导出按 appCode 过滤并剥前缀 |
| 入站身份 | 签名 + 超管校验；install 后按 appId 反查上/下游 |
| 代理凭据 | 下游 secret 不落前端；上游 token 不透传给下游 |
| 外部租户写保护 | 由 `@kne/fastify-tenant` 的只读保护承担；本插件投影走 tenant 特权接口 |
