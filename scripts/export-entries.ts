/**
 * 评测集脚手架 #1：导出所有 KnowledgeEntry 清单
 *
 * 用途：
 *   生成一份 entry 全量清单（markdown + csv），供人工标注 expectedIds 时查阅。
 *   不依赖 embedding API，纯本地操作。
 *
 * 使用：
 *   npx ts-node scripts/export-entries.ts
 *
 * 输出：
 *   tests/eval/entries-catalog.md   — 适合在编辑器/Typora 中浏览
 *   tests/eval/entries-catalog.csv  — 适合在 Excel/飞书表格中筛选
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from '../src/agent/agent';
import { loadKnowledge } from '../src/knowledge/loader';
import { logInfo, logError, logWarn } from '../src/utils/logger';
import { KnowledgeEntry } from '../src/types';

dotenv.config();

const OUTPUT_DIR = path.join(process.cwd(), 'tests', 'eval');
const MD_PATH = path.join(OUTPUT_DIR, 'entries-catalog.md');
const CSV_PATH = path.join(OUTPUT_DIR, 'entries-catalog.csv');

const PREVIEW_CHARS = 120;

/** CSV 转义：双引号需 doubled，含逗号/换行/引号的字段加引号包裹 */
function csvEscape(value: string): string {
    if (value == null) return '';
    const needsQuote = /[",\n\r]/.test(value);
    const escaped = value.replace(/"/g, '""');
    return needsQuote ? `"${escaped}"` : escaped;
}

/** 摘要：保留 title 前若干字 + 内容前若干字，去除多余空白 */
function makePreview(entry: KnowledgeEntry, maxChars: number): string {
    const raw = (entry.content || '').replace(/\s+/g, ' ').trim();
    return raw.length > maxChars ? raw.slice(0, maxChars) + '…' : raw;
}

/** 中文数字到阿拉伯数字的映射，用于章节排序 */
const CN_NUMERALS: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15,
};

/**
 * 推断模块归属：优先从 title 中抽取"一、xxx / 二、xxx"形式的章节
 * （本项目 entry id 是 UUID，不含模块编号，模块信息只在 title 里）
 */
function inferModule(entry: KnowledgeEntry): string {
    const title = entry.title || '';
    // 匹配形如 "一、仓库退件服务概况" 的章节段
    const cnMatch = title.match(/(一|二|三|四|五|六|七|八|九|十一|十二|十三|十四|十五|十)[、\s]([^>>]+?)(?:\s*[>>]|$)/);
    if (cnMatch) {
        return `${cnMatch[1]}、${cnMatch[2].trim()}`;
    }
    // 附录 / 前言之类
    const apxMatch = title.match(/(附录|前言|引言|概述)[：:\s]?([^>>]*)/);
    if (apxMatch) {
        return apxMatch[2] ? `${apxMatch[1]}：${apxMatch[2].trim()}` : apxMatch[1];
    }
    // 兜底
    if (entry.source) return path.basename(entry.source, path.extname(entry.source));
    return 'unknown';
}

/** 模块排序键：中文数字章节按序号排，附录/未知放最后 */
function moduleSortKey(mod: string): [number, string] {
    const m = mod.match(/^(一|二|三|四|五|六|七|八|九|十一|十二|十三|十四|十五|十)、/);
    if (m && CN_NUMERALS[m[1]] !== undefined) return [CN_NUMERALS[m[1]], mod];
    if (mod.startsWith('附录')) return [900, mod];
    if (mod === 'unknown') return [999, mod];
    return [500, mod];
}

function writeMarkdown(entries: KnowledgeEntry[]): void {
    const lines: string[] = [];
    lines.push('# Knowledge Entry Catalog');
    lines.push('');
    lines.push(`> 自动生成于 ${new Date().toISOString()}`);
    lines.push(`> 共 ${entries.length} 条 entry`);
    lines.push('');
    lines.push('标注 expectedIds 时，复制下方 "id" 列的值到 eval-set.json。');
    lines.push('');

    // 按模块分组
    const groups = new Map<string, KnowledgeEntry[]>();
    for (const entry of entries) {
        const mod = inferModule(entry);
        if (!groups.has(mod)) groups.set(mod, []);
        groups.get(mod)!.push(entry);
    }

    const sortedModules = Array.from(groups.keys()).sort((a, b) => {
        const [ka, sa] = moduleSortKey(a);
        const [kb, sb] = moduleSortKey(b);
        if (ka !== kb) return ka - kb;
        return sa.localeCompare(sb, 'zh-CN');
    });
    for (const mod of sortedModules) {
        const list = groups.get(mod)!;
        lines.push(`## 模块: ${mod}  (${list.length} 条)`);
        lines.push('');
        for (const entry of list) {
            lines.push(`### \`${entry.id}\``);
            lines.push(`- **title**: ${entry.title || '(无标题)'}`);
            if (entry.tags && entry.tags.length > 0) {
                lines.push(`- **tags**: ${entry.tags.join(', ')}`);
            }
            if (entry.source) {
                lines.push(`- **source**: ${entry.source}`);
            }
            lines.push(`- **preview**: ${makePreview(entry, PREVIEW_CHARS)}`);
            lines.push('');
        }
    }

    fs.writeFileSync(MD_PATH, lines.join('\n'), 'utf-8');
    logInfo(`Markdown catalog → ${MD_PATH}`);
}

/**
 * 读取旧 csv 的 assigned_to 列（如有），返回 entry.id → assigned_to 映射
 * 用于保留用户已标注的数据，避免重新导出时清空
 */
function loadExistingAssignments(): Map<string, string> {
    const map = new Map<string, string>();
    if (!fs.existsSync(CSV_PATH)) return map;
    try {
        const raw = fs.readFileSync(CSV_PATH, 'utf-8');
        // 去掉 BOM
        const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        const lines = content.split('\n').filter((l) => l.trim().length > 0);
        if (lines.length < 2) return map;

        const header = lines[0].split(',').map((h) => h.trim());
        const idIdx = header.indexOf('id');
        const assignedIdx = header.indexOf('assigned_to');
        if (idIdx === -1 || assignedIdx === -1) return map;

        // 简单 csv 解析（处理引号包裹）
        for (let i = 1; i < lines.length; i++) {
            const fields: string[] = [];
            let current = '';
            let inQuote = false;
            for (const ch of lines[i]) {
                if (ch === '"') {
                    inQuote = !inQuote;
                } else if (ch === ',' && !inQuote) {
                    fields.push(current);
                    current = '';
                } else {
                    current += ch;
                }
            }
            fields.push(current);
            const id = (fields[idIdx] || '').trim();
            const assigned = (fields[assignedIdx] || '').trim();
            if (id && assigned) map.set(id, assigned);
        }
        if (map.size > 0) logInfo(`保留旧 csv 中 ${map.size} 条已标注的 assigned_to`);
    } catch (e) {
        logWarn(`读取旧 csv assigned_to 失败: ${e}`);
    }
    return map;
}

function writeCsv(entries: KnowledgeEntry[]): void {
    const oldAssignments = loadExistingAssignments();
    const rows: string[] = [];
    rows.push(['module', 'id', 'title', 'tags', 'source', 'preview', 'assigned_to'].join(','));
    for (const entry of entries) {
        rows.push(
            [
                csvEscape(inferModule(entry)),
                csvEscape(entry.id),
                csvEscape(entry.title || ''),
                csvEscape((entry.tags || []).join('|')),
                csvEscape(entry.source || ''),
                csvEscape(makePreview(entry, PREVIEW_CHARS)),
                csvEscape(oldAssignments.get(entry.id) || ''),
            ].join(',')
        );
    }
    // UTF-8 BOM：让 Excel 双击打开不乱码
    fs.writeFileSync(CSV_PATH, '\uFEFF' + rows.join('\n'), 'utf-8');
    logInfo(`CSV catalog → ${CSV_PATH}（已保留旧标注 ${oldAssignments.size} 条）`);
}

async function main(): Promise<void> {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    logInfo('加载知识库（跳过向量索引构建以节省时间）…');
    const agent = new Agent();
    // 注意：这里不调用 agent.initialize() 中可能触发的 buildIndex，
    // 仅复用其 KnowledgeStore 实例来承接 loadKnowledge 的 entry 装载。
    await agent.initialize();
    await loadKnowledge(agent.getKnowledgeStore());

    const entries = agent.getKnowledgeStore().getAllEntries();
    if (entries.length === 0) {
        logError('未加载到任何 entry，检查 knowledge/ 目录与 loader.ts');
        process.exit(1);
    }

    logInfo(`共 ${entries.length} 条 entry，开始导出…`);
    writeMarkdown(entries);
    writeCsv(entries);

    // 同时输出一份 id 列表的纯文本，便于做拼写校验
    const idsPath = path.join(OUTPUT_DIR, 'entries-ids.txt');
    fs.writeFileSync(idsPath, entries.map((e) => e.id).join('\n'), 'utf-8');
    logInfo(`ID 列表 → ${idsPath}`);

    logInfo('完成。');
}

main().catch((error) => {
    logError(`导出失败: ${error?.stack || error}`);
    process.exit(1);
});
