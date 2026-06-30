<p align="center">
  <strong>AE Reverse Assistant</strong><br/>
  轻量级 RAG 知识库问答助手 —— 专注AE逆向消退场景
</p>

<p align="center">
  <a href="#快速开始"><img src="https://img.shields.io/badge/npm-start-blue" alt="npm start"></a>
  <a href="#技术栈"><img src="https://img.shields.io/badge/TypeScript-4.5-blue" alt="TypeScript"></a>
  <a href="#功能对比"><img src="https://img.shields.io/badge/RAG-Dual--Channel-green" alt="RAG"></a>
</p>

---

## 项目简介

**AE Reverse Assistant** 是一个基于 RAG（Retrieval-Augmented Generation）架构的轻量级智能问答助手，专为AE逆向消退场景打造，打造逆向物流业务的"超级百科全书"，通过AI Agent解决日常运营中的流程异常与操作答疑，并通过对问题数据的沉淀反哺业务优化。

系统通过整合退件服务、质检标准、销毁作业、RMS 操作等多份业务文档，构建统一知识库，结合**向量语义检索**与**关键词检索**双通道融合，为运营人员提供精准的问答服务。

## 核心特性

- **🎯 RAG 双通道检索**：向量语义检索（权重 0.6）+ 关键词检索（权重 0.4）双通道融合，兼顾语义理解和精确匹配，有效降低大模型幻觉。
- **🧠 智能文档处理**：自动按 Markdown 标题层级切分文档，注入面包屑标题上下文（如 `销毁作业 > 免质检销毁 > 操作流程`），让每个 chunk 都有完整的业务归属。
- **💾 本地向量缓存**：首次构建索引后自动缓存到本地（`data/vector-cache.json`），后续启动秒级加载，零 API 调用。知识库内容变更时自动检测并重建。
- **🔌 多源知识接入**：支持本地 Markdown 文件和钉钉文档 API 两种知识来源，灵活扩展。
- **🛡️ 优雅降级**：向量索引构建失败或 API 限频时，自动降级为关键词搜索模式，服务不中断。
- **📝 业务语义增强**：System Prompt 内置业务概念映射（如"消退=退货"），提升回答的业务准确性。
- **🧹 图片噪音清理**：自动过滤 Markdown 中的图片链接，减少无效 token 消耗。

## 快速开始

```bash
# 1. 克隆仓库
git clone <repository-url>
cd ae-reverse-assistant

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 API Key 和知识库路径

# 4. 启动服务
npm start
```

启动后访问：

| 接口 | 地址 |
|------|------|
| 问答接口 | `POST http://localhost:3000/api/query` |
| 健康检查 | `GET http://localhost:3000/api/health` |

## 技术栈

| 层级 | 技术 |
|------|------|
| **语言** | TypeScript |
| **运行时** | Node.js |
| **Web 框架** | Express |
| **LLM 接入** | OpenAI SDK（兼容 ideaTalk / DashScope） |
| **Embedding 模型** | text-embedding-v1 |
| **LLM 模型** | qwen-plus |
| **向量检索** | 内存余弦相似度 |
| **知识来源** | 本地 Markdown + 钉钉文档 API |

## 功能对比

| 特性 | MaxKB | Dify | Flowise | **本项目** |
|------|:-----:|:----:|:-------:|:---------:|
| RAG 引擎 | ✅ | ✅ | ✅ | ✅ |
| 向量 + 关键词混合检索 | ✅ | ✅ | ❌ | ✅ |
| 本地向量缓存 | ❌ | ❌ | ❌ | ✅ |
| 多源知识接入 | ✅ | ✅ | ✅ | ✅ |
| 自动降级机制 | ❌ | ❌ | ❌ | ✅ |
| 业务概念定制 | ❌ | ❌ | ❌ | ✅ |
| 零代码部署 | ✅ | ✅ | ✅ | ✅ |
| 可视化工作流 | ✅ | ✅ | ✅ | ❌ |
| 多模型切换 | ✅ | ✅ | ✅ | ❌ |
| Web UI | ✅ | ✅ | ✅ | ❌ |

## 项目结构

```
ae-reverse-assistant
├── src/
│   ├── index.ts                    # 入口：启动 Express 服务 + 后台构建索引
│   ├── agent/
│   │   ├── agent.ts                # Agent 核心：System Prompt + 问答编排
│   │   └── planner.ts              # 回答策略规划
│   ├── knowledge/
│   │   ├── loader.ts               # 知识加载：文档解析 + chunk 切分 + 噪音清理
│   │   └── store.ts                # 知识存储：索引构建 + 缓存 + 混合检索
│   ├── connectors/
│   │   ├── embeddingProvider.ts    # Embedding 服务（兼容 ideaTalk / DashScope）
│   │   └── vectorStore.ts          # 向量存储：余弦相似度检索
│   ├── api/
│   │   ├── server.ts               # Express 服务配置
│   │   └── routes.ts               # API 路由定义
│   ├── services/
│   │   ├── queryService.ts         # 查询处理 + 回答格式化
│   │   └── analyticsService.ts     # 问答数据分析
│   ├── utils/
│   │   └── logger.ts               # 日志工具
│   └── types/
│       └── index.ts                # 类型定义
├── knowledge/                       # 知识库文档目录
├── data/                            # 运行时数据（向量缓存、问答记录）
├── .env                             # 环境变量配置
└── package.json
```

## 适用场景

- 🏭 **海外仓退件管理**：退件入库、质检、组包、出库全流程问答
- 🔍 **质检标准查询**：良残判定标准、拍照要求、赔付规则
- 🗑️ **销毁作业指导**：免质检销毁、质检次品销毁、超时销毁流程
- 💻 **RMS 系统操作**：系统操作步骤、界面说明
- 📋 **异常处理方案**：各类异常场景的处理指引

## 环境变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `DASHSCOPE_API_KEY` | ideaTalk / DashScope API Key | `sk-xxx` |
| `API_BASE_URL` | API 基础地址 | `https://idealab.alibaba-inc.com/api/openai/v1` |
| `LLM_MODEL` | LLM 模型名称 | `qwen-plus` |
| `KNOWLEDGE_BASE_PATH` | 知识库目录路径 | `./knowledge` |
| `PORT` | 服务端口 | `3000` |
| `LOG_LEVEL` | 日志级别 | `info` |

## License

MIT