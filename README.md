# dsh-deepseek-balance

在 **DSH（DeepSeek Harness）** Web GUI 的输入框下方，实时显示**当前会话所用模型供应商**的账户余额或套餐额度。

DeepSeek 显示现金余额（¥）；GLM / z.ai 的 Coding Plan 显示套餐剩余额度百分比，标准 API Key 有现金账户时显示金额。切换模型后，这一行会自动跟着换供应商重新查询。

一个 12px 的 dock 条目，与 activity / usage 同处一行；点击右侧刷新按钮立即重新查询。API Key 始终留在 Host 进程内，浏览器只会收到余额与状态。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-5c6ac4.svg)

```
DeepSeek   余额 ¥123.45 ↻
GLM        GLM 额度 5 小时 92% · 本周 79% ↻
```

## 特性

- **跟随当前模型**：优先读取页面里模型控件声明的 `provider` / `model`，其次读 profile 的默认模型（`agentDefaultModel`），最后回退到 DeepSeek。
- **多供应商**：DeepSeek 与 GLM / z.ai 开箱可用，各自使用官方只读接口。
- **自动区分站点**：GLM 的同一个 Key 可能同时属于智谱中国站与 z.ai。插件会同时查询两站，优先采用**有金额**的中国站（¥），中国站为空或 Key 不可用时才用 z.ai（$）；也可以用 `region` 固定。
- **余额与额度不混淆**：现金账户显示金额（含赠送 / 充值 / 已消费 / 冻结），Coding Plan 显示各时间窗的剩余百分比。
- **不泄露密钥**：Key 只在 Host 进程内解析和使用，浏览器请求的是同源只读路由 `/deepseek-balance`。
- **低打扰**：成功结果缓存 60 秒，失败结果缓存 5 秒；并发请求合并为一次上游调用。
- **手动刷新**：刷新按钮带 `?refresh=1` 绕过缓存。
- **状态可见**：未配置 Key、Key 无效、网络超时、供应商不支持都有对应文案与颜色，不会静默失败。
- **中英双语**：跟随 DSH 的界面语言。
- **零构建**：纯 ESM，`client.js` 直接用 `window.__ModuleLoader__` 注册，无打包、无依赖。

## 支持的供应商

| 供应商路由 | 默认凭据引用 | 数据来源 | 显示 |
| --- | --- | --- | --- |
| `deepseek-official` / `deepseek` | `DEEPSEEK_API_KEY` | `GET https://api.deepseek.com/user/balance` | 现金余额（¥） |
| `zai` | `ZAI_API_KEY` | `open.bigmodel.cn` 与 `api.z.ai` 的 `/api/biz/account/query-customer-account-report`，失败时回退 `/api/monitor/usage/quota/limit`；另查 `/api/biz/tokenAccounts/list/my` | 现金余额（自动判定 ¥ / $）、额度百分比、赠送资源包 |
| `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` | 仅 `open.bigmodel.cn`：`/api/biz/account/query-customer-account-report`，失败时回退 `/api/monitor/usage/quota/limit`；另查 `/api/biz/tokenAccounts/list/my` | 现金余额（¥）、额度百分比、赠送资源包 |

其它路由（OpenAI、Anthropic、Kimi、MiniMax 等）会显示「当前模型不支持余额查询」，并且可以随时通过 `provider` 配置覆盖。

> GLM 的 Coding Plan 没有现金余额接口，只能查询额度，所以显示的是「5 小时 / 本周」的剩余百分比；标准 API Key 若账户有现金余额，则显示金额而不是百分比。
>
> 资源包（赠送的 token / 次数包）来自 `/api/biz/tokenAccounts/list/my`，只在悬浮提示里列出：每个包显示「剩余 / 总量」（`tokenBalance` / `tokensMagnitude`）、适用模型与有效期；余额行保持简洁，不再追加资源包。
>
> 站点判定规则：两站都有金额时优先智谱中国站（¥）；智谱中国站为 0 或不可用、而 z.ai 有金额时用 z.ai（$）。可用 `region: cn` / `region: intl` 跳过探测。

## 安装

插件以**本地链接包**（`link:`）方式装进 DSH 的 profile，不依赖 npm 发布。

1. 克隆仓库到任意目录：

   ```powershell
   git clone https://github.com/CowB0ySpike/dsh-deepseek-balance.git
   ```

2. 打开 DSH 的 profile 目录（环境变量 `DSH_PROFILE_DIR`，通常是 `~/.dsh/profiles/<name>`），编辑其中的 `package.json`：

   ```json
   {
     "dependencies": {
       "dsh-deepseek-balance": "link:D:/path/to/dsh-deepseek-balance"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-deepseek-balance"
         ]
       }
     }
   }
   ```

   把 `D:/path/to/dsh-deepseek-balance` 换成你实际的克隆路径（Windows 路径用正斜杠，或转义反斜杠）。

