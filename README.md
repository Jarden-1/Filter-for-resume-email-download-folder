# 简历筛选工作台

本项目是一个本机运行的简历查看和筛选工具。它可以读取 `gmail-resume-attachments/` 中的附件索引，展示简历、其他附件、PDF 预览、评分和备注，并支持通过 Gmail 只读权限同步新的简历附件。

## 启动

```bash
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

也可以在 macOS 上双击 `启动简历筛选工具.command`。

## Gmail 同步

同步按钮依赖本机安装并授权好的 `gog` CLI。授权只需要 Gmail 只读权限，工具不会请求或使用发信权限。

基本流程：

```bash
brew install gog
gog auth credentials <你的 OAuth client JSON 文件>
gog auth add <你的 Gmail 地址>
```

授权成功后，网页中的“同步 Gmail”会重新扫描匹配邮件，跳过已经下载过的附件，只下载新增附件。

## 数据目录

- `gmail-resume-attachments/`：下载的附件和本地索引
- `gmail-resume-attachments/resume-index.json`：网页读取的附件索引
- `gmail-resume-attachments/review-records.json`：网页评分和备注，后端重启后会继续读取
- `deleted-resume-downloads/`：重新下载的已删除简历
- `.gmail-oauth/`：本机 OAuth 辅助文件，不要分享给别人

## 打包分享

生成可分享压缩包：

```bash
node scripts/package-share.mjs
```

压缩包会放在 `share/` 下，并排除：

- `.gmail-oauth/`
- `gmail-resume-attachments/`
- `deleted-resume-downloads/`
- `node_modules/`
- `dist/`

如果你明确要把当前简历库、已删除简历恢复文件、评分备注一起打包给别人，可以运行：

```bash
node scripts/package-share.mjs --include-data
```

别人解压后需要安装依赖，并用自己的 Google Cloud OAuth 与 Gmail 账号授权。
