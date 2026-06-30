# shijinze-copy

一个跨平台剪切板管理器（对标 macOS 的 Maccy），基于 **Tauri v2 + TypeScript**。

## 功能

- 文本 / 图片 / 文件 历史，搜索、点击回填、自动粘贴
- 双列：左历史 + 右「常用」收藏（支持分组）
- 键盘全操作（↑↓ / Enter / ⌘1-9 / ⌘⌫ / ⌘P / Esc）
- 全局快捷键（可改键 + 备用键）、托盘、开机自启、忽略密码
- macOS：毛玻璃无边框 + 无 Dock 图标；Windows：亚克力磨砂 + 托盘

## 开发

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 打包
```

## 构建产物

- macOS：本地 `npm run tauri build`（需自签名证书，详见 `CLAUDE.md`）
- Windows：推送到 GitHub 后由 **Actions**（`.github/workflows/build-windows.yml`）自动构建 `.msi` / `.exe`

更多开发约定、问题记录、需求清单见 [`CLAUDE.md`](./CLAUDE.md)。
