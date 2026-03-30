# HTML to MasterGo

将网页 HTML 转换为 MasterGo 画布内容的插件项目。

支持将输入的网页内容转换为：
- 可编辑图层（基于 `@mastergo/html-mastergo`）
- 位图快照（作为兜底方案）

---

## 功能说明

- 支持输入 HTML 代码进行导入
- 支持输入网页链接抓取后导入
- 支持上传本地 `.html/.htm` 文件导入
- 提供可编辑转换与截图兜底链路
- 内置日志面板，便于排查资源加载与转换问题

---

## 技术栈

- Vue 3
- Vite 2
- MasterGo Plugin API
- `@mastergo/html-mastergo`
- `html-to-image`
- `html2canvas`

---

## 目录结构

```txt
html_to_mastergo/
├── lib/               # 插件主线程逻辑（main）
├── ui/                # 插件 UI（Vue）
├── messages/          # UI 与主线程消息定义
├── dist/              # 构建产物（main.js / index.html）
├── manifest.json      # MasterGo 插件清单
├── vite.config.ts
└── package.json
```

---

## 环境要求

- Node.js 16+
- Yarn 1.x

---

## 安装依赖

```bash
yarn install
```

---

## 本地开发

同时监听 UI 与主线程构建：

```bash
yarn dev
```

单独监听：

```bash
yarn dev:ui
yarn dev:main
```

---

## 打包构建

```bash
yarn build
```

构建后产物：
- `dist/index.html`（UI）
- `dist/main.js`（主线程）

---

## 在 MasterGo 中使用

1. 执行 `yarn build`
2. 在 MasterGo 插件开发/导入入口中选择本项目目录
3. 读取 `manifest.json`（其中已声明 `main` 与 `ui` 路径）
4. 运行插件并测试导入

当前 `manifest.json` 关键字段：
- `main: dist/main.js`
- `ui: dist/index.html`

---

## 常见问题

### 1) 链接导入后部分图片未显示

常见原因是跨域或目标站点防盗链限制。建议：
- 优先使用“HTML 代码导入”
- 或先保存完整页面资源后再导入

### 2) 页面样式与原网页不一致

常见原因是外链 CSS/字体加载失败。可通过日志确认：
- 外链 CSS 成功/失败数量
- 图片加载成功/失败数量

### 3) 转换成功但画布未聚焦到结果

通常是主线程环境差异导致的非致命问题，不影响生成结果本身。

---

## License

MIT
