> 历史设计与验收记录；1.0 当前实现和构建入口见 [README](../README.md)。

# 当前验证入口

2026-10-19 安装包 1.2.3：在 1.2.2 的最新源码上合入浅色拖拽安装窗口，固定应用、Applications 图标及方向箭头的位置。`DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run package:mac:release` 完成前端与原生构建、DMG 校验、应用严格验签和 Sparkle 更新源签名；`npm run test:configuration` 的 176 项隔离检查通过。成品 DMG 重新挂载后确认版本为 1.2.3、包含背景与 Finder 布局，原生窗口已目视验收。更新源仍使用既有公钥；未写入真实 CLI 配置或执行账户操作。

2026-10-14 卡片悬停调整：移除主界面三张卡片及其图标的悬停位移/旋转，采用网页卡片的光标点阵遮罩。构建、Demo/Beta 打包验签及现有 40 项 Demo 浏览器检查通过；读取三张卡片悬停前后的坐标与 transform，位置保持一致。效果层不接收点击，移出清除激活状态；验证与产物记录在 `output/pixel-hover-20261014/`。欢迎页同时保留较小的「conpera switch」标题。

2026-10-14 Logo 对齐：`public/favicon.svg` 与线上 `https://conpera.ai/favicon-bb816b682cfb3181.svg` 字节一致（SHA-256 `bb816b682cfb3181de6d959b5f2af8394ede38b64284ecbe516d69ab2e601520`）。界面和 macOS 图标生成共用此文件。

- TypeScript / Vite 构建、Demo 与 Beta 的 arm64 打包及 ad-hoc 严格验签通过。使用 `DEVELOPER_DIR=/Library/Developer/CommandLineTools`，未修改系统 Xcode 选择或接受许可。
- 现有 Demo 浏览器 40 项检查、Beta 合成原生桥浏览器 51 项检查通过；包含紧凑窗口和手机宽度。没有真实账户或 CLI 配置写入。
- 实际 AppKit / WKWebView 窗口已验证欢迎页、演示登录和工作台的新标识；截图见 `output/logo-alignment-20261014/`。应用图标保留系统圆角和透明留白。
- Demo / Beta `.app` 与对应 arm64 ZIP 同步更新；仍为本地 ad-hoc 签名，未公证。

2026-10-08 macOS BETA 系统接入的最新证据见 [BETA.md](BETA.md)。下面保留历史 Demo 记录，仅对应 DEMO 构建。

# Demo 验证记录

日期：2026-10-06。所有身份、会话、Key 和余额均为隔离的本地演示数据。

## 已完成

- `npm run build`：TypeScript 类型检查与 Vite 构建通过。
- `npm test`：本地授权后端 10 项测试通过。涵盖 PKCE、授权码单次消费/重放、过期和取消、会话与余额鉴权、退出、Origin/Host、请求限制、静态路径安全，以及迟到 401 不清除新会话 Cookie。
- `node scripts/verify-browser.mjs`：使用全新隔离 Chrome headless profile，19 项浏览器断言通过。未读取用户 Chrome profile 或 Cookie。
- Codex 内嵌浏览器手动验证了同页授权回退，成功返回主界面并显示模拟账户与余额。
- 构建产物在 `127.0.0.1:4318` 额外验证了授权登录、余额显示和双工具切换，并保存最终桌面截图。
- 已查看 1440×900 桌面、390×844 手机完整页面和授权页截图；1040×760 窄窗口与手机宽度均无横向溢出。

## 白色主题更新

- 改为白色主题、无边框卡片、柔和阴影分隔，浅绿色标记当前选择；主界面、登录弹窗、密钥管理、账户菜单及独立授权页统一适配。
- 更新后再次通过 `npm run build`，并对 `127.0.0.1:4318` 构建产物运行原有 19 项浏览器断言，全部通过。
- 查看桌面、手机、授权页和密钥弹窗截图；手机授权页没有横向溢出。读取 computed style 确认工具卡片、账户卡片、账户菜单的边框宽度为 `0px` 且包含阴影，弹窗边框宽度为 `0px`。
- 此次仅改视觉样式与文档，没有修改授权后端，因此未重复后端测试；原有 10 项后端测试结果见上。

