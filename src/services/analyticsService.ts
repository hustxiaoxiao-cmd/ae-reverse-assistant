import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logError } from '../utils/logger';

const DATA_DIR = path.join(__dirname, '../../data');
const QUERIES_FILE = path.join(DATA_DIR, 'queries.json');
const FEEDBACKS_FILE = path.join(DATA_DIR, 'feedbacks.json');

export interface QueryRecord {
    query: string;
    answer: string;
    timestamp: number;
    date: string; // YYYY-MM-DD
}

export interface FeedbackRecord {
    query: string;
    answer: string;
    type: 'up' | 'down';
    reason?: string;
    timestamp: number;
    date: string;
}

export interface DailyStats {
    date: string;
    totalQueries: number;
    positiveCount: number;
    negativeCount: number;
}

export interface FrequentQuestion {
    query: string;
    count: number;
    lastAsked: string;
}

export class AnalyticsService {
    constructor() {
        this.ensureDataDir();
    }

    private ensureDataDir(): void {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            logInfo('Created data directory');
        }
        if (!fs.existsSync(QUERIES_FILE)) fs.writeFileSync(QUERIES_FILE, '[]');
        if (!fs.existsSync(FEEDBACKS_FILE)) fs.writeFileSync(FEEDBACKS_FILE, '[]');
    }

    private readJson<T>(filePath: string): T[] {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content);
        } catch {
            return [];
        }
    }

    private writeJson<T>(filePath: string, data: T[]): void {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }

    /** 记录一次用户提问 */
    recordQuery(query: string, answer: string): void {
        try {
            const records = this.readJson<QueryRecord>(QUERIES_FILE);
            const now = new Date();
            records.push({
                query,
                answer: answer.substring(0, 500), // 截断过长回答
                timestamp: now.getTime(),
                date: this.formatDate(now),
            });
            this.writeJson(QUERIES_FILE, records);
        } catch (error) {
            logError(`Failed to record query: ${error}`);
        }
    }

    /** 记录用户反馈 */
    recordFeedback(query: string, answer: string, type: 'up' | 'down', reason?: string): void {
        try {
            const records = this.readJson<FeedbackRecord>(FEEDBACKS_FILE);
            const now = new Date();
            records.push({
                query,
                answer: answer.substring(0, 500),
                type,
                reason,
                timestamp: now.getTime(),
                date: this.formatDate(now),
            });
            this.writeJson(FEEDBACKS_FILE, records);
            logInfo(`Feedback recorded: ${type}${reason ? ' - ' + reason : ''}`);
        } catch (error) {
            logError(`Failed to record feedback: ${error}`);
        }
    }

    /** 获取高频问题 TOP N */
    getFrequentQuestions(topN: number = 10): FrequentQuestion[] {
        const records = this.readJson<QueryRecord>(QUERIES_FILE);
        const countMap = new Map<string, { count: number; lastAsked: string }>();

        for (const record of records) {
            const normalized = record.query.trim().replace(/[？?。！!，,\s]+$/g, '');
            const existing = countMap.get(normalized);
            if (existing) {
                existing.count++;
                if (record.date > existing.lastAsked) existing.lastAsked = record.date;
            } else {
                countMap.set(normalized, { count: 1, lastAsked: record.date });
            }
        }

        return Array.from(countMap.entries())
            .map(([query, { count, lastAsked }]) => ({ query, count, lastAsked }))
            .sort((a, b) => b.count - a.count)
            .slice(0, topN);
    }

    /** 获取指定日期范围的统计报告 */
    getReport(startDate: string, endDate: string): {
        period: { start: string; end: string };
        summary: { totalQueries: number; uniqueQueries: number; positiveCount: number; negativeCount: number; satisfactionRate: string };
        dailyStats: DailyStats[];
        topQuestions: FrequentQuestion[];
        negativeFeedbacks: FeedbackRecord[];
    } {
        const queries = this.readJson<QueryRecord>(QUERIES_FILE)
            .filter(r => r.date >= startDate && r.date <= endDate);
        const feedbacks = this.readJson<FeedbackRecord>(FEEDBACKS_FILE)
            .filter(r => r.date >= startDate && r.date <= endDate);

        const positiveCount = feedbacks.filter(f => f.type === 'up').length;
        const negativeCount = feedbacks.filter(f => f.type === 'down').length;
        const totalFeedbacks = positiveCount + negativeCount;

        // 每日统计
        const dailyMap = new Map<string, DailyStats>();
        for (const query of queries) {
            const stats = dailyMap.get(query.date) || { date: query.date, totalQueries: 0, positiveCount: 0, negativeCount: 0 };
            stats.totalQueries++;
            dailyMap.set(query.date, stats);
        }
        for (const feedback of feedbacks) {
            const stats = dailyMap.get(feedback.date) || { date: feedback.date, totalQueries: 0, positiveCount: 0, negativeCount: 0 };
            if (feedback.type === 'up') stats.positiveCount++;
            else stats.negativeCount++;
            dailyMap.set(feedback.date, stats);
        }

        // 期间高频问题
        const queryCountMap = new Map<string, { count: number; lastAsked: string }>();
        for (const record of queries) {
            const normalized = record.query.trim().replace(/[？?。！!，,\s]+$/g, '');
            const existing = queryCountMap.get(normalized);
            if (existing) {
                existing.count++;
                if (record.date > existing.lastAsked) existing.lastAsked = record.date;
            } else {
                queryCountMap.set(normalized, { count: 1, lastAsked: record.date });
            }
        }

        const uniqueQueries = new Set(queries.map(q => q.query.trim().replace(/[？?。！!，,\s]+$/g, ''))).size;

        return {
            period: { start: startDate, end: endDate },
            summary: {
                totalQueries: queries.length,
                uniqueQueries,
                positiveCount,
                negativeCount,
                satisfactionRate: totalFeedbacks > 0 ? (positiveCount / totalFeedbacks * 100).toFixed(1) + '%' : '暂无数据',
            },
            dailyStats: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
            topQuestions: Array.from(queryCountMap.entries())
                .map(([query, { count, lastAsked }]) => ({ query, count, lastAsked }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 10),
            negativeFeedbacks: feedbacks.filter(f => f.type === 'down'),
        };
    }

    /** 获取本周报告 */
    getWeeklyReport(): ReturnType<AnalyticsService['getReport']> {
        const now = new Date();
        const dayOfWeek = now.getDay() || 7;
        const monday = new Date(now);
        monday.setDate(now.getDate() - dayOfWeek + 1);
        return this.getReport(this.formatDate(monday), this.formatDate(now));
    }

    /** 获取本月报告 */
    getMonthlyReport(): ReturnType<AnalyticsService['getReport']> {
        const now = new Date();
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        return this.getReport(this.formatDate(firstDay), this.formatDate(now));
    }

    private formatDate(date: Date): string {
        return date.toISOString().split('T')[0];
    }
}
