# Conpera Switch

Conpera Switch 是开源的 macOS 应用，用于连接 Conpera 账户、查看余额与本人密钥，并切换或恢复 Codex / Claude Code 的本机配置。

## 安装 1.1

下载 [Conpera Switch 1.1.0](https://github.com/conpera/conpera-switch/releases/tag/v1.1.0) 的 `Conpera-Switch-1.1.0-mac-arm64.dmg`，打开后将 **Conpera Switch** 拖入 **Applications（应用程序）**。也提供 ZIP 和 SHA-256 校验文件。

- 适用于 Apple Silicon，要求 macOS 13 或更高版本。运行应用无需安装 Node.js。
- 当前安装包使用 ad-hoc 签名，尚未完成 Developer ID 签名与 Apple 公证，macOS 可能阻止首次启动。
- 1.0 使用独立应用标识 `ai.conpera.switch`，与旧 Beta / Demo 可共存；请在正式版重新登录。
- 线上接口向所有状态正常的 Conpera 用户与管理员开放；禁用账户和未知角色无法授权。

1.1.0 新增 Codex / Claude Code 常用设置表单与配置原文编辑。

## 使用

1. 打开应用，点击登录，在系统浏览器完成 Conpera 登录与授权。
2. 为 Codex 或 Claude Code 选择当前密钥，点击 **Conpera** 应用本机配置。渠道下拉框会修改该密钥的线上渠道，保持 Key 不变；列出账户全部同类型可用渠道。
3. 重启对应 CLI，让它读取新配置。点击 **原机** 或使用应用菜单可恢复原配置。

渠道按名称合并显示；名称标有内部、测试、实验等字样的渠道收在「高级选项」中。已应用的内部渠道仍会显示，升级不会自动切换配置。

余额保持服务端返回的币种，不进行汇率转换。密钥创建和删除在 Conpera 网站完成，应用只显示密钥尾号。账户令牌保存在系统钥匙串，完整密钥只在原生层用于配置，不进入网页存储或界面。

默认配置位置为 `~/.codex/config.toml`、`~/.claude/settings.json`；支持应用进程收到的绝对 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`。Finder 启动不会自动继承终端环境变量。切换前保留原文件备份，检测到外部修改时停止覆盖。备份位于 `~/Library/Application Support/Conpera Switch/configuration`。退出登录会撤销桌面会话，保留已应用配置；离线也可从菜单恢复。

应用不会安装 CLI。模型是否可用仍取决于账户渠道：此前真实测试中 Claude Code 调用成功，所选 Codex 特惠渠道返回上游错误。配置写入成功不代表模型运行已通过。详细历史证据见 [Beta 验证记录](docs/BETA.md)。

## 配置细节

点击 Codex / Claude Code 卡片右上角的设置图标；未登录时，也可从欢迎页的「本机配置」进入。

- **常用设置**：Codex 提供模型、思考强度、上下文窗口、自动压缩阈值和回答详细程度；Claude Code 提供模型、扩展思考和最大输出长度。留空或选择默认会移除相应覆盖。
- **配置原文**：直接编辑 TOML / JSON，与表单双向同步；不会修改 Codex 的 `auth.json`。已识别的密钥和敏感字段以占位符显示，必须保留；包含敏感字段的 TOML 内联容器整体保护。Conpera 启用时，连接地址与密钥继续由首页管理。
- 保存前校验格式、检查文件是否在外部变化；保存后读回核验。可以撤销上次保存，恢复之前的文件内容和权限。编辑期间的未保存修改会在关闭或重新读取前提醒。
- 设置仅写入本机用户配置；保存后重启对应客户端。项目配置、环境变量、管理员策略和模型能力可能影响实际生效。应用未代替 CLI 验证每种模型与参数组合。

支持 UTF-8 配置，编辑上限为 512 KiB。Codex 使用保守的 TOML 编辑器，目前支持标量、单行数组、内联表及普通表；多行值和数组表会明确拒绝，保留原文件。Claude Code 原文保存时会规范化 JSON 缩进和键顺序。

参数依据 [Codex 配置参考](https://developers.openai.com/codex/config-reference)、[Claude Code 设置参考](https://code.claude.com/docs/en/settings-reference)和[环境变量参考](https://code.claude.com/docs/en/env-vars)。

## 从源码构建

需要 macOS、Node.js 22+ 和 Xcode Command Line Tools。构建架构与当前 Node 进程架构一致；已交付安装包为 arm64。

```bash
npm ci
npm run package:mac
```

输出在 `release/1.1.0/`，包含应用、DMG、ZIP、`SHA256SUMS` 和发行清单。`npm run build:mac` 仅构建正式应用。第三方许可证随应用资源打包。

定向验证：

```bash
npm run build
npm run test:account
npm run test:configuration
npm run test:release-browser
npm run test:settings-browser
```

浏览器检查需要已安装 Google Chrome，使用隔离身份和模拟原生桥接，阻止外网访问。Swift 测试使用临时目录，不读取或修改用户真实 CLI 配置。设置界面检查通过真实 Swift 桥接写入隔离目录，拒绝账户网络请求和钥匙串访问。

## 本地 Demo

`npm run dev` 在 `http://127.0.0.1:4317` 提供模拟界面；`npm run build:mac:demo` 构建独立 Demo。Demo 使用虚构账户，不连接线上账户或修改真实配置。正式应用关闭 Demo HTTP 接口，通过原生桥接访问 `https://code.conpera.ai/api/switch/*`。服务端单独维护，不属于本客户端开源范围。

## 许可与反馈

源码采用 [MIT License](LICENSE)。随应用分发的依赖见 [第三方许可](THIRD_PARTY_NOTICES.md)。问题与建议请提交至 [GitHub Issues](https://github.com/conpera/conpera-switch/issues)。

Codex 标识采用 [OpenAI Codex 客户端](https://developers.openai.com/codex/app) 随附的单色 SVG。品牌名称及标识归各自权利人所有，不属于本项目的 MIT 授权范围。
