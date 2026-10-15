# Conpera Switch

Conpera Switch 是用于切换 Codex / Claude Code 配置的 macOS 应用，支持系统浏览器登录、钥匙串会话、账户余额与密钥、本地配置切换和恢复。服务端实现维护在 [conpera/conpera-code](https://github.com/conpera/conpera-code/pull/124)，**已于 2026-10-15 部署并启用线上接口，对现有测试账户和管理员开放**。本仓库包含应用源码与独立 DEMO 构建。

## macOS 内测版（2026-10-15）

安装包下载：[GitHub Releases](https://github.com/conpera/conpera-switch/releases)。选择 `Conpera-Switch-Beta-mac-arm64.zip`，解压后将 `Conpera Switch Beta.app` 放入“应用程序”目录。校验文件随版本提供。

构建：`npm run build:mac:beta`。产物为 `release/Conpera Switch Beta.app`（bundle id `ai.conpera.switch.beta`），Apple Silicon、macOS 13+，本地 ad-hoc 签名，尚未 Developer ID 签名或公证。与旧 Demo 分开，不覆盖它。

从源码构建需要 Node.js 22+ 和 Xcode Command Line Tools：

```bash
npm ci
npm run build:mac:beta
```

- 登录在系统浏览器完成网站 SSO 与明确授权；原生层校验 PKCE / state / loopback 回调，将专用桌面令牌存入 Keychain。界面、网页存储、日志不接收账户令牌或完整 API Key。
- 权限由服务端每次检查：沿用现有 `TEST_USER_IDS` 用户集合与 active admin；昵称、邮箱或客户端标签均不能授予权限。
- 余额复用系统账本，保留服务端真实币种（当前上游 USD）；不会把美元余额标为人民币，也不做未经定义的汇率换算。
- 密钥列表来自本人账户，仅显示可用于对应工具的有效渠道/密钥。选中原机模式下的 Key 不写文件；点击 Conpera 后才由原生层获取并写入。新增或管理服务器密钥仍在网站完成。
- 配置文件默认是 `~/.codex/config.toml` 与 `~/.claude/settings.json`。支持应用进程收到的绝对 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`；从 Finder 启动不会自动继承 shell 的自定义环境变量。
- 写入前逐字节备份，0600 权限、原子替换和持久恢复日志；备份目录为 `~/Library/Application Support/Conpera Switch/configuration`。检测到外部修改则停止覆盖并保留备份。
- Codex 使用独立 `conpera_switch` provider，保留其他配置与 `auth.json`。Claude 更新 env 中的站点与密钥，移除冲突的 `ANTHROPIC_API_KEY`，保留其他设置。
- 恢复原机不需要在线会话，可从应用菜单分别恢复两个工具。退出账号保留已应用配置；网站会话失效后需重新连接。
- 界面只报告配置写入和读取核验；需重启客户端，项目配置、受管理配置和启动环境可能覆盖用户配置。test003 的 Claude Code 实际模型请求已通过；Codex 所选特惠渠道返回上游错误，不能将写入成功等同模型运行成功。

详见 [内测实现与验证](docs/BETA.md)。已用用户指定的 test003 验证真实授权、本人余额/密钥读取、重启保持和退出撤销；真实 CLI 验收使用独立配置目录，恢复通过，用户现有 CLI 配置未改变。

## 以下为保留的独立 Demo

## Demo Mac 应用

双击 `release/Conpera Switch.app` 即可启动，也可以将它复制到“应用程序”目录。当前构建为 Apple Silicon（arm64），最低部署版本 macOS 13；仅在本机系统上实测，未做跨版本兼容认证。

应用包含 Swift AppKit 窗口、系统 WebKit 界面和 Swift 本地模拟服务。所有网页资源都在包内，动态端口仅监听 `127.0.0.1`；运行不需要 Node、npm、终端或预先启动 4317/4318 服务。菜单支持退出、关闭窗口、刷新以及复制粘贴。登录窗口内容区默认 540×540，保持 1:1；登录后平滑展开为 1000×460 工作台，退出后恢复正方形。窗口按当前屏幕可见范围约束。

登录在应用的独立授权窗口中完成。这是演示授权，不是生产网站的系统浏览器 OAuth。隔离 WebKit 数据存储与模拟服务均只存在于本次运行，刷新页面保留模拟配置与登录，退出整个应用后清空。不会保存真实凭据。

```bash
npm install
npm run build:mac
npm run test:native
```

构建需要 Xcode Command Line Tools（Swift、iconutil、codesign）。打包脚本只替换本项目且 bundle id 匹配的旧产物，使用 ad-hoc 本地签名。没有开发者证书签名或 Apple 公证，当前产物用于本机评审。

## 运行

需要 Node.js 22+。

```bash
npm install
npm run dev
```

打开 http://127.0.0.1:4317 。开发服务与模拟身份服务都只监听本机；后端为 4318。请使用 `127.0.0.1`，服务会校验 Host / Origin。

```bash
npm run build
npm run preview
```

构建后的完整 Demo 位于 http://127.0.0.1:4318 。开发模式已经占用 4318 时，不要再启动第二个 preview。

## 可以体验的流程

- 首次打开显示正方形的「欢迎使用 conpera switch」登录页，名称使用较小的 24–38px 字号，仅提供登录入口。采用黑白、Helvetica 系无衬线字、左对齐网格和细分隔线，移除装饰插画、标语与游客入口。已登录时刷新直接进入工作台，退出登录返回欢迎页。
- 登录页保留克制的淡入与按钮状态过渡；工作台卡片悬停时保持原位，显示与网页卡片一致的光标点阵集群，移出后淡出。效果不拦截点击、不裁切下拉菜单，在触屏和系统减少动态效果模式下关闭。配置滑块、下拉选择、密钥弹层、账户菜单、余额数字和操作提示保留动效。

- 分别或同时将 Codex、Claude Code 切至 Conpera，再恢复原机模式。
- 选择不同渠道对应的演示 Key，管理和添加测试 Key 元数据。
- 登录：登录 Conpera → 在浏览器中继续 →「连接您的账户」授权页允许连接 → 返回看到演示账户和余额。授权页不展示头像、演示账户姓名和邮箱信息块；独立授权窗口默认 480×460，采用紧凑间距。
- 如果内嵌浏览器没有显示弹窗，点击“授权窗口未出现？在此继续”，用同页授权回退完成流程。
- 刷新后保持本地演示会话；刷新余额；余额卡片底部直接显示「退出登录」按钮，退出后回到登录页。账户菜单可模拟登录过期并重新连接。
- 登录过期时工作台仍可切换演示配置；退出登录则回到登录页。

## Demo 实现范围

| 能力 | 本次状态 |
| --- | --- |
| 白色主题、无边框阴影卡片、手机/窄窗口适配 | 已实现 |
| 配置、渠道、Key 选择交互 | 已实现，使用模拟状态 |
| 真实 `~/.claude` / `~/.codex` 读写、备份与恢复 | 未接入；无本机文件访问 |
| 本地授权码 + S256 PKCE + 一次性兑换 | 已实现，固定模拟账号 |
| 本地 HttpOnly / SameSite=Strict 会话、余额鉴权 | 已实现，只对本地模拟服务生效 |
| Conpera 生产网站登录、真实余额与真实 Key | 未接入 |
| macOS `.app`、AppKit 窗口、系统 WebKit、内置 Swift 模拟服务 | 已实现，可独立启动 |
| Tauri 跨平台端、系统钥匙串、生产桌面 refresh token 轮换 | 待实现 |

Demo 继续独立验证视觉、操作范围和账号连接流程，真实能力仅存在于上面的 BETA 构建。

配置切换和应用成功均为交互模拟；主页面保留 DEMO 标记，详细范围收在帮助弹层。演示 Key 不包含真实密钥内容；只有预设选择和模式偏好保存在 localStorage，自行添加的 Key 元数据在离开页面后重置。网页入口的 localStorage 可以跨浏览器重启保留；Mac 应用使用临时 WebKit 存储，退出应用后清空。账号会话使用独立的本地 HttpOnly Cookie，不把 token 写入 localStorage。同页授权回退仅临时保存 PKCE 请求数据于 sessionStorage，兑换或取消后清除。

模拟账户为 `creator@example.test`，余额固定为 `¥128.50`。后端状态在内存中，服务重启后失效。没有密码输入、支付动作或外网账户请求。

## 登录态设计

见 [docs/AUTH_DESIGN.md](docs/AUTH_DESIGN.md)：现有 BFF 能力的静态核验、正式桌面授权流程、最小权限、会话续期/撤销、余额接口，以及 Demo 与生产实现的明确边界。

## 验证

```bash
npm run build
npm test
# 另一个终端已运行 npm run dev，且已安装 Google Chrome
npm run test:browser
# 启动会话与窗口 focus 并发读取回归
DEMO_URL=http://127.0.0.1:4317 node scripts/verify-session-startup.mjs
```

后端测试使用临时监听端口和虚构身份，覆盖 PKCE、授权码重放、授权取消/过期、会话期限、退出、余额鉴权、旧 401 不清除新 Cookie、Origin/Host 校验、请求大小限制和静态路径安全。浏览器验证结果另见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

字标、Claude 图形、Codex 终端图标与自定义下拉菜单对齐 Conpera 网页；配色以黑白灰为主，绿色仅用于启用状态的小圆点。2026-10-14 起，登录页、工作台、弹窗、favicon 和 macOS 应用图标统一采用网站当前的深蓝底、银灰三重 C Logo，源图为 `public/favicon.svg`；原生图标直接读取该 SVG 生成，只增加 macOS 圆角、留白和阴影。Conpera 启用按钮使用黑底白字，下拉选中行使用浅灰底黑字。菜单支持方向键、回车、Esc 和 Tab，窄窗口内自动向上展开。素材随应用打包，不请求外部图片或字体。参考主页：https://conpera.ai/ 。
