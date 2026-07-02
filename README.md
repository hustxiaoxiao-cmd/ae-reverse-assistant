<p align="center">
  <strong>AE Reverse Assistant</strong><br/>
  轻量级 RAG 知识库问答助手 —— 专注AE逆向退货场景
</p>

<p align="center">
  <a href="#快速开始"><img src="https://img.shields.io/badge/npm-start-blue" alt="npm start"></a>
  <a href="#技术栈"><img src="https://img.shields.io/badge/TypeScript-5.5-blue" alt="TypeScript"></a>
  <a href="#核心特性"><img src="https://img.shields.io/badge/RAG-Dual--Channel-green" alt="RAG"></a>
</p>

---

## 项目简介

**AE Reverse Assistant** 是一个基于 RAG（Retrieval-Augmented Generation）架构的轻量级智能问答助手，专为 AE 逆向退货场景打造。目标是成为逆向物流业务的"超级百科全书"，通过 AI Agent 解决日常运营中的流程异常与操作答疑，并通过对问题数据的沉淀反哺业务优化。

系统整合退件服务、质检标准、销毁作业、RMS 操作等多份业务文档构建统一知识库，结合**向量语义检索**与**关键词检索**双通道融合，为运营人员提供精准的问答服务。

## 核心特性

- **双通道检索**：向量语义检索（权重 0.6）+ 关键词检索（权重 0.4）融合，兼顾语义理解和精确匹配，有效降低大模型幻觉
- **SSE 流式问答**：支持 Server-Sent Events 实时流式输出，打字机效果逐字呈现回答
- **智能文档处理**：自动按 Markdown 标题层级切分文档，注入面包屑上下文（如 `处置 > 免质检销毁 > 操作流程`），每个 chunk 都有完整业务归属
- **本地向量缓存**：首次构建索引后自动缓存（`.cache/vector-index.json`），后续启动秒级加载，零 API 调用；知识库变更时自动检测并重建
- **多模型容灾**：主模型限频时自动级联切换，配置 27 个备选模型（qwen/deepseek/glm/kimi/MiniMax），服务不中断
- **优雅降级**：向量索引构建失败或 API 限频时，自动降级为关键词搜索模式
- **多源知识接入**：支持本地 Markdown/TXT/PDF/Word 文件和钉钉文档 API 两种来源
- **数据分析看板**：内置问答统计面板，支持高频问题排行、周报/月报自动生成
- **回答反馈收集**：用户可对每条回答点赞/点踩并填写原因，持续优化回答质量
- **业务语义增强**：System Prompt 内置业务概念映射（如"退货=退件"），提升回答准确性
- **评测体系**：内置 RAG 检索评测脚本，支持 recall@5/@10/@20 指标量化

## 快速开始

```bash
# 1. 克隆仓库
git clone <repository-url>
cd ae-reverse-assistant

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 DashScope API Key

# 4. 启动服务
npm start
```

启动后访问：

| 页面/接口 | 地址 |
|-----------|------|
| 落地页 | http://localhost:3000 |
| 对话助手 | http://localhost:3000/chat |
| 数据看板 | http://localhost:3000/analytics |
| 流式问答 | `POST /api/query/stream`（SSE） |
| 非流式问答 | `POST /api/query` |
| 健康检查 | `GET /api/health` |

## 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript 5.5 |
| 运行时 | Node.js + ts-node |
| Web 框架 | Express 4.x |
| 前端 | 静态 HTML + marked.js（CDN） |
| LLM 接入 | OpenAI SDK（兼容 DashScope） |
| Embedding | text-embedding-v1 / v3 |
| LLM 模型 | qwen-plus（主）+ 27 个备选 |
| 向量检索 | 内存余弦相似度 |
| 关键词检索 | 2-4 字滑窗 + 停用词过滤 |
| 日志 | Pino |
| 测试 | Jest + ts-jest |

## 功能对比

