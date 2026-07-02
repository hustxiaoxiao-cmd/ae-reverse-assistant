import express, { Router, Request, Response as ExpressResponse } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { Agent } from '../agent/agent';
import { QueryService } from '../services/queryService';
import { AnalyticsService } from '../services/analyticsService';
import { QueryRequest } from '../types';
import { logInfo, logError } from '../utils/logger';

export function setupRoutes(app: express.Express, agent: Agent): void {
    const router = Router();
    const queryService = new QueryService(agent);
    const analyticsService = new AnalyticsService();

    // 解析 JSON 请求体
    app.use(express.json());

    // 静态文件服务（前端页面）
    app.use(express.static(path.join(__dirname, '../../public')));

    // SSE 流式查询端点
    router.post('/query/stream', async (req: Request, res: ExpressResponse) => {
        const request: QueryRequest = req.body;
        if (!request.query || !request.query.trim()) {
            res.status(400).json({ success: false, message: '查询内容不能为空' });
            return;
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        let fullAnswer = '';
        try {
            await agent.processQueryStream(
                request.query.trim(),
                (chunk) => {
                    fullAnswer += chunk;
                    res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
                },
                (sources) => {
                    res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);
                },
                () => {
                    analyticsService.recordQuery(request.query.trim(), fullAnswer);
                    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                    res.end();
                },
                (error) => {
                    res.write(`data: ${JSON.stringify({ type: 'error', message: error })}\n\n`);
                    res.end();
                },
                request.history
            );
        } catch (error) {
            logError(`Stream route error: ${error}`);
            res.write(`data: ${JSON.stringify({ type: 'error', message: String(error) })}\n\n`);
            res.end();
        }
    });

    // 非流式查询端点（保留兼容）
    router.post('/query', async (req: Request, res: ExpressResponse) => {
        try {
            const request: QueryRequest = req.body;
            logInfo(`Received query request: ${request.query?.substring(0, 50)}...`);

            const response = await queryService.handleQuery(request);
            res.json(response);
        } catch (error) {
            logError(`Route error: ${error}`);
            res.status(500).json({
                success: false,
                message: '处理请求时发生内部错误',
            });
        }
    });

    router.get('/health', (_req: Request, res: ExpressResponse) => {
        const store = agent.getKnowledgeStore();
        res.json({
            status: 'ok',
            entries: store.size(),
            indexReady: store.isIndexReady(),
        });
    });

    // 回答反馈端点
    router.post('/feedback', (req: Request, res: ExpressResponse) => {
        const { type, query, answer, reason } = req.body;
        analyticsService.recordFeedback(query || '', answer || '', type, reason);
        res.json({ success: true });
    });

    // 统计报表 API
    router.get('/analytics/frequent', (_req: Request, res: ExpressResponse) => {
        const topN = parseInt(_req.query.top as string) || 10;
        res.json({ success: true, data: analyticsService.getFrequentQuestions(topN) });
    });

    // 快捷建议端点：返回高频问题供前端动态生成快捷卡片
    router.get('/analytics/suggestions', (_req: Request, res: ExpressResponse) => {
        const frequent = analyticsService.getFrequentQuestions(6);
        const suggestions = frequent.map((item: { query: string; count: number }) => ({
            query: item.query,
            count: item.count,
        }));
        res.json({ success: true, suggestions });
    });

    router.get('/analytics/weekly', (_req: Request, res: ExpressResponse) => {
        res.json({ success: true, data: analyticsService.getWeeklyReport() });
    });

    router.get('/analytics/monthly', (_req: Request, res: ExpressResponse) => {
        res.json({ success: true, data: analyticsService.getMonthlyReport() });
    });

    router.get('/analytics/report', (req: Request, res: ExpressResponse) => {
        const { start, end } = req.query;
        if (!start || !end) {
            res.status(400).json({ success: false, message: '请提供 start 和 end 日期参数（YYYY-MM-DD）' });
            return;
        }
        res.json({ success: true, data: analyticsService.getReport(start as string, end as string) });
    });

    // 管理员重置接口：清除所有问答记录和反馈数据
    router.post('/admin/reset', (_req: Request, res: ExpressResponse) => {
        try {
            const queriesPath = path.join(__dirname, '../../data/queries.json');
            const feedbacksPath = path.join(__dirname, '../../data/feedbacks.json');
            fs.writeFileSync(queriesPath, '[]', 'utf-8');
            fs.writeFileSync(feedbacksPath, '[]', 'utf-8');
            logInfo('All analytics data has been reset');
            res.json({ success: true, message: '数据已清除' });
        } catch (error) {
            logError(`Reset failed: ${error}`);
            res.status(500).json({ success: false, message: '清除失败' });
        }
    });

    app.use('/api', router);

    // 根路由返回落地页
    app.get('/', (_req: Request, res: ExpressResponse) => {
        res.sendFile(path.join(__dirname, '../../public/landing.html'));
    });

    // 聊天助手页面
    app.get('/chat', (_req: Request, res: ExpressResponse) => {
        res.sendFile(path.join(__dirname, '../../public/index.html'));
    });
}