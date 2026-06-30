import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from './agent/agent';
import { loadKnowledge } from './knowledge/loader';
import { setupRoutes } from './api/routes';
import { logInfo, logError } from './utils/logger';

// 同步创建 app 和 agent（FC 运行时 require 时立即可用）
const app = express();
const port = process.env.PORT || 3000;
const agent = new Agent();

// 同步注册路由
setupRoutes(app, agent);

// 本地开发：启动 HTTP 服务
if (!process.env.FC_FUNC_CODE_PATH) {
    app.listen(port, () => {
        logInfo(`AE逆向消退智能助手已启动: http://localhost:${port}`);
        logInfo(`问答接口: POST http://localhost:${port}/api/query`);
        logInfo(`健康检查: GET http://localhost:${port}/api/health`);
    });
} else {
    logInfo('Running in FC environment, skipping app.listen()');
}

// 后台异步：加载知识库 + 构建向量索引（不阻塞 app 导出）
logInfo('Loading knowledge base in background...');
loadKnowledge(agent.getKnowledgeStore()).then(() => {
    logInfo('Knowledge base loaded.');
    logInfo('Building vector index in background...');
    return agent.initialize();
}).then(() => {
    logInfo('Vector index build completed.');
}).catch((error) => {
    logError(`Background init failed: ${error}. Keyword search is still available.`);
    try {
        const errorLogPath = path.join(process.cwd(), 'data', 'index-error.log');
        const errorDir = path.dirname(errorLogPath);
        if (!fs.existsSync(errorDir)) {
            fs.mkdirSync(errorDir, { recursive: true });
        }
        fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] ${error}\n`);
    } catch (writeError) {
        logError(`Failed to write index error log: ${writeError}`);
    }
});

// 导出 app（FC 运行时通过 require 直接获取）
export { app };
