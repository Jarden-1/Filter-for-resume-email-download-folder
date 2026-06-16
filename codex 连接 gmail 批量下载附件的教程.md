# codex 连接 gmail 批量下载附件的教程

这份教程记录本项目如何让 Codex 通过 `gog` CLI 连接 Gmail，并批量下载邮件附件。当前项目的网页按钮“同步 Gmail”本质上也是调用同一套本地脚本：扫描 Gmail、跳过已下载附件、下载新增附件，然后更新网页读取的附件索引。

## 1. 整体方案

本项目没有直接保存 Gmail 密码，也不会通过浏览器偷取登录状态。流程是：

1. 在 Google Cloud 创建 OAuth 应用。
2. 启用 Gmail API。
3. 下载 OAuth client JSON。
4. 用 `gog` CLI 完成 Gmail 只读授权。
5. 项目脚本调用 `gog` 读取 Gmail 邮件和附件。
6. 网页读取本地索引并展示简历、其他附件、预览、评分和备注。

项目里的关键文件：

- `scripts/download-gmail-resume-attachments.mjs`：批量扫描 Gmail 并下载附件。
- `vite.config.ts`：提供本地 API，包括 `/api/library`、`/api/file/:id`、`/api/sync`。
- `gmail-resume-attachments/`：下载后的附件目录。
- `gmail-resume-attachments/resume-index.json`：网页读取的附件索引。
- `gmail-resume-attachments/review-records.json`：网页评分和备注记录，后端重启后会继续读取。
- `.gmail-oauth/`：本机 OAuth 辅助文件，不能分享给别人。

## 2. 准备工具

先确认本机有 Node.js、npm 和 Homebrew。然后安装 `gog`：

```bash
brew install gog
```

检查是否安装成功：

```bash
gog --version
gog --help
```

安装项目依赖：

```bash
npm install
```

## 3. 创建 Google Cloud 项目

打开 Google Cloud Console：

https://console.cloud.google.com/

创建或选择一个项目。建议单独建一个项目，例如：

```text
gmail-resume-downloader
```

后续 OAuth client、Gmail API、测试用户都放在这个项目里。

## 4. 启用 Gmail API

在 Google Cloud Console 中进入：

```text
APIs & Services > Library
```

搜索：

```text
Gmail API
```

点击 Gmail API，然后点击 `Enable`。

如果没有启用 Gmail API，后面授权或读取邮件时可能会遇到 `access not configured`、`API has not been used` 一类错误。

## 5. 配置 OAuth 同意屏幕

进入：

```text
Google Auth Platform / OAuth consent screen
```

或：

```text
APIs & Services > OAuth consent screen
```

按页面提示填写：

- App name：可以填 `gmail-resume-downloader`
- User support email：填自己的 Gmail
- Audience / User type：个人 Gmail 通常选 `External`
- Contact email：填自己的 Gmail

如果应用还处于 `Testing` 状态，必须把自己要授权的 Gmail 加到测试用户里：

```text
Audience > Test users > Add users
```

把自己的 Gmail 地址加进去。

本项目只需要只读读取邮件和附件，核心 scope 是：

```text
https://www.googleapis.com/auth/gmail.readonly
```

授权流程里也可能出现这些基础身份 scope：

```text
openid
email
https://www.googleapis.com/auth/userinfo.email
```

如果授权时出现 “The developer has not given you access to this app” 或 `access_denied`，通常是测试用户没有添加正确，或者你登录的 Google 账号不是测试用户列表里的账号。

## 6. 创建 OAuth Client ID

进入：

```text
APIs & Services > Credentials
```

或新版界面：

```text
Google Auth Platform > Clients
```

点击：

```text
Create credentials > OAuth client ID
```

Application type 选择：

```text
Desktop app
```

名称可以填：

```text
gog-gmail-resume-downloader
```

创建后下载 JSON 文件。文件名通常类似：

```text
client_secret_xxx.apps.googleusercontent.com.json
```

建议放到项目的私有目录：