## 浏览器流程

1. 未登录时仍可使用配置切换；同时启用两种工具与同时恢复。
2. 切渠道同时选择对应 Key；新增演示 Key 后正确选中；Escape 可关闭弹层。
3. 取消授权不建立登录状态；弹窗授权成功后读取演示余额。
4. 页面刷新保持登录；会话 Cookie 为 HttpOnly、SameSite=Strict，Path 限于 `/api/demo`。
5. 登录过期后余额接口返回 401，工具配置保持原状；重新授权可恢复。
6. 同页授权回退成功；兑换后临时 PKCE 数据从 sessionStorage 清除。
7. 退出后余额接口返回 401；刷新页面仍未登录；本地配置选择保留。
8. 没有浏览器运行时异常。

## 交付边界

本次没有执行真实 Claude/Codex 配置读写、原生 Tauri 打包、生产网站授权或余额读取。macOS 原生壳采用 Swift AppKit + WKWebView，并已打包为 `.app`；界面里的快照和切换成功仍是演示状态，不是本机配置写入证据。生产登录设计中标为“待实现”的能力仍未运行验证。

## macOS 应用更新

- `npm run build` 与 `node scripts/build-mac.mjs` 通过，产物为 `release/Conpera Switch.app`，arm64，约 1 MB。ad-hoc 签名严格校验通过；没有 Developer ID 签名或 Apple 公证。
- 可执行文件依赖检查只包含 macOS 系统框架/库；所有页面资源位于包内，不依赖 Node 或 4317/4318 开发服务。
- `node scripts/test-native.mjs` 自动编译、启动和清理临时 Swift 服务，19 项 HTTP 检查通过，覆盖请求分包、Host/Origin、危险头、大小限制、路径检查、PKCE 单次使用、Cookie 和余额鉴权。
- 原 19 项浏览器检查在 Swift 后端上全部通过；临时服务测试结束后已停止。
- 在真实 AppKit / WKWebView 窗口中验证了双工具切换、独立授权窗口、授权回传与余额、Cmd-R 刷新后保持登录、退出登录，以及手动关闭授权窗口后可重试。
- 原生实机截图：`output/macos-app.png`。应用仅在当前 Apple Silicon Mac 实测；macOS 13 是构建部署目标，其他系统版本没有实测。

截图保存在 `output/desktop-guest.png`、`output/desktop-connected.png`、`output/mobile-connected.png`、`output/authorization.png`；新增 `output/key-modal.png`、`output/login-modal.png`、`output/account-menu.png` 与 `output/mobile-authorization.png`。该目录不纳入版本管理。

## 三卡片极简版

- 按用户提供的概览参考更新为 Codex、Claude Code、余额三张直角白卡，移除宣传区、底部说明及重复状态；全局切换、帮助、密钥管理、余额刷新均使用有名称和提示的图标。
- 构建、Mac 打包及 ad-hoc 验签通过；主窗口收为 1000×460，最小 880×430。
- 调整现有浏览器检查以匹配账户菜单里的过期入口、未登录时的余额占位符，19 项交互检查全部通过；桌面和手机截图已查看，无横向溢出。
- 本轮仅修改界面、文字及窗口尺寸；授权后端未改，未重复后端测试。
- 更新后的 Mac 实机窗口已验证单工具切换、简化登录入口、独立授权窗口及余额回传；`output/macos-app.png` 更新为三卡片实机画面，`output/macos-guest.png` 为未登录状态。

## 网页品牌与下拉菜单对齐

