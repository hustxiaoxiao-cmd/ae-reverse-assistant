/**
 * 评测集脚手架 #2：评测集质量自检
 *
 * 用途：
 *   读取 tests/eval/eval-set.json，校验：
 *     1) 所有 expectedIds 是否真实存在于当前 KnowledgeStore（防 typo / 知识库改动后 id 漂移）
 *     2) 评测题目数量、难度分布、分类分布是否合理
 *     3) 是否有重复 id / 重复 query
 *     4) expectedIds 为空的题目（用于"应返回空"的边界用例）单独标记
 *
 * 使用：
 *   npx ts-node scripts/check-eval-set.ts
 *
 * 退出码：
 *   0 = 全部通过
 *   1 = 存在错误（如 expectedId 不存在、JSON 解析失败）
 *   2 = 仅警告（如分布不均、题目过少）
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from '../src/agent/agent';
import { loadKnowledge } from '../src/knowledge/loader';
import { logInfo, logError, logWarn } from '../src/utils/logger';

dotenv.config();

const EVAL_SET_PATH = path.join(process.cwd(), 'tests', 'eval', 'eval-set.json');

interface EvalCase {
    id: string;
    query: string;
    expectedIds: string[];
    category?: string;
    difficulty?: 'easy' | 'medium' | 'hard';
    notes?: string;
}

interface CheckReport {
    errors: string[];
    warnings: string[];
    stats: {
        total: number;
        byCategory: Record<string, number>;
        byDifficulty: Record<string, number>;
        emptyExpected: number;       // 期望返回空的边界用例数
        avgExpectedSize: number;
    };
}

function readEvalSet(): EvalCase[] {
    if (!fs.existsSync(EVAL_SET_PATH)) {
        logError(`评测集文件不存在: ${EVAL_SET_PATH}`);
        logInfo('请先创建该文件。模板：');
        logInfo('[');
        logInfo('  {');
        logInfo('    "id": "eval-001",');
        logInfo('    "query": "3.5PL退国内的流程",');
        logInfo('    "expectedIds": ["module3_ch1_xxx"],');
        logInfo('    "category": "流程类",');
        logInfo('    "difficulty": "medium"');
        logInfo('  }');
        logInfo(']');
        process.exit(1);
    }
    try {
        const raw = fs.readFileSync(EVAL_SET_PATH, 'utf-8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) {
            logError('eval-set.json 顶层必须是数组');
            process.exit(1);
        }
        return data;
    } catch (error) {
        logError(`解析 eval-set.json 失败: ${error}`);
        process.exit(1);
    }
}

function checkSchema(cases: EvalCase[], report: CheckReport): void {
    const seenIds = new Set<string>();
    const seenQueries = new Set<string>();

    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const prefix = `case[${i}] id=${c.id ?? '(missing)'}`;

        if (!c.id || typeof c.id !== 'string') {
            report.errors.push(`${prefix}: 缺少有效的 id 字段`);
        } else if (seenIds.has(c.id)) {
            report.errors.push(`${prefix}: id 重复`);
        } else {
            seenIds.add(c.id);
        }

        if (!c.query || typeof c.query !== 'string' || c.query.trim().length === 0) {
            report.errors.push(`${prefix}: query 为空`);
        } else if (seenQueries.has(c.query.trim())) {
            report.warnings.push(`${prefix}: query 与其他用例重复 — "${c.query}"`);
        } else {
            seenQueries.add(c.query.trim());
        }

        if (!Array.isArray(c.expectedIds)) {
            report.errors.push(`${prefix}: expectedIds 必须是数组`);
        }

        if (c.difficulty && !['easy', 'medium', 'hard'].includes(c.difficulty)) {
            report.warnings.push(`${prefix}: difficulty="${c.difficulty}" 不在 {easy,medium,hard} 中`);
        }

        if (Array.isArray(c.expectedIds) && c.expectedIds.length > 8) {
            report.warnings.push(`${prefix}: expectedIds 数量 ${c.expectedIds.length} 过多，建议拆题或收敛`);
        }
    }
}

function checkExpectedIdsExist(cases: EvalCase[], validIds: Set<string>, report: CheckReport): void {
    for (const c of cases) {
        if (!Array.isArray(c.expectedIds)) continue;
        for (const eid of c.expectedIds) {
            if (!validIds.has(eid)) {
                report.errors.push(`case ${c.id}: expectedId "${eid}" 不存在于当前知识库`);
            }
        }
    }
}

function computeStats(cases: EvalCase[], report: CheckReport): void {
    const byCategory: Record<string, number> = {};
    const byDifficulty: Record<string, number> = {};
    let totalExpected = 0;
    let emptyExpected = 0;

    for (const c of cases) {
        const cat = c.category || '(uncategorized)';
        byCategory[cat] = (byCategory[cat] || 0) + 1;

        const diff = c.difficulty || '(unspecified)';
        byDifficulty[diff] = (byDifficulty[diff] || 0) + 1;

        if (Array.isArray(c.expectedIds)) {
            totalExpected += c.expectedIds.length;
            if (c.expectedIds.length === 0) emptyExpected++;
        }
    }

    report.stats = {
        total: cases.length,
        byCategory,
        byDifficulty,
        emptyExpected,
        avgExpectedSize: cases.length > 0 ? totalExpected / cases.length : 0,
    };

    if (cases.length < 20) {
        report.warnings.push(`评测集仅 ${cases.length} 题，建议至少 30 题以获得稳定 recall 估计`);
    }
    // 难度分布建议：easy:medium:hard 大致 3:5:2
    const easy = byDifficulty['easy'] || 0;
    const hard = byDifficulty['hard'] || 0;
    if (cases.length >= 20 && easy / cases.length > 0.6) {
        report.warnings.push(`easy 题占比 ${((easy / cases.length) * 100).toFixed(0)}% 过高，建议增加 medium/hard`);
    }
    if (cases.length >= 20 && hard / cases.length < 0.1) {
        report.warnings.push(`hard 题占比 ${((hard / cases.length) * 100).toFixed(0)}% 过低，建议补充跨模块综合题`);
    }
}

function printReport(report: CheckReport): void {
    logInfo('\n=== 评测集统计 ===');
    logInfo(`总题数: ${report.stats.total}`);
    logInfo(`平均 expectedIds 个数: ${report.stats.avgExpectedSize.toFixed(2)}`);
    logInfo(`边界用例(expectedIds=[]): ${report.stats.emptyExpected}`);
    logInfo('\n按分类:');
    for (const [cat, n] of Object.entries(report.stats.byCategory)) {
        logInfo(`  ${cat}: ${n}`);
    }
    logInfo('\n按难度:');
    for (const [diff, n] of Object.entries(report.stats.byDifficulty)) {
        logInfo(`  ${diff}: ${n}`);
    }

    if (report.warnings.length > 0) {
        logWarn(`\n=== 警告 (${report.warnings.length}) ===`);
        for (const w of report.warnings) logWarn(`  ⚠ ${w}`);
    }

    if (report.errors.length > 0) {
        logError(`\n=== 错误 (${report.errors.length}) ===`);
        for (const e of report.errors) logError(`  ✗ ${e}`);
    } else {
        logInfo('\n✓ 无错误');
    }
}

async function main(): Promise<void> {
    const report: CheckReport = {
        errors: [],
        warnings: [],
        stats: { total: 0, byCategory: {}, byDifficulty: {}, emptyExpected: 0, avgExpectedSize: 0 },
    };

    const cases = readEvalSet();
    logInfo(`读取到 ${cases.length} 条评测用例`);

    // schema 检查
    checkSchema(cases, report);

    // 装载知识库，校验 expectedIds 真实性
    logInfo('加载知识库以校验 expectedIds 真实性…');
    const agent = new Agent();
    await agent.initialize();
    await loadKnowledge(agent.getKnowledgeStore());
    const validIds = new Set(agent.getKnowledgeStore().getAllEntries().map((e) => e.id));
    logInfo(`知识库当前共 ${validIds.size} 条 entry`);

    checkExpectedIdsExist(cases, validIds, report);
    computeStats(cases, report);
    printReport(report);

    if (report.errors.length > 0) process.exit(1);
    if (report.warnings.length > 0) process.exit(2);
    process.exit(0);
}

main().catch((error) => {
    logError(`自检失败: ${error?.stack || error}`);
    process.exit(1);
});
