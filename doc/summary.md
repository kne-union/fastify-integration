### 项目概述

`@kne/fastify-integration` 是基于 Fastify 的租户级联邦协议插件。它让两个（或多个）都安装了 `@kne/fastify-tenant` 的系统互联：上游的租户与租户用户可以直接使用下游功能；下游的权限树作为上游权限体系中的一个顶层模块挂入；下游仍可作为独立系统运行。

注册本插件即**同时具备上游（host）与下游（guest）两侧能力**，没有模式开关。同一部署可以既被上游托管、又托管自己的下游，从而支持 `A → B → C` 的链式联邦。

### 核心架构与流程

#### 三阶段生命周期

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

#### 两侧能力对称

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

### 核心概念详解

#### 上游与下游

| 角色 | 含义 | 同一部署可否兼具 |
|------|------|------------------|
| 上游（host） | 持有身份数据权威，向下游投影并代理转发 | 是 |
| 下游（guest） | 接收投影，提供权限树与业务能力 | 是 |

术语不用「父/子应用」，因为同一部署两个身份可同时成立。

#### 身份数据投影

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

#### 权限码前缀

每跳只加/剥一层 `{appCode}:`。下游始终只说自己的语言；上游把下游整棵树挂在 `appCode` 顶层模块下。多级联邦时前缀自然组合，例如 `coach:assessment:tenant:project:view`。

快照导出时按 `appCode` 过滤并剥一层前缀——下游看不到上游自身或其它下游的码。

#### 成环与深度

权限树拉取与租户开通都会级联。协议用请求头 `x-federation-path`（逗号分隔的已走过 `appCode`）做环路检测，并用 `maxDepth`（默认 5）限制层级。

> **关键设计**：快照导出严格纯本地只读，不得触发出站调用。导出方向与权限树拉取方向相反，再出站会形成死锁环。

### 主要特性

| 特性 | 说明 |
|------|------|
| 双角色对称 | 注册即同时具备上下游能力，无 mode 开关 |
| 链式联邦 | 中间层既是下游又是上游，前缀与快照逐级组合 |
| 身份投影 | 租户 / 用户 / 组织 / 角色 / ceiling 影子行，业务读路径零改动 |
| 权限树合并 | 请求时按租户已开通下游实时拉取，以 `appCode` 为顶层模块 |
| 失效信号 | 上游数据变更去抖推送，下游回拉全量快照对账 |
| 代理转发 | 同源免跨域、下游凭据不落前端、服务端注入第三方登录票据 |
| 能力降级 | tenant 联邦接口缺失时插件仍可装载，相关接口返回 501 |

### 使用方法

#### 安装

```shell
npm i --save @kne/fastify-integration
```

需要宿主已注册 `@kne/fastify-tenant` 与 `@kne/fastify-signature`。peer 要求 `@kne/fastify-tenant` 达到支持联邦协议的版本（见 `package.json` peerDependencies）。

#### 注册示例

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

#### 对 @kne/fastify-tenant 的能力要求

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

#### 典型联调步骤

1. 在下游用超管账号签发一对 `appId` / `secretKey`
2. 在上游管理端登记下游（`appCode`、`apiUrl`、凭据）并调用安装
3. 在上游创建或手动开通租户，确认下游出现影子租户与投影数据
4. 浏览器访问上游 `/api/integration/proxy/{appCode}/**`，确认免登进入下游能力