```bash
mkdir -p .gmail-oauth
mv ~/Downloads/client_secret_*.json .gmail-oauth/
```

注意：这个 JSON 包含 OAuth client 信息，不要发给别人，也不要打进分享包。

## 7. 让 gog 读取 OAuth client

在项目根目录执行：

```bash
gog auth credentials .gmail-oauth/client_secret_xxx.apps.googleusercontent.com.json
```

把命令里的文件名换成你实际下载的 JSON 文件名。

如果你看到：

```text
OAuth credentials not configured. Run: gog auth credentials <file>
```

说明这一步还没做，或者 `gog` 没找到之前保存的 credentials。

## 8. 授权 Gmail 账号

执行：

```bash
gog auth add your-email@gmail.com
```

把 `your-email@gmail.com` 换成你自己的 Gmail。

命令会打开浏览器，让你登录 Google 并同意 Gmail 只读权限。授权完成后，浏览器会跳回本机 localhost 回调页面。

如果本机使用 `gog` 的 file keyring，并且项目里有 `.gmail-oauth/gog-keyring-password`，可以这样执行：

```bash
GOG_KEYRING_PASSWORD="$(cat .gmail-oauth/gog-keyring-password)" gog auth add your-email@gmail.com
```

检查授权状态：

```bash
gog auth list --json
```

能看到账号，并且 services 里包含 `gmail`，就说明授权成功。

## 9. 单独测试 Gmail 读取

先测试搜索邮件：

```bash
gog --gmail-no-send \
  --account your-email@gmail.com \
  gmail messages search 'has:attachment filename:pdf' \
  --max=5 \
  --json
```

这里的 `--gmail-no-send` 是安全限制，用来阻止 Gmail 发送相关操作。本项目读取附件时也会加这个限制。

如果这条命令能返回 JSON，说明 Gmail 读取权限可用。

## 10. 批量下载附件

在项目根目录执行：

```bash
node scripts/download-gmail-resume-attachments.mjs \
  --account your-email@gmail.com \
  --all
```

如果需要带 keyring password：

```bash
GOG_KEYRING_PASSWORD="$(cat .gmail-oauth/gog-keyring-password)" \
node scripts/download-gmail-resume-attachments.mjs \
  --account your-email@gmail.com \
  --all
```

脚本默认 Gmail 查询条件是：

```text
has:attachment (filename:pdf OR filename:doc OR filename:docx OR filename:xls OR filename:xlsx OR filename:rtf) (resume OR cv OR "简历" OR "履历")
```

默认会下载这些扩展名：

```text
.pdf, .doc, .docx, .xls, .xlsx, .rtf
```

下载结果会进入：

```text
gmail-resume-attachments/
```

索引会写入：

```text
gmail-resume-attachments/resume-index.json
```

日志会写入：

```text
gmail-resume-attachments/download-log.json
```

脚本会用 `messageId + attachmentId` 识别同一个附件。已经下载且本地文件还存在的附件，会直接跳过，不会重复下载。

## 11. 先 dry-run 看看会下载什么

如果不想马上下载，可以先跑：

```bash
node scripts/download-gmail-resume-attachments.mjs \
  --account your-email@gmail.com \
  --all \
  --dry-run
```

dry-run 会扫描匹配邮件和附件，但不会真正写入附件文件。

## 12. 启动网页并使用同步按钮

启动本地网页：

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

也可以双击：

```text
启动简历筛选工具.command
```

如果 5173 端口被占用，启动脚本会自动找下一个可用端口。

打开网页后，点击：

```text
同步 Gmail
```

网页会请求本地接口：

```text
POST /api/sync
```

本地接口会：

1. 读取已授权的 Gmail 账号。
2. 调用 `scripts/download-gmail-resume-attachments.mjs --all`。
3. 跳过已下载附件。
4. 下载新增附件。
5. 更新 `resume-index.json`。
6. 刷新网页上的简历和其他附件列表。

全量扫描可能需要几十秒到一两分钟，取决于命中的邮件数量。慢的部分主要是 Gmail 搜索和逐封读取附件结构，不是重复下载。

