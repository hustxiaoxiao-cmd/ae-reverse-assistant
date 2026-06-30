# AE 逆向助手 — 阿里云 FC 部署指南

## 前置条件

1. 阿里云账号（已实名认证）
2. 开通函数计算服务：https://fcnext.console.aliyun.com
3. 创建 AccessKey：https://ram.console.aliyun.com/manage/ak
4. Node.js 18+ 已安装

---

## 第一步：安装 Serverless Devs CLI

```bash
npm install -g @serverless-devs/s
```

安装完成后，执行以下命令配置凭证（按提示填写 AccessKey ID 和 Secret）：

```bash
s config add
```

选择 `Alibaba Cloud`，填写 AccessKey ID、AccessKey Secret，AccountID 可在 FC 控制台右上角查看。

---

## 第二步：编译 TypeScript

```bash
cd ~/Desktop/ae-reverse-assistant
npm run build
```

执行后生成 `dist/` 目录，包含编译后的 JavaScript 文件。FC 使用 Node.js 直接执行 `dist/index.js`，比 ts-node 冷启动快 3~5 秒。

---

## 第三步：确认 .env 文件

确认项目根目录的 `.env` 文件包含以下配置：

```
DASHSCOPE_API_KEY=你的DashScope密钥
API_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen-plus
EMBEDDING_MODEL=text-embedding-v1
```

FC 会将 `.env` 文件一起部署到 `/code` 目录，`dotenv` 会自动读取。

---

## 第四步：本地测试（可选）

本地模拟 FC 环境运行，验证配置是否正确：

```bash
PORT=9000 node dist/index.js
```

访问 http://localhost:9000 应能看到落地页，访问 http://localhost:9000/chat 进入对话助手页面。确认无误后 `Ctrl+C` 停止。

---

## 第五步：部署到 FC

```bash
cd ~/Desktop/ae-reverse-assistant
s deploy
```

首次部署约 1~2 分钟（包含上传代码包）。成功后，终端会输出公网访问 URL，格式类似：

```
https://ae-reverse-assistant-cn-hangzhou-xxxx.fcapp.run
```

直接在浏览器打开该 URL 即可访问。

---

## 第六步：验证部署

```bash
# 健康检查（返回知识库条目数和索引状态）
curl https://你的域名.fcapp.run/api/health

# 访问对话助手页面
# 浏览器打开 https://你的域名.fcapp.run/chat
```

---

## 常用操作

```bash
# 查看函数日志
s logs

# 更新代码后重新部署
npm run build && s deploy

# 查看函数详情（URL、配置等）
s info

# 删除函数
s remove
```

---

## 已知限制

**数据持久化**：FC 函数无状态，每次冷启动（约 15 分钟无流量后触发）会重置 `data/` 目录中的问答记录。对 Demo 来说影响不大，如需持久化可后续接入 OSS 或 NAS。

**冷启动延迟**：闲置后首次请求需等待容器启动（约 5~10 秒），加上知识库加载和向量索引构建，总延迟约 15~30 秒。后续请求在同一实例上会很快响应。

**免费额度**：每月前 100 万次调用免费，Demo 场景完全够用。超出后按 0.0001元/次 计费。

---

## 故障排查

| 现象 | 可能原因 | 解决方法 |
|------|---------|---------|
| 部署超时 | 代码包过大 | 执行 `npm run build` 确认 dist/ 存在 |
| 访问报 502 | 服务未正常启动 | `s logs` 查看启动日志 |
| 知识库为空 | `.env` 未正确加载 | 检查 `.env` 是否在根目录 |
| 流式响应中断 | 超时时间不足 | s.yaml 中 `timeout` 调至 300 |
| DashScope 报 401 | API Key 无效 | 检查 `.env` 中的 `DASHSCOPE_API_KEY` |
