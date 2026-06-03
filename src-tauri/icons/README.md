# 应用图标目录

Tauri 在 `tauri.conf.json` 中通过 `bundle.icon` 字段引用本目录下的图标文件。

> **当前状态**：图标占位。
> 后续需要补充以下格式（建议从单一 1024×1024 PNG 源图生成）：
>
> | 文件名                       | 用途                          |
> | ---------------------------- | ----------------------------- |
> | `icon.png`                   | 主图标（必备）                |
> | `32x32.png`                 | Windows / Linux 32×32        |
> | `128x128.png`               | macOS / Linux 128×128         |
> | `128x128@2x.png`            | macOS Retina 256×256          |
> | `icon.icns`                 | macOS 应用图标                |
> | `icon.ico`                  | Windows 应用图标              |
> | `Square*Logo.png`           | Windows Store                 |
> | `StoreLogo.png`             | Windows Store                 |

可以使用以下命令一键生成（需安装 [`tauri-cli`](https://tauri.app/v1/guides/distribution/publishing/)）：

```bash
pnpm tauri icon ./path/to/source.png
```