| 特性 | MaxKB | Dify | Flowise | **本项目** |
|------|:-----:|:----:|:-------:|:---------:|
| RAG 引擎 | ✅ | ✅ | ✅ | ✅ |
| 向量 + 关键词混合检索 | ✅ | ✅ | ❌ | ✅ |
| SSE 流式输出 | ✅ | ✅ | ✅ | ✅ |
| 本地向量缓存 | ❌ | ❌ | ❌ | ✅ |
| 多模型容灾切换 | ❌ | ❌ | ❌ | ✅ |
| 自动降级机制 | ❌ | ❌ | ❌ | ✅ |
| 问答数据分析 | ❌ | ✅ | ❌ | ✅ |
| 业务概念定制 | ❌ | ❌ | ❌ | ✅ |
| 检索质量评测 | ❌ | ❌ | ❌ | ✅ |
| 零代码部署 | ✅ | ✅ | ✅ | ✅ |
| 可视化工作流 | ✅ | ✅ | ✅ | ❌ |

## 项目结构

```
ae-reverse-assistant/
├── src/
│   ├── index.ts                    # 入口：启动服务 + 后台构建索引
│   ├── agent/
│   │   └── agent.ts                # Agent 核心：Prompt + RAG 编排 + 流式输出
│   ├── knowledge/
│   │   ├── loader.ts               # 知识加载：文档解析 + chunk 切分 + 噪音清理
│   │   └── store.ts                # 知识存储：双通道检索 + 缓存管理
│   ├── connectors/
│   │   ├── embeddingProvider.ts    # Embedding 服务（DashScope 兼容）
│   │   └── vectorStore.ts          # 向量存储：余弦相似度检索
│   ├── api/
│   │   └── routes.ts               # API 路由（SSE/非流式/反馈/统计）
│   ├── services/
│   │   ├── queryService.ts         # 查询处理 + 回答格式化
│   │   └── analyticsService.ts     # 问答记录 + 高频问题 + 周/月报
│   ├── utils/
│   │   └── logger.ts               # Pino 日志封装
│   └── types/
│       └── index.ts                # TypeScript 类型定义
├── public/                          # 前端页面（静态 HTML）
│   ├── landing.html                # 落地页
│   ├── index.html                  # 对话助手 UI
│   └── analytics.html              # 数据分析看板
├── knowledge/                       # 知识库文档
├── data/                            # 运行时数据（向量缓存、问答记录）
├── scripts/                         # 评测脚本
├── tests/                           # 单元测试 + 评测集
├── .env                             # 环境变量配置
└── package.json
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DASHSCOPE_API_KEY` | DashScope API Key | （必填） |
| `API_BASE_URL` | API 基础地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `LLM_MODEL` | 主 LLM 模型 | `qwen-plus` |
| `LLM_MODEL_FALLBACK` | 备选模型列表（逗号分隔） | `qwen-turbo,qwen-long,...` |
| `EMBEDDING_MODEL` | Embedding 模型 | `text-embedding-v1` |
| `EMBEDDING_BATCH_SIZE` | Embedding 批处理大小 | `25` |
| `KNOWLEDGE_BASE_PATH` | 知识库目录路径 | `./knowledge` |
| `DINGTALK_ACCESS_TOKEN` | 钉钉文档 API Token | （可选） |
| `DINGTALK_DOC_IDS` | 钉钉文档 ID（逗号分隔） | （可选） |
| `PORT` | 服务端口 | `3000` |
| `LOG_LEVEL` | 日志级别 | `info` |

## NPM Scripts

| 命令 | 说明 |
|------|------|
| `npm start` | 启动服务（ts-node 直运，无需编译） |
| `npm run build` | TypeScript 编译 |
| `npm test` | 运行测试（含覆盖率） |
| `npm run eval` | 运行 RAG 检索评测 |
| `npm run eval:export` | 导出评测 entry 清单 |
| `npm run eval:check` | 自检评测集完整性 |

## 适用场景

- **海外仓退件管理**：退件入库、质检、组包、出库全流程问答
- **质检标准查询**：良残判定标准、拍照要求、赔付规则
- **销毁作业指导**：免质检销毁、质检次品销毁、超时销毁流程
- **RMS 系统操作**：系统操作步骤、界面说明
- **异常处理方案**：各类异常场景的处理指引

## License

MIT
