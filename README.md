# dsh-deepseek-balance

在 **DSH（DeepSeek Harness）** Web GUI 的输入框下方，实时显示当前 DeepSeek API Key 的账户余额。

一个 12px 的 dock 条目，与 activity / usage 同处一行；点击右侧刷新按钮立即重新查询。API Key 始终留在 Host 进程内，浏览器只会收到余额与状态。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-5c6ac4.svg)

```
余额 ¥123.45 ↻
```

## 特性

- **开箱即用**：读取 DSH 凭据服务里已配置的 `DEEPSEEK_API_KEY`（Models 页面写入的就是它），无需在插件里再填一次 Key。
- **不泄露密钥**：只通过 Host 进程调用 `GET https://api.deepseek.com/user/balance`，浏览器请求的是同源只读路由 `/deepseek-balance`，响应里仅有余额与状态。
- **低打扰**：成功结果缓存 60 秒，失败结果缓存 5 秒；并发请求合并为一次上游调用。
- **手动刷新**：刷新按钮带 `?refresh=1` 绕过缓存。
- **状态可见**：未配置 Key、Key 无效、网络超时、余额不足都有对应文案与颜色，不会静默失败。
- **中英双语**：跟随 DSH 的界面语言。
- **零构建**：纯 ESM，`client.js` 直接用 `window.__ModuleLoader__` 注册，无打包、无依赖。

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

4. 重启 DSH。输入框下方出现 `余额 …` 即安装成功；若显示「未配置 API Key」，到 **设置 → Models** 填入 DeepSeek API Key 即可。

> `package.json` 里的 `dsh.bundle.patch` 会指向 `cordis.patch.yml`，由它在 profile 中插入插件行（id 为 `deepseek-balance`）。也就是说，只要把它加进 `bundles`，就不用手写 patch。

## 配置

全部可调项都有默认值，不配置也能用。需要时在 profile 的 `cordis.patch.yml` 里追加：

```yaml
- id: deepseek-balance
  name: dsh-deepseek-balance
  config:
    apiKeyEnv: DEEPSEEK_API_KEY   # 凭据引用名
    baseURL: https://api.deepseek.com
    cacheTtlMs: 60000             # 成功结果缓存（毫秒）
    timeoutMs: 10000              # 单次上游请求超时（毫秒）
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 交给 `ctx.credentials` 解析的引用名，不是 Key 本身 |
| `baseURL` | `https://api.deepseek.com` | 上游地址，可用于自建/代理网关 |
| `cacheTtlMs` | `60000` | 成功结果的缓存时间 |
| `timeoutMs` | `10000` | 上游请求超时 |

`cordis.patch.yml` 里已有一条同 id 的条目（只声明 name），上面的写法会覆盖它的 config，不会重复插入。

## 接口

Host 半部在 DSH 的本机回环 Web 服务上注册一个只读路由：

```
GET /deepseek-balance          # 命中缓存
GET /deepseek-balance?refresh=1  # 强制刷新
```

成功（`200`，`application/json`，`cache-control: no-store`）：

```json
{
  "status": "ok",
  "ref": "DEEPSEEK_API_KEY",
  "isAvailable": true,
  "balances": [
    { "currency": "CNY", "total": "123.45", "granted": "0.00", "toppedUp": "123.45" }
  ],
  "fetchedAt": 1790000000000
}
```

未配置 Key：`{ "status": "unconfigured", "ref": "DEEPSEEK_API_KEY" }`

失败：`{ "status": "error", "code": "...", "message": "...", "httpStatus": 401 }`，`code` 取值为
`CREDENTIALS | UNAUTHORIZED | NETWORK | TIMEOUT | HTTP | RESPONSE | INTERNAL`。

非 `GET` 请求返回 `405`。路由不设置 CORS 头，因此只能由 DSH 页面同源访问。

## 工作原理

| 文件 | 作用 |
| --- | --- |
| `index.js` | **Host 半部**：解析凭据 → 请求 `/user/balance` → 内存缓存 → 注册 `GET /deepseek-balance` |
| `client.js` | **浏览器半部**：在 `conversation.composer.dock` 槽位注册 React 组件，`fetch` 同源路由并渲染 |
| `cordis.patch.yml` | 向 profile 插入插件行的 bundle patch |
| `locale/*.json` | 插件在设置页/市场里的中英文名称与简介 |
| `icon.svg` | 插件图标 |

- Host 通过 `inject = ['credentials', 'webServer']` 取得凭据服务与 Web 载体，用 `ctx.effect()` 绑定路由生命周期。
- Client 通过 `inject = ['slots', 'locale']` 注册槽位条目与两份 locale 词典。
- 浏览器只与之通信的同源路由不带 CORS，凭据值从不进入响应、也不会写入日志。

## 安全说明

- API Key 只在 Host 进程内被解析与使用，不会下发到浏览器。
- 渲染的普通文本均经过转义；错误信息截断到 512 字符。
- 上游请求设置 `redirect: 'error'` 与超时，避免被重定向到非预期主机。
- 路由挂在本机回环地址上；若你把 DSH 暴露到公网，请自行在其前面加认证。

## 开发

- 无构建步骤：改完 `index.js` / `client.js` 后在 DSH 里重载插件（或重启 DSH）即可生效。
- `package.json` 的 `name`、`cordis.patch.yml` 的 `name`、`client.js` 里 `__ModuleLoader__.load({ id })` 三者必须一致。
- 调试接口可直接访问 `http://127.0.0.1:<DSH 端口>/deepseek-balance`。

## 许可

[MIT](LICENSE)。本项目与 DeepSeek 官方无关，仅为个人使用的第三方 DSH 插件。

---

## English

A DSH (DeepSeek Harness) plugin that shows the DeepSeek API key account balance in the composer dock of the Web GUI.

- **Host half** (`index.js`): resolves the configured credential through `ctx.credentials`, calls `GET https://api.deepseek.com/user/balance`, caches the result in-process, and serves a read-only same-origin route `GET /deepseek-balance`.
- **Client half** (`client.js`): registers a 12px entry in `conversation.composer.dock`, fetches `/deepseek-balance`, and renders the balance with a refresh button (`?refresh=1` bypasses the cache).
- The API key never leaves the Host process; the response carries balances and status only.

### Install

1. Clone this repository.
2. In your DSH profile directory (`$env:DSH_PROFILE_DIR`, usually `~/.dsh/profiles/<name>`), add `"dsh-deepseek-balance": "link:/path/to/dsh-deepseek-balance"` to `dependencies` and `"dsh-deepseek-balance"` to `dsh.profile.bundles` in `package.json`.
3. Run `pnpm install` in that directory.
4. Restart DSH and configure your DeepSeek API key in **Settings → Models**.

Options (`apiKeyEnv`, `baseURL`, `cacheTtlMs`, `timeoutMs`) can be overridden in the profile's `cordis.patch.yml` under the `deepseek-balance` row; every option has a working default.

### License

[MIT](LICENSE). Not affiliated with DeepSeek.
