# fastify-integration

### 描述

KNE 子应用集成协议插件：租户级联邦，同时具备上游(host)与下游(guest)两侧能力

### 关键词

fastify, fastify-plugin, kne, multi-tenant, tenant, federation, integration, openapi, signature, permission, proxy, bff

### 安装

```shell
npm i --save @kne/fastify-integration
```

### 概述

#### 项目概述

`@kne/fastify-integration` 是基于 Fastify 的租户级联邦协议插件。它让两个（或多个）都安装了 `@kne/fastify-tenant` 的系统互联：上游的租户与租户用户可以直接使用下游功能；下游的权限树作为上游权限体系中的一个顶层模块挂入；下游仍可作为独立系统运行。

注册本插件即**同时具备上游（host）与下游（guest）两侧能力**，没有模式开关。同一部署可以既被上游托管、又托管自己的下游，从而支持 `A → B → C` 的链式联邦。

#### 核心架构与流程

##### 三阶段生命周期

```
配置（部署级，一次性）
  下游签发超管密钥
       ↓
  上游登记下游并调用 /open-api/app/install
       ↓
  下游写入 t_integration_host，收下回调凭据

开通（每租户一次）
  上游创建租户 → tenantCreated 钩子
       ↓
  POST /open-api/tenant/link → 下游建影子租户
       ↓
  下游回拉 GET /open-api/federation/snapshot → 投影角色/组织/用户/ceiling

使用（日常）
  浏览器 → 上游 /proxy/:appCode/*
       ↓
  上游换票 POST /open-api/session，注入 x-third-login-token
       ↓
  下游本地鉴权、本地算权限、本地读组织树
```

| 阶段 | 谁发起 | 做什么 |
|------|--------|--------|
| 配置 | 上游超管 | 用下游签发的密钥调 `install`，登记彼此并下发一对回调凭据 |
| 开通 | 上游（新建租户时自动） | 调 `tenant/link`，下游建影子租户，随后回拉全量快照做投影 |
| 使用 | 租户用户 | 请求经上游代理转发，上游换票并注入 `x-third-login-token` |

##### 两侧能力对称

```
本部署
├── 下游侧（别人调我）
│   ├── install / manifest / tenant-link / unlink
│   ├── snapshot-apply / snapshot-invalidate
│   └── session（换票）
└── 上游侧（我调别人）
    ├── 下游注册表 + 租户开通关系
    ├── 快照导出 / 权限树 provider / 生命周期联动
    └── 代理转发 + 管理端 / 租户端接口
```

#### 核心概念详解

##### 上游与下游

| 角色 | 含义 | 同一部署可否兼具 |
|------|------|------------------|
| 上游（host） | 持有身份数据权威，向下游投影并代理转发 | 是 |
| 下游（guest） | 接收投影，提供权限树与业务能力 | 是 |

术语不用「父/子应用」，因为同一部署两个身份可同时成立。

##### 身份数据投影

下游业务表会用本地主键做外键（组织、角色、租户用户），因此不能只靠实时拉取。权威在上游，下游落**只读影子行**：

| 数据域 | 权威 | 下游本地形态 |
|--------|------|--------------|
| tenant | 上游 | 影子行，`source` + `sourceId` |
| tenantUser | 上游 | 影子行，`synced` + `syncSource=federation:{hostAppCode}` + `sourceId` |
| org | 上游 | 影子行，复用 `syncSource` / `sourceId` |
| role | 上游 | system 按 code 映射；custom 按 sourceId 建影子行 |
| 权限树结构 | **下游** | 本地 `permissions`；上游实时拉取合并 |
| 权限上限 ceiling | 上游 | 写入下游 `setting.permissions` |
| 有效权限 | 派生 | 下游本地 `combinedPermissions` 计算 |

> **关键设计**：推送只推失效信号，数据一律走全量快照拉取。投影天然幂等、无顺序问题；漏推最多延迟一个去抖周期。

##### 权限码前缀

