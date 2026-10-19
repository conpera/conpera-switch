# Conpera Switch

Conpera Switch 是开源的 macOS 应用，用于连接 Conpera 账户、查看余额与本人密钥，并切换或恢复 Codex / Claude Code 的本机配置。

## 安装 1.2

下载 [Conpera Switch 1.2.3](https://github.com/conpera/conpera-switch/releases/tag/v1.2.3) 的 `Conpera-Switch-1.2.3-mac-arm64.dmg`，打开后将 **Conpera Switch** 拖入 **Applications（应用程序）**。也提供 ZIP 和 SHA-256 校验文件。

- 适用于 Apple Silicon，要求 macOS 13 或更高版本。运行应用无需安装 Node.js。
- 当前安装包使用 ad-hoc 签名，尚未完成 Developer ID 签名与 Apple 公证，macOS 可能阻止首次启动。
- 1.0 使用独立应用标识 `ai.conpera.switch`，与旧 Beta / Demo 可共存；请在正式版重新登录。
- 线上接口向所有状态正常的 Conpera 用户与管理员开放；禁用账户和未知角色无法授权。

1.2.2 修复合法的 TOML 多行数组阻止 Codex 配置读取、编辑和切换的问题，保留数组顺序、注释及换行格式。语法错误单独提示行号，不回显敏感值。1.2.0 及以上版本可在应用内检查更新并升级。

1.2.3 将简洁拖拽安装界面纳入正式打包流程：浅色背景、安装引导与方向箭头，应用和 Applications 图标位置固定。保留 1.2.2 的多行 TOML 数组修复。

## 使用

1. 打开应用，点击登录，在系统浏览器完成 Conpera 登录与授权。
2. 为 Codex 或 Claude Code 选择当前密钥，点击 **Conpera** 应用本机配置。渠道下拉框会修改该密钥的线上渠道，保持 Key 不变；列出账户全部同类型可用渠道。
3. 重启对应 CLI，让它读取新配置。点击 **原机** 或使用应用菜单可恢复原配置。

渠道按名称合并显示；名称标有内部、测试、实验等字样的渠道收在「高级选项」中。已应用的内部渠道仍会显示，升级不会自动切换配置。

余额保持服务端返回的币种，不进行汇率转换。密钥创建和删除在 Conpera 网站完成，应用只显示密钥尾号。账户令牌保存在系统钥匙串，完整密钥只在原生层用于配置，不进入网页存储或界面。

默认配置位置为 `~/.codex/config.toml`、`~/.claude/settings.json`；支持应用进程收到的绝对 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`。Finder 启动不会自动继承终端环境变量。切换前保留原文件备份，检测到外部修改时停止覆盖。备份位于 `~/Library/Application Support/Conpera Switch/configuration`。退出登录会撤销桌面会话，保留已应用配置；离线也可从菜单恢复。

应用不会安装 CLI。模型是否可用仍取决于账户渠道：此前真实测试中 Claude Code 调用成功，所选 Codex 特惠渠道返回上游错误。配置写入成功不代表模型运行已通过。详细历史证据见 [Beta 验证记录](docs/BETA.md)。

## 检查更新

点击欢迎页或主界面右上角的「检查更新」，也可从 macOS 菜单 **Conpera Switch → 检查更新…** 打开。无需登录 Conpera。发现新版后选择下载安装，再点击重启完成更新；已是最新版本、网络失败和校验失败都有明确提示。

更新采用 [Sparkle 2.10.0](https://sparkle-project.org/documentation/)，从本仓库 GitHub Release 获取更新。默认仅手动检查，不自动下载或安装，不发送系统分析信息。更新信息与安装包都必须通过内置 Ed25519 公钥验证，安装包在解压前验证；签名错误不会安装。更新期间暂停账户与配置写入；请先保存或关闭配置编辑器。应用更新不修改 CLI 配置或账户凭据，但目前的 ad-hoc 签名可能使 macOS 在新版首次读取钥匙串时再次询问。

**1.1.0 及更早版本需先手动安装 1.2.0**，之后可在应用内升级。若应用位于只读磁盘映像中，请先拖入 Applications。

## 配置细节

点击 Codex / Claude Code 卡片右上角的设置图标；未登录时，也可从欢迎页的「本机配置」进入。

- **常用设置**：Codex 仅提供模型、思考强度和上下文窗口；Claude Code 提供模型、扩展思考和最大输出长度。留空或选择默认会移除相应覆盖。
- **配置原文**：直接编辑 TOML / JSON，与表单双向同步；不会修改 Codex 的 `auth.json`。已识别的密钥和敏感字段以占位符显示，必须保留；包含敏感字段的 TOML 内联容器整体保护。Conpera 启用时，连接地址与密钥继续由首页管理。
- 保存前校验格式、检查文件是否在外部变化；保存后读回核验。可以撤销上次保存，恢复之前的文件内容和权限。编辑期间的未保存修改会在关闭或重新读取前提醒。
- 设置仅写入本机用户配置；保存后重启对应客户端。项目配置、环境变量、管理员策略和模型能力可能影响实际生效。应用未代替 CLI 验证每种模型与参数组合。

支持 UTF-8 配置，编辑上限为 512 KiB。Codex 使用保守的 TOML 编辑器，支持标量、单行及多行数组、内联表和普通表。数组可包含注释、空行、尾随逗号和嵌套数组；无关配置保留顺序、注释及 LF / CRLF 格式。多行字符串和数组表仍会提示暂不支持；语法错误单独提示行号，不回显配置值，原文件保持不变。Claude Code 原文保存时会规范化 JSON 缩进和键顺序。

参数依据 [Codex 配置参考](https://developers.openai.com/codex/config-reference)、[Claude Code 设置参考](https://code.claude.com/docs/en/settings-reference)和[环境变量参考](https://code.claude.com/docs/en/env-vars)。

## 从源码构建

需要 macOS、Node.js 22+ 和 Xcode Command Line Tools。DMG 布局由 Finder 保存，打包时需要已登录的图形桌面，并允许构建终端控制 Finder。构建架构与当前 Node 进程架构一致；已交付安装包为 arm64。

```bash
npm ci
npm run package:mac
```

输出在 `release/1.2.3/`，包含应用、DMG、ZIP、`SHA256SUMS` 和发行清单。`npm run build:mac` 仅构建正式应用。第三方许可证随应用资源打包。正式构建会下载并核对固定 SHA-256 的 Sparkle 官方发行包；下载缓存位于忽略的 `output/vendor`。

DMG 使用浅色拖拽安装窗口，背景包含普通和 Retina 两种分辨率。仅调整安装窗口时，可执行 `node scripts/package-mac.mjs` 复用版本匹配的已构建应用；对外发布仍需按下文生成签名更新源。

定向验证：

```bash
npm run build
npm run test:account
npm run test:configuration
npm run test:release-browser
npm run test:settings-browser
```

浏览器检查需要已安装 Google Chrome，使用隔离身份和模拟原生桥接，阻止外网访问。Swift 测试使用临时目录，不读取或修改用户真实 CLI 配置。设置界面检查通过真实 Swift 桥接写入隔离目录，拒绝账户网络请求和钥匙串访问。

### 发布带签名的更新

维护者执行 `npm run package:mac:release`，复用上述打包流程并生成带签名的 `appcast.xml`。更新私钥通过 `CONPERA_UPDATE_KEY_FILE` 指定，默认位置为本机 `~/Library/Application Support/Conpera Switch Release/ed25519.key`；必须为权限 0600 的文件，内含 base64 编码的 32 字节 Ed25519 私有种子，且公钥必须与构建配置匹配。私钥不进入源码、安装包或发布产物，请另行安全备份。当前未使用 Developer ID 签名，丢失更新私钥后不能用现有更新信任链发布新包。

将 DMG、ZIP、`SHA256SUMS`、`release-manifest.json` 和 **`appcast.xml`** 一起上传到同一正式 GitHub Release，再将该 Release 设为 latest。应用固定读取 `https://github.com/conpera/conpera-switch/releases/latest/download/appcast.xml`；下载地址指向对应版本的 ZIP。不要发布缺少 appcast 的 latest 版本，也不要手动改动已签名的 XML。发布前核对版本与签名，发布后验证公开下载和应用内检查；需要回退更新渠道时将 latest 指回先前有效 Release，客户端不会因此自动降级。

更新集成测试：`DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/test-updater-fixture.mjs` 会创建独立应用、临时签名密钥和回环测试源。`output/updater/fixture.json` 记录测试路径；通过 `scenario.txt` 的 `offline`、`tampered-feed`、`tampered-archive`、`valid` 测试错误与完整升级。测试应用明确禁止账户、钥匙串及真实 CLI 配置访问。完成后退出测试应用，再停止服务。

## 本地 Demo

`npm run dev` 在 `http://127.0.0.1:4317` 提供模拟界面；`npm run build:mac:demo` 构建独立 Demo。Demo 使用虚构账户，不连接线上账户或修改真实配置。正式应用关闭 Demo HTTP 接口，通过原生桥接访问 `https://code.conpera.ai/api/switch/*`。服务端单独维护，不属于本客户端开源范围。

## 许可与反馈

源码采用 [MIT License](LICENSE)。随应用分发的依赖见 [第三方许可](THIRD_PARTY_NOTICES.md)。问题与建议请提交至 [GitHub Issues](https://github.com/conpera/conpera-switch/issues)。

Codex 标识采用 [OpenAI Codex 客户端](https://developers.openai.com/codex/app) 随附的单色 SVG。品牌名称及标识归各自权利人所有，不属于本项目的 MIT 授权范围。
