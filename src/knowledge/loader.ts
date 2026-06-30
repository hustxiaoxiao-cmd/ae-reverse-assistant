import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { KnowledgeEntry } from '../types';
import { KnowledgeStore } from './store';
import { logInfo, logError } from '../utils/logger';
import mammoth from 'mammoth';

export interface DingTalkDocConfig {
    accessToken: string;
    docIds: string[];
}

/**
 * 从本地文件加载知识库文档
 * 支持单个文件或整个目录
 * 支持格式：Markdown (.md)、纯文本 (.txt)、PDF (.pdf)、Word (.docx)
 */
export async function loadFromLocalFiles(
    store: KnowledgeStore,
    filePathOrDir: string
): Promise<void> {
    const resolvedPath = path.resolve(filePathOrDir);
    const stat = fs.statSync(resolvedPath);

    if (stat.isDirectory()) {
        const files = fs.readdirSync(resolvedPath).filter(
            (fileName) => /\.(md|txt|pdf|docx)$/i.test(fileName)
        );
        logInfo(`Found ${files.length} document files in directory: ${resolvedPath}`);

        for (const fileName of files) {
            const fullPath = path.join(resolvedPath, fileName);
            await loadSingleFile(store, fullPath);
        }
    } else {
        await loadSingleFile(store, resolvedPath);
    }
}

async function loadSingleFile(store: KnowledgeStore, filePath: string): Promise<void> {
    try {
        const ext = path.extname(filePath).toLowerCase();
        let content = '';
        const rawTitle = path.basename(filePath, ext);

        if (ext === '.pdf') {
            const { pdf: pdfParse } = await import('pdf-parse');
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdfParse(dataBuffer);
            content = pdfData.text;
        } else if (ext === '.docx') {
            const result = await mammoth.extractRawText({ path: filePath });
            content = result.value;
        } else {
            // .md 或 .txt
            content = fs.readFileSync(filePath, 'utf-8');
        }

        // 清理文档噪音
        content = cleanDocumentNoise(content);

        const chunks = splitIntoChunks(content, rawTitle);
        for (const chunk of chunks) {
            // 将文件名作为 source 前缀，格式：文件名 > 面包屑标题
            chunk.source = `${rawTitle} > ${chunk.title}`;
            store.addEntry(chunk);
        }

        logInfo(`Loaded file: ${filePath}, created ${chunks.length} chunks`);
    } catch (error) {
        logError(`Failed to load file ${filePath}: ${error}`);
    }
}

/**
 * 清理文档中对 AI 理解无价值的噪音内容
 */