- 只读对照 Conpera 现有网页源码与线上页面，将字标调整为 15px / 400 / 5.25px 字距；使用网页的 Claude 图形、Codex 终端方框图标、账单硬币图标及 favicon 的 C + 青绿色圆点应用图标。
- 原生 select 替换为网页同款无框触发器、白色阴影菜单和浅青色选中行；键盘聚焦使用细底线，支持方向键、回车、Esc、Tab、外部点击和紧凑弹层内向上展开。
- `npm run build:mac` 通过，包括类型检查、前端构建、Swift 编译、图标打包与 ad-hoc 签名校验；同步更新 `.app` 和 arm64 ZIP。
- 在 `127.0.0.1:4318` 最终构建产物运行 25 项浏览器断言全部通过。新增检查包括焦点恢复、点击展开后的 Esc、Tab/外部点击关闭、Esc 不误关父弹层，以及 1000×460 下菜单截图后仍可见且能接收点击。
- 真实 AppKit / WKWebView 发现并修复点击按钮后未聚焦导致 Esc 无效的问题；最终实机验证鼠标展开、空格/方向键/回车选择渠道、Esc 关闭菜单且保留密钥弹层、紧凑弹层菜单向上显示。另确认模拟配置切换和登录余额回传。
- 实机截图：`output/macos-app.png`、`output/macos-dropdown.png`、`output/macos-form-dropdown.png`。本轮未修改授权后端或真实配置能力，未重复后端测试；仍使用隔离模拟数据。

## 黑白为主、绿色点缀

- 页面背景、阴影、文字、按钮、下拉选中行、密钥弹层、账户菜单和授权页统一为中性黑白灰；Conpera 启用态用黑底白字。绿色仅保留在 5px 启用状态圆点和品牌图标圆点，错误/过期提示保留语义色。
- `npm run build:mac` 及最终构建产物的原有 25 项浏览器检查通过；`.app` 和 arm64 ZIP 均已更新。此次仅配色改动，未重复后端测试。
- 已查看授权页、紧凑密钥弹层的截图，并在真实 Mac 窗口检查黑白按钮、下拉选中行、登录弹层及登录后余额卡片。最终画面：`output/macos-monochrome.png`；登录弹层：`output/macos-login-monochrome.png`。
- 配置切换、账号和余额仍为本地模拟；此次没有读取或写入真实 CLI 配置。


## 欢迎登录页与完整动效（2026-10-08）

- 新增「欢迎使用 CONPERA」开场页、品牌轨道与工具浮卡，支持直接授权、等待/取消/成功状态及游客入口。有效会话刷新跳过开场，退出回开场；会话过期仍可在工作台重新连接。
- 加入卡片错峰入场、悬停/按压反馈、模式滑块、渠道菜单双向展开与退出、密钥/帮助/登录弹层退出、账户菜单、提示消失、余额数字过渡和授权页状态动效。支持 `prefers-reduced-motion`。
- `npm run build` 类型检查和生产构建通过；`node scripts/build-mac.mjs` Mac 构建和严格 ad-hoc 签名校验通过。应用包已包含最终会话竞态修复。
- `DEMO_URL=http://127.0.0.1:4318 npm run test:browser`：39 项断言通过，覆盖欢迎/取消/登录/退出/游客、既有配置与密钥操作、授权回退和会话、布局、实际滑块位移、弹窗退出、减少动态效果与运行异常。随后稳定截图等待调整后的 `--motion-only` 6 项通过。
- 复核发现并修复启动请求与窗口 focus 并发读取的竞态：不能让有效会话滞留欢迎页，也不能在服务失败后无限停留启动页。最终构建运行 `scripts/verify-session-startup.mjs` 两项回归通过；另实际验证欢迎页同页授权回退、旧弹窗关闭与临时授权清理。
- 已目视检查 1000×460 和 390×844 欢迎页，两处入口均在首屏且无横向溢出。截图：`output/welcome-compact.png`、`output/welcome-mobile.png`；截图等待有限时长入场动画完成，保留轨道慢速动画。
- 真实 Mac AppKit/WKWebView 已验证欢迎页打开独立授权窗口、允许连接、成功自动进入工作台与 ¥128.50 演示余额；密钥弹层中 Esc 先关菜单、再次 Esc 关闭弹层。
- 本轮只变更前端体验，未改授权后端或真实配置能力；未重复后端测试。登录、余额及工具配置仍为本地模拟。


## 正方形瑞士风格登录页（2026-10-08，覆盖上一版开场设计）