3. 在 profile 目录执行一次安装，让 `node_modules` 里的链接生效：

   ```powershell
   pnpm install
   ```

4. 重启 DSH。输入框下方出现 `余额 …` 即安装成功；在 **设置 → Models** 里配置好对应供应商的 API Key 即可。

> `package.json` 里的 `dsh.bundle.patch` 会指向 `cordis.patch.yml`，由它在 profile 中插入插件行（id 为 `deepseek-balance`）。也就是说，只要把它加进 `bundles`，就不用手写 patch。

## 配置

全部可调项都有默认值，不配置也能用。需要时在 profile 的 `cordis.patch.yml` 里追加：

```yaml
- id: deepseek-balance
  name: dsh-deepseek-balance
  config:
    provider: auto                # auto | deepseek-official | zai | zai-coding-cn
    region: auto                  # auto | cn | intl（GLM 站点，auto 会同时探测两站）
    # apiKeyEnv: ZAI_API_KEY      # 覆盖凭据引用名
    # baseURL: https://api.z.ai   # 覆盖当前供应商的上游地址
    cacheTtlMs: 60000             # 成功结果缓存（毫秒）
    timeoutMs: 10000              # 单次上游请求超时（毫秒）
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `provider` | 跟随当前模型 | 固定供应商路由；`auto` 或不写时按当前模型判断 |
| `region` | `auto` | GLM 站点；`auto` 先查智谱中国站、再查 z.ai，`cn` / `intl` 可跳过探测并固定币种 |
| `apiKeyEnv` | 按供应商决定 | 交给 `ctx.credentials` 解析的引用名，不是 Key 本身 |
| `baseURL` | 按供应商决定 | 只影响当前供应商，可用于自建/代理网关；同时决定币种（含 `bigmodel` 记为 ¥） |
| `cacheTtlMs` | `60000` | 成功结果的缓存时间 |
| `timeoutMs` | `10000` | 上游请求超时 |

`cordis.patch.yml` 里已有一条同 id 的条目（只声明 name），上面的写法会覆盖它的 config，不会重复插入。

## 接口

Host 半部在 DSH 的本机回环 Web 服务上注册一个只读路由：

```
GET /deepseek-balance                                  # 按当前模型自动判断
GET /deepseek-balance?provider=zai&model=glm-5.3       # 指定供应商（页面会这样传）
GET /deepseek-balance?refresh=1                        # 强制刷新
```

成功且为现金账户（`200`，`application/json`，`cache-control: no-store`）：

```json
{
  "status": "ok",
  "provider": "zai",
  "providerName": "GLM",
  "model": "glm-5.3",
  "station": "cn",
  "kind": "cash",
  "currency": "CNY",
  "isAvailable": true,
  "balances": [{ "currency": "CNY", "total": "50.00", "granted": "0.00", "toppedUp": "50.00" }],
  "extras": { "spent": "8.75", "frozen": "0.00" },
  "packages": [
    {
      "name": "【实名认证】500万GLM-5.3-Flash体验包",
      "remaining": 1386447,
      "grant": 5000000,
      "consumeType": "TOKENS",
      "model": "glm-5.3-flash",
      "expiresAt": 1798809599000
    }
  ],
  "fetchedAt": 1790000000000
}
```

成功且为套餐额度（Coding Plan，没有现金账户时）：

```json
{
  "status": "ok",
  "provider": "zai",
  "providerName": "GLM",
  "station": "cn",
  "kind": "quota",
  "currency": "CNY",
  "quota": [
    { "id": "5h", "remaining": 91.5, "resetsAt": 1792590000000 },
    { "id": "week", "remaining": 79, "resetsAt": 1793000000000 }
  ],
  "fetchedAt": 1790000000000
}
```

其它状态：

- `{ "status": "unsupported", "provider": "openai", "model": "gpt-5.6" }`
- `{ "status": "unconfigured", "provider": "zai", "providerName": "GLM", "ref": "ZAI_API_KEY" }`
- `{ "status": "error", "provider": "zai", "code": "...", "message": "...", "model": "glm-5.3" }`，`code` 取值为
  `CREDENTIALS | UNAUTHORIZED | NETWORK | TIMEOUT | HTTP | RESPONSE | INTERNAL`

非 `GET` 请求返回 `405`。路由不设置 CORS 头，因此只能由 DSH 页面同源访问。

## 工作原理

| 文件 | 作用 |
| --- | --- |
| `index.js` | **Host 半部**：判断当前供应商 → 解析凭据 → 调用对应余额/额度接口 → 缓存 → 注册 `GET /deepseek-balance` |
| `client.js` | **浏览器半部**：在 `conversation.composer.dock` 注册 React 组件，读取模型控件上的 `data-provider-id` / `data-model-id` 作为提示，`fetch` 同源路由并渲染 |
| `cordis.patch.yml` | 向 profile 插入插件行的 bundle patch |
| `locale/*.json` | 插件在设置页/市场里的中英文名称与简介 |
| `icon.svg` | 插件图标 |

- 供应商判定顺序：页面提示（模型控件）→ 配置项 `provider` → DSH 默认模型（`agentDefaultModel.currentSelection()`）→ `deepseek-official`。
- GLM 站点判定：`auto` 时并发查询智谱中国站与 z.ai，取有金额的一站；两站都有金额时优先中国站（¥）。`region` / `baseURL` 可固定站点与币种。
- Host 通过 `inject = ['credentials', 'webServer']` 取得凭据服务与 Web 载体，用 `ctx.effect()` 绑定路由生命周期。
- Client 通过 `inject = ['slots', 'locale']` 注册槽位条目与两份 locale 词典，并用 `MutationObserver` 监听模型切换。
- 浏览器只与之通信的同源路由不带 CORS，凭据值从不进入响应、也不会写入日志。

## 安全说明

- API Key 只在 Host 进程内被解析与使用，不会下发到浏览器。
- 页面传入的 `provider` 只能命中内置供应商表，不能用它指定任意上游地址；`baseURL` 只来自 profile 配置。
- `region: auto` 会把同一个 Key 分别发给智谱中国站（open.bigmodel.cn）与 z.ai 这两个同属智谱的官方域名；不希望这样时用 `region: cn` 或 `region: intl` 固定。
- 上游请求设置 `redirect: 'error'` 与超时，避免被重定向到非预期主机。
- 错误信息截断到 512 字符；渲染的普通文本均经过转义。
- 路由挂在本机回环地址上；若你把 DSH 暴露到公网，请自行在其前面加认证。

## 开发

- 无构建步骤：改完 `index.js` / `client.js` 后在 DSH 里重载插件（或重启 DSH）即可生效。
- 运行 Host 侧单元测试（Node 18+，使用内置 `node:test`）：

  ```powershell
  npm test
  # 等价于 node test/host.test.mjs
  ```

- `package.json` 的 `name`、`cordis.patch.yml` 的 `name`、`client.js` 里 `__ModuleLoader__.load({ id })` 三者必须一致。
- 调试接口可直接访问 `http://127.0.0.1:<DSH 端口>/deepseek-balance?provider=zai`。

## 许可

[MIT](LICENSE)。本项目与 DeepSeek、智谱 / z.ai 官方均无关，仅为个人使用的第三方 DSH 插件。

---

## English

A DSH (DeepSeek Harness) plugin that shows the account balance — or plan quota — of the model provider the current session uses, right in the composer dock.

- **Provider-aware**: follows the model control's `provider` / `data-model-id`, then the profile's default model, then falls back to DeepSeek.
- **DeepSeek**: cash balance via `GET https://api.deepseek.com/user/balance`.
- **GLM / z.ai**: cash report (`/api/biz/account/query-customer-account-report`), falling back to the coding-plan quota (`/api/monitor/usage/quota/limit`) for subscription keys.
- **Automatic station detection**: a `zai` key may belong to the 智谱 China site or to z.ai, so both are queried; a funded China account wins (CNY), otherwise the z.ai account is used (USD). `region: cn | intl` pins one.
- **Token packages**: granted 资源包 (`/api/biz/tokenAccounts/list/my`) are detailed in the tooltip as remaining/grant with model and expiry; the dock row stays compact.
- The API key never leaves the Host process; the browser only reads the same-origin `/deepseek-balance` route.

### Install

1. Clone this repository.
2. In your DSH profile directory (`$env:DSH_PROFILE_DIR`, usually `~/.dsh/profiles/<name>`), add `"dsh-deepseek-balance": "link:/path/to/dsh-deepseek-balance"` to `dependencies` and `"dsh-deepseek-balance"` to `dsh.profile.bundles` in `package.json`.
3. Run `pnpm install` in that directory.
4. Restart DSH and configure the provider's API key in **Settings → Models**.

Options (`provider`, `region`, `apiKeyEnv`, `baseURL`, `cacheTtlMs`, `timeoutMs`) can be overridden in the profile's `cordis.patch.yml` under the `deepseek-balance` row; every option has a working default.

### License

[MIT](LICENSE). Not affiliated with DeepSeek or Zhipu / z.ai.