每跳只加/剥一层 `{appCode}:`。下游始终只说自己的语言；上游把下游整棵树挂在 `appCode` 顶层模块下。多级联邦时前缀自然组合，例如 `coach:assessment:tenant:project:view`。

快照导出时按 `appCode` 过滤并剥一层前缀——下游看不到上游自身或其它下游的码。

##### 成环与深度

权限树拉取与租户开通都会级联。协议用请求头 `x-federation-path`（逗号分隔的已走过 `appCode`）做环路检测，并用 `maxDepth`（默认 5）限制层级。

> **关键设计**：快照导出严格纯本地只读，不得触发出站调用。导出方向与权限树拉取方向相反，再出站会形成死锁环。

#### 主要特性

| 特性 | 说明 |
|------|------|
| 双角色对称 | 注册即同时具备上下游能力，无 mode 开关 |
| 链式联邦 | 中间层既是下游又是上游，前缀与快照逐级组合 |
| 身份投影 | 租户 / 用户 / 组织 / 角色 / ceiling 影子行，业务读路径零改动 |
| 权限树合并 | 请求时按租户已开通下游实时拉取，以 `appCode` 为顶层模块 |
| 失效信号 | 上游数据变更去抖推送，下游回拉全量快照对账 |
| 代理转发 | 同源免跨域、下游凭据不落前端、服务端注入第三方登录票据 |
| 能力降级 | tenant 联邦接口缺失时插件仍可装载，相关接口返回 501 |

#### 使用方法

##### 安装

```shell
npm i --save @kne/fastify-integration
```

需要宿主已注册 `@kne/fastify-tenant` 与 `@kne/fastify-signature`。peer 要求 `@kne/fastify-tenant` 达到支持联邦协议的版本（见 `package.json` peerDependencies）。

##### 注册示例

```javascript
// 下游侧示例（如 coach）：声明 appCode 与前端产物
fastify.register(require('@kne/fastify-integration'), {
  appCode: 'coach',
  appName: '教练系统',
  selfApiUrl: 'https://coach.example.com/api/integration',
  apiBase: 'https://coach.example.com/api',
  web: {
    cdnUrl: process.env.COACH_CDN_URL,
    version: require('./package.json').version,
    preset: 'ComponentPreset'
  },
  mounts: [{ type: 'route', path: 'coach', module: 'Tenant', permission: 'tenant:project:view' }]
});
```

```javascript
// 上游侧示例（如 talent-saas）：形状相同，可不传 web
fastify.register(require('@kne/fastify-integration'), {
  appCode: 'talent-saas',
  appName: '人才 SaaS',
  selfApiUrl: 'https://saas.example.com/api/integration',
  apiBase: 'https://saas.example.com/api'
});
```

> **注意**：`appCode` 必填，一经启用不可更改——它是本应用在上游权限树里的顶层模块 code，改了会让上游已保存的权限码全部失配。

##### 对 @kne/fastify-tenant 的能力要求

影子租户建立、快照投影、影子用户 upsert 都需要绕过外部租户只读保护，只有 tenant 包内部能安全地做这件事：

| 接口 | 用途 | 缺失时 |
|------|------|--------|
| `services.tenant.ensureExternal` | 幂等建立外部租户 | 下游侧接口返回 501 |
| `services.federation.applySnapshot` | 单事务投影角色/组织/用户/权限上限 | 下游侧接口返回 501 |
| `services.federation.ensureExternalUser` | 换票时懒建影子用户 | 下游侧接口返回 501 |
| `services.federation.setExternalTenantStatus` | 停用时关闭影子租户 | 下游侧接口返回 501 |
| `addPermissionProvider` | 注册请求时权限树合并 | 权限树合并不生效 |
| `addHook` | 订阅租户生命周期 | 租户联动不生效 |
| `resolvePermissions` | 供 manifest 返回含嵌套下游的权限树 | 多级联邦嵌套在此断开 |

另有两处触发点是链式联邦成立的前提：`ensureExternal` 新建租户时须触发 `tenantCreated`；`applySnapshot` 完成后须触发 `tenantDataChanged`。