- 按用户截图移除品牌轨道、C 字装置、工具浮卡、英文标语、宣传文案、游客入口与「演示账户 · 无需密码」脚注。登录页仅保留产品名称、DEMO 标识、「欢迎使用 CONPERA」与登录按钮；黑白、左对齐、Helvetica 系字体、细分隔线，保留短淡入和按钮状态过渡。
- Mac 登录内容区默认 540×540，保持 1:1；登录成功展开为 1000×460 工作台，退出回到正方形。窗口桥只接受主 WebView 同源首页、主 frame、welcome/dashboard 白名单，无文件或配置访问能力。
- `npm run build`、Swift typecheck、Mac 打包与严格 ad-hoc 验签通过。最终浏览器流程 40 项和启动竞态 2 项通过，覆盖移除内容、唯一登录入口、取消/重连/退出及原工作台能力。
- 1000×460、540×540、390×844 网页视口内登录页面均为正方形，登录按钮完整可见，无横溢。已目视查看 `output/welcome-compact.png`、`output/welcome-square.png`、`output/welcome-mobile.png`。
- 重启真实 Mac 应用后确认方形窗口及极简排版，实际完成授权并展开至横向工作台，显示演示余额，退出后恢复方形登录页。最终窗口保留在登录页供体验。
- 授权身份、余额与配置依旧为本地模拟；无生产访问。本轮未变更后端，因此未重复后端测试。

## 主界面退出登录入口（2026-10-15）

- 余额卡片底部直接展示「退出登录」图标与文字按钮；退出期间显示忙碌状态，沿用原有会话撤销及错误处理。账户菜单保留账户信息和 Demo 的模拟过期入口。
- TypeScript / Vite 构建、Demo 和 Beta 的 Swift 打包及严格 ad-hoc 验签通过；两个 arm64 ZIP 已更新，包内网页资源与本次 dist 逐文件核对一致。
- 现有 Demo 浏览器 40 项与隔离 Beta 浏览器 51 项检查全部通过。退出测试改为直接点击主界面入口；覆盖正常退出、退出后重新连接、保留应用配置、钥匙串清理失败和远端撤销未确认。
- 真实 Demo AppKit / WKWebView 已验证按钮可见、点击回到方形登录页、再次本地授权进入工作台。截图：`output/visible-logout-20261015/macos-dashboard.png`、`output/visible-logout-20261015/macos-after-logout.png`。Beta 使用隔离桥接数据验证，未操作真实账户退出。

## 授权页文案与账户信息块（2026-10-15）

- 授权页标题改为「连接您的账户」，移除头像、姓名、邮箱组成的演示账户信息块，并调整权限说明间距。
- TypeScript / Vite 构建、Demo / Beta 原生打包与严格 ad-hoc 验签通过；两个 ZIP 的网页资源与本次 dist 一致。现有 Demo 浏览器 40 项检查通过，包含允许连接、取消和同页授权回退；日志位于 `output/auth-copy-20261015/demo-browser.log`。
- 已在运行中的 Demo AppKit / WKWebView 打开新版授权页，确认标题、信息块移除和按钮布局实际生效。此次仅修改本地授权页展示，未变更生产账户授权流程。
- 同日按截图移除标题上方的电脑与勾选装饰图标，标题从卡片顶部开始排列。类型检查、前端构建、Demo / Beta 打包验签及 ZIP 资源核对通过；真实授权窗口已目视确认，截图为 `output/auth-no-icon-20261015/macos-authorization.png`。此项为纯展示修改，未重复登录流程测试。
- 同日将原生授权窗口从 580×780 收紧为 480×460，网页弹窗同步采用 480×460；品牌行与卡片对齐，收紧权限说明、提示与按钮间距。类型检查、前端构建、两个原生包验签及 ZIP 资源核对通过，现有 Demo 浏览器 40 项检查通过。重启 Demo 后实际打开新尺寸授权窗口，确认两个按钮完整可见，底部大块空白消除。截图：`output/auth-compact-20261015/macos-authorization.png`；日志：`output/auth-compact-20261015/demo-browser.log`。