function cleanDocumentNoise(content: string): string {
    // 1. 清理 Markdown 删除线内容（钉钉文档修订痕迹）
    content = content.replace(/~~[^~]+~~/g, '');

    // 2. 保护单个波浪号（如3~5），避免被误解析
    content = content.replace(/(\d)~(\d)/g, '$1-$2');

    // 3. 智能处理图片：提取图示说明，移除无意义的图片标记
    // 先提取图示说明文字
    content = content.replace(/\*\*图示说明[（(]([^）)]+)[）)]\*\*[：:]?\s*/g, '[图示: $1] ');
    // 移除独立的图片行（![image](url) 后面没有图示说明的）
    content = content.replace(/!\[.*?\]\(.*?\)\s*\n/g, '');
    // 处理行内图片（图片后面紧跟文字的情况）
    content = content.replace(/!\[.*?\]\(.*?\)/g, '');

    // 4. 移除钉钉文档附件引用
    content = content.replace(/\[请至钉钉文档查看附件.*?\]\(.*?\)/g, '');

    // 5. 移除颜色标记语法（如 $\color{#0089FF}{@xxx}$）
    content = content.replace(/\$\\color\{[^}]+\}\{([^}]+)\}\$/g, '$1');

    // 6. 移除版本管理表（通常在文档开头，包含版本号、修改时间等）
    content = content.replace(/\*\*版本管理\*\*\s*\n\|[^]*?\n(?=\n|#)/g, '\n');
    content = content.replace(/\|\s*\*\*版本号\*\*\s*\|[^]*?\n(?=\n[^|]|#)/g, '\n');

    // 7. 清理连续空行
    content = content.replace(/\n{3,}/g, '\n\n');

    return content.trim();
}

/**
 * 将长文档按段落/标题拆分为多个知识条目
 * 每个 chunk 保留完整的标题面包屑上下文（父级标题链）
 * 支持表格保护：表格内容不会被切分，超长表格会注入表头
 */
function splitIntoChunks(content: string, baseTitle: string, maxChunkSize: number = 1000): KnowledgeEntry[] {
    const entries: KnowledgeEntry[] = [];
    const lines = content.split('\n');

    // 维护各级标题栈，用于生成面包屑
    const headingStack: string[] = [cleanBaseTitle(baseTitle)];
    let currentLevel = 0;
    let currentContent: string[] = [];

    // 表格保护状态
    let inTable = false;
    let tableBuffer: string[] = [];
    let tableHeader: string[] = []; // 表头行（前两行：表头 + 分隔行）
    let noPipeCount = 0; // 连续不含 | 开头的行数

    const isTableSeparator = (line: string): boolean => {
        return /^\|[\s\-:|]+\|$/.test(line.trim());
    };

    const isTableStart = (line: string, nextLine: string | undefined): boolean => {
        return line.includes('|') && nextLine !== undefined && isTableSeparator(nextLine);
    };

    const isTableRow = (line: string): boolean => {
        return line.trim().startsWith('|');
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
        const headingMatch = line.match(/^(#{1,3})\s+(.+)/);

        // 检测表格开始
        if (!inTable && isTableStart(line, nextLine)) {
            inTable = true;
            tableBuffer = [line];
            tableHeader = [line, nextLine!]; // 保存表头
            noPipeCount = 0;
            i++; // 跳过分隔行
            continue;
        }

        // 处理表格内部行
        if (inTable) {
            if (isTableRow(line)) {
                tableBuffer.push(line);
                noPipeCount = 0;
            } else {
                noPipeCount++;
                // 连续两行不含 | 开头，表格结束
                if (noPipeCount >= 2) {
                    inTable = false;
                    // 将表格作为一个完整 chunk 输出
                    const tableText = tableBuffer.join('\n').trim();
                    if (tableText.length > 0) {
                        pushTableChunks(entries, headingStack, tableText, tableHeader, baseTitle, maxChunkSize);
                    }
                    tableBuffer = [];
                    tableHeader = [];
                    // 当前行不是表格行，需要正常处理
                    if (headingMatch) {
                        // 遇到标题，先保存之前的内容
                        if (currentContent.length > 0) {
                            const chunkText = currentContent.join('\n').trim();
                            if (chunkText.length > 0) {
                                pushChunks(entries, headingStack, chunkText, baseTitle, maxChunkSize);
                            }
                            currentContent = [];
                        }
                        const level = headingMatch[1].length;
                        const title = headingMatch[2].trim();
                        while (headingStack.length > level) {
                            headingStack.pop();
                        }
                        while (headingStack.length < level) {
                            headingStack.push('');
                        }
                        headingStack.push(title);
                        currentLevel = level;
                    } else {
                        currentContent.push(line);
                    }
                } else {
                    tableBuffer.push(line);
                }
            }
            continue;
        }

        // 正常处理非表格行
        if (headingMatch) {
            if (currentContent.length > 0) {
                const chunkText = currentContent.join('\n').trim();
                if (chunkText.length > 0) {
                    pushChunks(entries, headingStack, chunkText, baseTitle, maxChunkSize);
                }
                currentContent = [];
            }

            const level = headingMatch[1].length;
            const title = headingMatch[2].trim();

            while (headingStack.length > level) {
                headingStack.pop();
            }
            while (headingStack.length < level) {
                headingStack.push('');
            }
            headingStack.push(title);
            currentLevel = level;
        } else {
            currentContent.push(line);
        }
    }

    // 处理表格未结束的情况
    if (inTable && tableBuffer.length > 0) {
        const tableText = tableBuffer.join('\n').trim();
        if (tableText.length > 0) {
            pushTableChunks(entries, headingStack, tableText, tableHeader, baseTitle, maxChunkSize);
        }
    }

    // 处理最后一段内容
    if (currentContent.length > 0) {
        const chunkText = currentContent.join('\n').trim();
        if (chunkText.length > 0) {
            pushChunks(entries, headingStack, chunkText, baseTitle, maxChunkSize);
        }
    }

    // 如果没有检测到任何标题分段，整体作为一个条目
    if (entries.length === 0 && content.trim()) {
        entries.push({
            id: uuidv4(),
            title: cleanBaseTitle(baseTitle),
            content: content.trim(),
            source: baseTitle,
        });
    }

    return entries;
}

/**
 * 清理文件名中的前缀（如"【AI知识库】"）
 */
function cleanBaseTitle(title: string): string {
    return title.replace(/^【[^】]+】/, '').trim();
}

/**
 * 从标题栈生成面包屑标题，如 "海外本地仓SOP > 质检 > 拍照要求"
 */
function buildBreadcrumbTitle(headingStack: string[]): string {
    return headingStack.filter((heading) => heading.length > 0).join(' > ');
}

/**
 * 将文本内容按大小切分并推入 entries，每个 chunk 都带完整面包屑标题
 */
function pushChunks(
    entries: KnowledgeEntry[],
    headingStack: string[],
    text: string,
    source: string,
    maxChunkSize: number
): void {
    const breadcrumb = buildBreadcrumbTitle(headingStack);

    // 在 chunk 正文开头注入面包屑上下文，帮助 AI 理解这段内容属于哪个环节
    let contextPrefix = `[文档: ${cleanBaseTitle(source)} | 章节: ${breadcrumb}]\n`;

    // 如果 chunk 包含图示说明，在面包屑后额外标注
    if (text.includes('[图示:')) {
        contextPrefix = `[文档: ${cleanBaseTitle(source)} | 章节: ${breadcrumb}（含流程图说明）]\n`;
    }

    if (text.length <= maxChunkSize) {
        entries.push({
            id: uuidv4(),
            title: breadcrumb,
            content: contextPrefix + text,
            source,
        });
    } else {
        const subChunks = splitBySentence(text, maxChunkSize);
        for (let i = 0; i < subChunks.length; i++) {
            entries.push({
                id: uuidv4(),
                title: `${breadcrumb} (part ${i + 1})`,
                content: contextPrefix + subChunks[i],
                source,
            });
        }
    }
}

/**
 * 处理表格 chunk：表格内容保持完整，超长时按行切分并注入表头
 */
function pushTableChunks(
    entries: KnowledgeEntry[],
    headingStack: string[],
    tableText: string,
    tableHeader: string[],
    source: string,
    maxChunkSize: number
): void {
    const breadcrumb = buildBreadcrumbTitle(headingStack);
    const contextPrefix = `[文档: ${cleanBaseTitle(source)} | 章节: ${breadcrumb}]\n`;

    if (tableText.length <= maxChunkSize) {
        entries.push({
            id: uuidv4(),
            title: breadcrumb,
            content: contextPrefix + tableText,
            source,
        });
    } else {
        // 表格超长，按行切分，每个子 chunk 注入表头
        const tableLines = tableText.split('\n');
        const headerText = tableHeader.join('\n') + '\n';
        const dataLines = tableLines.slice(tableHeader.length); // 跳过表头行

        let currentChunk = headerText;
        let partIndex = 1;

        for (const dataLine of dataLines) {
            if ((currentChunk + dataLine + '\n').length > maxChunkSize && currentChunk !== headerText) {
                entries.push({
                    id: uuidv4(),
                    title: `${breadcrumb} (part ${partIndex})`,
                    content: contextPrefix + currentChunk.trim(),
                    source,
                });
                partIndex++;
                currentChunk = headerText + dataLine + '\n';
            } else {
                currentChunk += dataLine + '\n';
            }
        }

        if (currentChunk.trim().length > 0 && currentChunk !== headerText) {
            entries.push({
                id: uuidv4(),
                title: `${breadcrumb} (part ${partIndex})`,
                content: contextPrefix + currentChunk.trim(),
                source,
            });
        }
    }
}

function splitBySentence(text: string, maxSize: number): string[] {
    const sentences = text.split(/(?<=[。！？.!?\n])/);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const sentence of sentences) {
        if ((currentChunk + sentence).length > maxSize && currentChunk) {
            chunks.push(currentChunk.trim());
            currentChunk = sentence;
        } else {
            currentChunk += sentence;
        }
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

/**
 * 从钉钉文档 API 加载知识库（需要配置 access token）
 * 注意：需要先通过钉钉开放平台获取应用凭证和文档权限
 */
export async function loadFromDingTalkApi(
    store: KnowledgeStore,
    config: DingTalkDocConfig
): Promise<void> {
    logInfo(`Loading ${config.docIds.length} documents from DingTalk API`);

    for (const docId of config.docIds) {
        try {
            const content = await fetchDingTalkDocument(docId, config.accessToken);
            const entry: KnowledgeEntry = {
                id: uuidv4(),
                title: `DingTalk Doc ${docId}`,
                content,
                source: `dingtalk:${docId}`,
            };
            store.addEntry(entry);
            logInfo(`Loaded DingTalk document: ${docId}`);
        } catch (error) {
            logError(`Failed to load DingTalk document ${docId}: ${error}`);
        }
    }
}

async function fetchDingTalkDocument(docId: string, accessToken: string): Promise<string> {
    const url = `https://api.dingtalk.com/v1.0/doc/documents/${docId}`;
    const response = await fetch(url, {
        headers: {
            'x-acs-dingtalk-access-token': accessToken,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`DingTalk API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { body?: { content?: string } };
    return data.body?.content || '';
}

/**
 * 统一加载入口：根据环境变量决定加载方式
 */
export async function loadKnowledge(store: KnowledgeStore): Promise<void> {
    const knowledgeBasePath = process.env.KNOWLEDGE_BASE_PATH;
    const dingTalkToken = process.env.DINGTALK_ACCESS_TOKEN;
    const dingTalkDocIds = process.env.DINGTALK_DOC_IDS;

    if (knowledgeBasePath) {
        logInfo(`Loading knowledge from local path: ${knowledgeBasePath}`);
        await loadFromLocalFiles(store, knowledgeBasePath);
    }

    if (dingTalkToken && dingTalkDocIds) {
        const docIds = dingTalkDocIds.split(',').map((id) => id.trim());
        logInfo(`Loading knowledge from DingTalk API: ${docIds.length} documents`);
        await loadFromDingTalkApi(store, { accessToken: dingTalkToken, docIds });
    }

    if (!knowledgeBasePath && !dingTalkToken) {
        logError('No knowledge source configured. Set KNOWLEDGE_BASE_PATH or DINGTALK_ACCESS_TOKEN + DINGTALK_DOC_IDS');
    }

    logInfo(`Knowledge loading complete. Total entries: ${store.size()}`);
}