能力缺失时插件仍能正常装载，只在启动日志给出需要的版本，相关接口返回 501，不会让宿主起不来。

##### 典型联调步骤

1. 在下游用超管账号签发一对 `appId` / `secretKey`
2. 在上游管理端登记下游（`appCode`、`apiUrl`、凭据）并调用安装
3. 在上游创建或手动开通租户，确认下游出现影子租户与投影数据
4. 浏览器访问上游 `/api/integration/proxy/{appCode}/**`，确认免登进入下游能力


### 示例

### API

#### 配置项

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

#### HTTP 接口

默认前缀为 `/api/integration`。下列路径均相对该前缀。

##### 下游侧 open-api（上游驱动）

全部经 `@kne/fastify-signature` 的 `authenticate.openApi` 验签，并走 `verifyOpenApiIdentity`。`install` 之外的接口还会用入站 `x-openapi-appid` 反查 `t_integration_host`。

###### POST /open-api/app/install

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

###### GET /open-api/app/manifest

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

###### POST /open-api/tenant/link

开通租户：建立影子租户，并异步调度全量快照回拉。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| sourceTenantId | body | string | 是 | 上游租户 ID |
| tenant | body | object | 否 | 租户元数据（name / logo 等） |
| protocol | body | number | 否 | 协议版本 |

返回含 `remoteTenantId`（下游影子租户 ID）。

###### POST /open-api/tenant/unlink

停用租户：关闭影子租户状态，保留业务数据。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| sourceTenantId | body | string | 是 | 上游租户 ID |

###### POST /open-api/snapshot/apply

上游主动推送全量快照并立即投影。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| snapshot | body | object | 是 | 与 federation/snapshot 同形状的快照 |

###### POST /open-api/snapshot/invalidate

上游推送失效信号；下游去抖后回拉全量快照。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| sourceTenantId | body | string | 是 | 上游租户 ID |
| domains | body | array | 否 | 脏域提示，如 `['org','role']` |

返回 `{ accepted: true, debounce }`。

###### POST /open-api/session

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

##### 上游侧回拉 open-api（下游主动调）

下游用 install 时拿到的回调凭据签名。验签后由 `callbackAppId` 反查下游 `appCode`，并校验租户已开通。

###### GET /open-api/federation/snapshot

导出租户全量快照。**严格纯本地只读**，按下游 `appCode` 过滤权限码并剥一层前缀。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| sourceTenantId | query | string | 是 | 上游本地租户 ID |

返回形状见「协议载荷 → 快照」。

##### 管理端接口

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

##### 租户端接口

认证：用户 + 租户用户。

###### GET /tenant/app/list

当前租户已开通的下游应用及其前端挂载声明。manifest 拉失败时降级为只返回注册信息，`available: false`。

###### POST /tenant/app/session

为当前租户用户换取下游登录票据（不含下游 secretKey）。

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| appCode | body | string | 是 | 下游编码 |
| force | body | boolean | 否 | 强制刷新缓存票据，默认 `false` |

返回含 `token`、`tokenHeader`、`proxyBase`、`expiresAt`。

##### 代理转发

###### ALL /proxy/:appCode/*

阶段三正式使用入口。认证后校验开通关系，换票并注入下游第三方登录头，剔除上游自身登录凭据后转发。

| 行为 | 说明 |
|------|------|
| 注入 | `session.tokenHeader`（通常 `x-third-login-token`）、`x-integration-host-app-code` |
| 剔除 | `cookie`、`authorization`、`clientTokenHeader`、`host` |
| 重定向改写 | 将下游 `Location` 改写回代理路径，避免浏览器跳出到下游裸域 |

一期基于 `@fastify/reply-from`，支持 JSON 与常见流式响应；WebSocket / 超大 multipart 另议。

多级串联时路径可嵌套，例如 `/proxy/coach/integration/proxy/assessment/...`，每一跳都用本地 `authenticate.user`（含 third-login 分支）。

#### 程序化 API

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

##### services.registry

