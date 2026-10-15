# Conpera Switch

Conpera Switch 是开源的 macOS 应用，用于连接 Conpera 账户、查看余额与本人密钥，并切换或恢复 Codex / Claude Code 的本机配置。

## 安装 1.0

下载 [Conpera Switch 1.0.4](https://github.com/conpera/conpera-switch/releases/tag/v1.0.4) 的 `Conpera-Switch-1.0.4-mac-arm64.dmg`，打开后将 **Conpera Switch** 拖入 **Applications（应用程序）**。也提供 ZIP 和 SHA-256 校验文件。

- 适用于 Apple Silicon，要求 macOS 13 或更高版本。运行应用无需安装 Node.js。
- 当前安装包使用 ad-hoc 签名，尚未完成 Developer ID 签名与 Apple 公证，macOS 可能阻止首次启动。
- 1.0 使用独立应用标识 `ai.conpera.switch`，与旧 Beta / Demo 可共存；请在正式版重新登录。
- 线上接口向所有状态正常的 Conpera 用户与管理员开放；禁用账户和未知角色无法授权。

1.0.4 将 Codex 卡片图标更新为 Codex 品牌标识。

## 使用

1. 打开应用，点击登录，在系统浏览器完成 Conpera 登录与授权。
2. 为 Codex 或 Claude Code 选择当前密钥，点击 **Conpera** 应用本机配置。渠道下拉框会修改该密钥的线上渠道，保持 Key 不变；列出账户全部同类型可用渠道。
3. 重启对应 CLI，让它读取新配置。点击 **原机** 或使用应用菜单可恢复原配置。

渠道按名称合并显示；名称标有内部、测试、实验等字样的渠道收在「高级选项」中。已应用的内部渠道仍会显示，升级不会自动切换配置。

余额保持服务端返回的币种，不进行汇率转换。密钥创建和删除在 Conpera 网站完成，应用只显示密钥尾号。账户令牌保存在系统钥匙串，完整密钥只在原生层用于配置，不进入网页存储或界面。

默认配置位置为 `~/.codex/config.toml`、`~/.claude/settings.json`；支持应用进程收到的绝对 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`。Finder 启动不会自动继承终端环境变量。切换前保留原文件备份，检测到外部修改时停止覆盖。备份位于 `~/Library/Application Support/Conpera Switch/configuration`。退出登录会撤销桌面会话，保留已应用配置；离线也可从菜单恢复。

应用不会安装 CLI 或改变模型选择。模型是否可用仍取决于账户渠道：此前真实测试中 Claude Code 调用成功，所选 Codex 特惠渠道返回上游错误。配置写入成功不代表模型运行已通过。详细历史证据见 [Beta 验证记录](docs/BETA.md)。

## 从源码构建

需要 macOS、Node.js 22+ 和 Xcode Command Line Tools。构建架构与当前 Node 进程架构一致；已交付安装包为 arm64。

```bash
npm ci
npm run package:mac
```

输出在 `release/1.0.4/`，包含应用、DMG、ZIP、`SHA256SUMS` 和发行清单。`npm run build:mac` 仅构建正式应用。第三方许可证随应用资源打包。

定向验证：

```bash
npm run build
npm run test:account
npm run test:configuration
npm run test:release-browser
```

浏览器检查需要已安装 Google Chrome，使用隔离身份和模拟原生桥接，阻止外网访问。Swift 测试使用临时目录，不读取或修改用户真实 CLI 配置。

## 本地 Demo

`npm run dev` 在 `http://127.0.0.1:4317` 提供模拟界面；`npm run build:mac:demo` 构建独立 Demo。Demo 使用虚构账户，不连接线上账户或修改真实配置。正式应用关闭 Demo HTTP 接口，通过原生桥接访问 `https://code.conpera.ai/api/switch/*`。服务端单独维护，不属于本客户端开源范围。

## 许可与反馈

源码采用 [MIT License](LICENSE)。随应用分发的依赖见 [第三方许可](THIRD_PARTY_NOTICES.md)。问题与建议请提交至 [GitHub Issues](https://github.com/conpera/conpera-switch/issues)。

Codex 标识采用 [OpenAI Codex 客户端](https://developers.openai.com/codex/app) 随附的单色 SVG。品牌名称及标识归各自权利人所有，不属于本项目的 MIT 授权范围。
