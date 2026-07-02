import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from './agent/agent';
import { loadKnowledge } from './knowledge/loader';
import { setupRoutes } from './api/routes';
import { logInfo, logError } from './utils/logger';

async function main(): Promise<void> {
    const app = express();
    const port = process.env.PORT || 3000;

    const agent = new Agent();

    try {
        // 1. 加载知识库文档
        logInfo('Loading knowledge base...');
        await loadKnowledge(agent.getKnowledgeStore());

        // 2. 设置 API 路由并先启动服务（不等索引完成）
        setupRoutes(app, agent);

        app.listen(port, () => {
            logInfo(`AE逆向消退智能助手已启动: http://localhost:${port}`);
            logInfo(`问答接口: POST http://localhost:${port}/api/query`);
            logInfo(`健康检查: GET http://localhost:${port}/api/health`);
        });

        // 3. 后台异步构建向量索引（不阻塞 HTTP 服务）
        logInfo('Building vector index in background...');
        agent.initialize().then(() => {
            logInfo('Vector index build completed.');
        }).catch((error) => {
            logError(`Vector index build failed: ${error}. Keyword search is still available.`);
            // 将错误写入状态文件，方便排查
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
    } catch (error) {
        logError(`Failed to start agent: ${error}`);
        process.exit(1);
    }
}

main();