| 方法签名 | 说明 |
|----------|------|
| `saveApp({ appCode, name, apiUrl, appId, secretKey, status })` | 注册或更新下游 |
| `getApp({ appCode, requireEnabled })` | 按编码取下游 |
| `listApps({ currentPage, perPage, filter })` | 分页列表（脱敏视图） |
| `install({ appCode, authenticatePayload })` | 向下游 install 并签发回调凭据 |
| `getManifest({ appCode, sourceTenantId, federationPath, force })` | 拉取并缓存 manifest |
| `listEnabledLinksByTenant({ tenantId })` | 租户已开通且下游仍启用的关联 |
| `listEnabledApps()` | 全部已启用下游 |

##### services.lifecycle

| 方法签名 | 说明 |
|----------|------|
| `linkTenant({ tenantId, appCode })` | 向指定下游开通租户 |
| `unlinkTenant({ tenantId, appCode })` | 停用开通（下游通知失败仅记本地） |
| `resyncTenant({ tenantId, appCode })` | 推失效信号触发下游重投影 |
| `listLinks({ tenantId })` | 开通关系列表 |
| `onTenantCreated / onTenantDataChanged / onTenantStatusChanged` | 钩子实现，由插件在 `onReady` 注册 |

##### services.federation

| 方法签名 | 说明 |
|----------|------|
| `exportSnapshot({ appCode, sourceTenantId })` | 纯本地导出全量快照 |
| `exportTenantMeta({ sourceTenantId })` | 导出租户元数据（开通时用） |
| `exportTenantUserAssertion({ appCode, tenantUserInfo })` | 组装换票身份断言 |

##### services.guest

| 方法签名 | 说明 |
|----------|------|
| `install({ payload, inboundAppId })` | 登记上游 |
| `linkTenant / unlinkTenant` | 建/关影子租户 |
| `applySnapshot / pullSnapshot / invalidate` | 投影与失效处理 |
| `createSession({ hostAppCode, assertion })` | 懒 upsert 用户并签票 |
| `listSnapshotStatus()` | 进程内最近投影状态（诊断用） |

##### utils.code

| 方法签名 | 说明 |
|----------|------|
| `toHostCode(appCode, code)` | 加一层 `{appCode}:` 前缀 |
| `toGuestCode(appCode, code)` | 剥一层前缀；不属于该 app 返回 `null` |
| `toHostCodes / toGuestCodes` | 批量加/剥并去重 |
| `buildTenantSource(hostAppCode)` | 影子租户 `source` 值 |
| `buildSyncSource(hostAppCode)` | 返回 `federation:{hostAppCode}` |

#### 数据模型

表前缀默认 `t_`，模型前缀默认 `integration`（由 namespace `name` 决定）。

##### app（下游注册表）

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

##### host（上游注册表）

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

##### tenant（租户开通关系）

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

#### 协议载荷

##### 快照

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

##### 换票断言

由上游 `exportTenantUserAssertion` 组装，字段语义与快照中 `users[]` 单项一致，并带上 `sourceTenantId` / `sourceTenantUserId` / `tenant`。

#### 机制说明

##### 权限树合并

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

##### 失效与投影

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

##### 成环检测

| 场景 | 携带路径方式 | 超限行为 |
|------|--------------|----------|
| manifest 拉取 | `x-federation-path` 请求头 | 自身已在路径中 → `FEDERATION_CYCLE`；深度超限 → `FEDERATION_TOO_DEEP` |
| 租户开通级联 | 入站头解析后写入 AsyncLocalStorage，出站再追加 | 同上；成环时连请求都不发 |
| 快照导出 | 不允许出站 | — |

##### 错误码

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

##### 安全边界

| 边界 | 做法 |
|------|------|
| 下游可见权限码 | 快照导出按 appCode 过滤并剥前缀 |
| 入站身份 | 签名 + 超管校验；install 后按 appId 反查上/下游 |
| 代理凭据 | 下游 secret 不落前端；上游 token 不透传给下游 |
| 外部租户写保护 | 由 `@kne/fastify-tenant` 的只读保护承担；本插件投影走 tenant 特权接口 |