## 13. 简历和其他附件如何分类

脚本会把附件分成两类：

- `resume`：默认简历类附件。
- `other`：作品集、项目介绍、报告、offer、入职指南、证书等附件。

网页顶部有两个入口：

```text
简历
其他附件
```

明确带有这些关键词的文件会被归到其他附件：

```text
作品、作品集、项目、项目介绍、报告、方案、案例、portfolio、offer、入职、指南、协议、证明、证书、成绩单、推荐信
```

如果某个附件文件名很模糊，例如只有 `AI产品.pdf` 或 `产品运营.pdf`，脚本可能会保守地放在简历页，避免误把候选人简历分走。

## 14. 分享给别人时怎么处理

生成分享包：

```bash
npm run package:share
```

压缩包会生成在：

```text
share/
```

分享包会排除：

- `.gmail-oauth/`
- `gmail-resume-attachments/`
- `deleted-resume-downloads/`
- `node_modules/`
- `dist/`
- `share/`

也就是说，默认分享出去的是工具代码，不包含你的 OAuth 文件、授权 token、简历附件、已删除简历恢复文件、评分备注和下载日志。

如果你明确要把当前简历库、已删除简历恢复文件、评分备注一起打包给别人，可以执行：

```bash
npm run package:share -- --include-data
```

别人拿到压缩包后，需要：

1. 解压。
2. 执行 `npm install`。
3. 用自己的 Google Cloud 项目创建 OAuth client。
4. 用自己的 Gmail 账号执行 `gog auth credentials` 和 `gog auth add`。
5. 启动网页并点击“同步 Gmail”。

## 15. 常见问题

### OAuth credentials not configured

执行：

```bash
gog auth credentials .gmail-oauth/client_secret_xxx.apps.googleusercontent.com.json
```

### The developer has not given you access to this app

原因通常是 OAuth 应用处于 Testing 状态，但当前 Gmail 没有加入 test users。

处理方法：

1. 回到 Google Cloud 的 OAuth consent screen / Audience。
2. 把当前登录的 Gmail 加到 Test users。
3. 重新执行 `gog auth add your-email@gmail.com`。

### access not configured 或 Gmail API 未启用

回到 Google Cloud：

```text
APIs & Services > Library > Gmail API > Enable
```

然后重新授权。

### redirect_uri_mismatch

通常是 OAuth client 类型不对。建议重新创建一个 `Desktop app` 类型的 OAuth Client ID，然后重新下载 JSON，并执行：

```bash
gog auth credentials <新的 JSON 文件>
gog auth add your-email@gmail.com
```

### invalid_client

通常是 JSON 文件不是当前项目的 OAuth client，或者 client 被删除了。重新下载或重新创建 OAuth client。

### 网页提示没有 Gmail 授权账号

先检查：

```bash
gog auth list --json
```

如果没有账号，重新执行：

```bash
gog auth add your-email@gmail.com
```

### 同步很慢

全量扫描会读取每一封命中的邮件结构，所以会慢一些。已经下载过的附件不会重复下载。后续如果新增邮件少，同步主要耗时在 Gmail 搜索和元数据读取。

## 16. 安全注意事项

- 不要分享 `.gmail-oauth/`。
- 不要分享 `gmail-resume-attachments/`，除非你明确要分享简历附件本身。
- 不要把 OAuth client JSON、keyring password、token、下载日志提交到公开仓库。
- 本项目只需要 Gmail 只读权限。
- 运行 `gog` 时建议保留 `--gmail-no-send`。

## 17. 官方参考

- Google OAuth 2.0 总览：https://developers.google.com/identity/protocols/oauth2
- Google 桌面应用 OAuth 说明：https://developers.google.com/identity/protocols/oauth2/native-app
- OAuth 同意屏幕和 scopes：https://developers.google.com/workspace/guides/configure-oauth-consent
- Google API Console OAuth 设置帮助：https://support.google.com/googleapi/answer/6158849
- Google Cloud OAuth clients 帮助：https://support.google.com/cloud/answer/15549257
