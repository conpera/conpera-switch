> 历史记录：以下描述 0.2 Beta。1.0 安装与当前开放范围见 [README](../README.md)。

# macOS 内测实现与验证 — 2026-10-15

状态：线上接口已于 2026-10-15 部署并启用；实际不可变 BFF 镜像隔离验证和公网验收通过。用户指定先完成 macOS 全流程，沿用系统现有 test 用户分组与 admin 权限。已批准的正方形瑞士风格登录页保持不变。

## 实现

客户端：`src/native.ts` 通过 WKScriptMessageHandlerWithReply 调用原生固定动作。主 WebView、主 frame、精确 origin、首页路径及载荷白名单共同约束调用。BETA 本地 HTTP 服务不开放模拟登录 API。完整账户令牌和模型 Key 都不经过 JavaScript，页面不持久化账户或密钥信息。

`AccountClient` 固定访问 `https://code.conpera.ai/api/switch/*`，拒绝网络重定向，使用无 Cookie/缓存的临时网络会话。系统浏览器登录采用 S256 PKCE 与随机 state；127.0.0.1 动态端口回调严格校验方法、Host、路径、字段与大小。错误 state 不消费有效事务；取消与迟到响应不能恢复已取消会话。专用桌面令牌只存入独立 Keychain service；无法安全保存就失败。401 清理无效凭据，网络/5xx 不误删；403 明确显示内测权限不足。退出分开报告本机凭据删除失败与远端撤销未确认。

`ConfigurationManager` 对 Codex/Claude 文件按工具事务处理：备份最初原文与权限、目录权限 0700、密钥文件 0600、flock、原子写入/fsync、恢复日志、外部变更哈希比较；拒绝 symlink/hardlink 路径。恢复还原原始 bytes、权限与原先不存在的状态。双工具操作是两个独立事务，部分失败显示实际状态，不假称整体成功。

Codex 配置采用 `[model_providers.conpera_switch]`，固定 `https://code.conpera.ai/v1`、Responses wire API、provider-scoped bearer token，`requires_openai_auth=false`；保留模型选择和 auth.json。Claude env 使用固定 `https://code.conpera.ai` 与 ANTHROPIC_AUTH_TOKEN，移除同文件中的 ANTHROPIC_API_KEY。配置包含客户端必需的密钥，文件及含原文的备份均限制本用户权限。

配置只覆盖用户级文件。支持进程环境里的绝对 CODEX_HOME/CLAUDE_CONFIG_DIR；Finder 不会读取 shell rc。Codex 保守编辑器对多行 TOML、数组表及歧义语法返回 422，文件最大 4 MiB；不支持的现有配置不会被覆盖。工程目录/托管/启动参数优先级仍可能覆盖本次写入。

余额保留 USD/CNY 真实币种和负数；未知/缺失币种拒绝，金额不做汇率换算。密钥/余额加载失败不会把已经读取的原生配置状态替换成“原机”；状态未知时禁止启用或通过密钥切换绕过。

服务端：[conpera/conpera-code](https://github.com/conpera/conpera-code/pull/124)，分支 `codex/conpera-switch-beta-20261008`，验证源码 `c4c949c`，基于 `origin/main@b8419f2`。每次校验现有 test ID 集合或 raw active admin；专用不透明桌面令牌限定 Switch 路由，不授予支付/管理接口。授权必须网页同意、同源 POST + CSRF，一次性码绑定 PKCE 与精确回调。桌面令牌最长七天且不超过父网站会话，BFF 加密保管父会话引用；不复制上游刷新凭据。完整密钥仅在原生配置请求中返回，校验本人归属、平台、渠道、有效期与额度，并再次复核会话。

## 验证证据

以下自动化回归使用合成身份、临时目录/数据库或内存凭据。另有本页后述的、用户明确授权的 test003 线上验收，两类证据分开记录。

- `npm run build`：TypeScript/Vite 构建通过。
- `node scripts/test-configuration.mjs`：59 项配置隔离检查通过，含恢复、权限、链接拒绝、并发锁和 crash journal。
- `node scripts/test-account.mjs`：81 项账号及原生组合检查通过，含登录→keys→两工具写入→读取→恢复→退出，PKCE、真实 loopback HTTP、取消/竞态、无秘密桥接、币种与退出错误区分。
- `node scripts/verify-beta-browser.mjs`：51 项通过。Chrome 独立 profile、随机静态端口，拒绝所有外网；逐项证据见 `output/beta-browser-report.json`。
- 保留 Demo 回归：`npm test` 10 项、`npm run test:native` 19 项、浏览器 40 项、启动竞态 2 项通过。
- `node scripts/build-mac.mjs --beta`：Swift 5 / arm64 / macOS 13 构建、Info.plist 及严格 ad-hoc 签名校验通过。真实 AppKit/WKWebView 启动展示 BETA 方形登录页，无会话时原生 bridge 返回未登录；本地 demo API 返回 404。最终包更新后的网页资源逐文件核对一致；再次启动因 Mac 锁屏未能执行，没有将此重启记为通过。产物哈希见 `output/beta-release-receipt.json`。
- BFF：133 模块构建、session 构建、typecheck；Switch + 既有中央 bridge 21 项、BFF 构建回归 26 项、CI selector 14 项通过。实际 Chrome 合成浏览器完成允许/取消表单到 loopback 的 303 回调与换码。

## 线上发布与剩余限制

2026-10-15 已将 Switch 所需三个后端模块合入当前生产镜像，启用 CONPERA_SWITCH_ENABLED=true。镜像 `sha256:828209f49d6c373d34638da9f3cbca7c23687b4a95bac0fe04ce61097674a6eb` 的 22 项隔离测试通过，覆盖实际 Express、SSO 登录往返、余额、本人密钥、两种配置及两种登出；回退兼容检查 1 项、生命周期与实际启动/优雅退出检查 17 项通过。13 项公网 HTTP 检查通过，运行中配置、SQLite 表和就绪状态已核对。切换约有 12 秒短暂中断，原数据保留。

2026-10-15 11:36–11:49 CST，用户指定并在浏览器登录的 test003（ID 98）完成真实 Beta 授权：软件发起 PKCE → 浏览器同意 → loopback 回调 → Keychain 保存 → 真实账户、余额与 7 个本人密钥读取。重启后仍能读取该会话。软件退出后，服务端该会话的 revoked_at 已设置；再次重启仍未登录，网页 test003 会话保留。

使用同一线上授权及原生 AccountClient/ConfigurationManager，在独立临时目录取得并应用真实配置。Codex CLI 0.160.1、Claude Code 2.1.296 实际读取这些配置：Claude Sonnet 5.5 返回 `CONPERA_SWITCH_OK`，341 输入 + 3 输出 tokens，网站显示本人新增 1 次请求、344 tokens；CLI 报告费用 USD 0.000712。Codex 的 GPT-plus 特惠渠道（key ID 1149）请求确实到达固定线上 Responses 入口，但 gpt-5.6 返回 503，补充的 gpt-5.4-mini 请求返回 502。上游针对后者记录 404 与无可用账号支持该模型；不能宣称 Codex 运行验收通过。未修改渠道/供应商配置，也未创建密钥。

最初的验收脚本因 macOS 临时路径含符号链接触发既有路径保护，未写配置或发模型请求；改用独立实体目录后配置写入成功。两种临时配置已通过原生恢复功能还原，用户现有配置与 auth.json 哈希保持一致。证据在 `output/test-user-20261015/`，完整线上记录见相邻后端 `docs/worklog/2026-10-15-conpera-switch-online.md`。

源码已推送至单一功能分支。主线原有 CI 对 server.js 的映射已超过 12 文件上限，整个功能会选中 25 文件；未放宽上限或减弱覆盖，源码 PR 保持草稿，线上镜像验收与源码合并状态分别记录。

安装包当前为本机 arm64 ad-hoc 签名，尚无 Developer ID 或 Apple 公证；最低目标 macOS 13，不代表已在各系统版本与 Intel 实机完成验证。

## 配置依据

- [Codex 官方配置参考](https://developers.openai.com/codex/config-reference/)
- [Claude Code 设置与优先级](https://code.claude.com/docs/en/settings)
- [后端决策](https://github.com/conpera/conpera-code/blob/c4c949c39f1ea3d57679850d4ef1269bbbea39c4/docs/adr/0070-conpera-switch-desktop-grants.md)
- [后端契约与发布/停用步骤](https://github.com/conpera/conpera-code/blob/c4c949c39f1ea3d57679850d4ef1269bbbea39c4/docs/architecture/conpera-switch.md)

交接：真实 test003 授权、重启保持、本人数据读取、退出撤销与 Claude 实际调用已通过。Codex 的所选测试渠道上游失败和发行签名仍未完成。读取本记录和后端线上 worklog；不要将配置已生效描述成模型运行成功。
