import { KnowledgeEntry, VectorSearchResult } from '../types';
import { VectorStore } from '../connectors/vectorStore';
import { EmbeddingProvider } from '../connectors/embeddingProvider';
import { logInfo, logError, logWarn } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export class KnowledgeStore {
    private entries: Map<string, KnowledgeEntry> = new Map();
    private vectorStore: VectorStore = new VectorStore();
    private embeddingProvider: EmbeddingProvider;
    private cacheFilePath: string;
    private cachedTestDimension: number | null = null;

    constructor(embeddingProvider: EmbeddingProvider, cacheFilePath?: string) {
        this.embeddingProvider = embeddingProvider;
        this.cacheFilePath = cacheFilePath || path.join(process.cwd(), '.cache', 'vector-index.json');
    }

    getVectorStore(): VectorStore {
        return this.vectorStore;
    }

    addEntry(entry: KnowledgeEntry): void {
        this.entries.set(entry.id, entry);
    }

    getEntry(id: string): KnowledgeEntry | undefined {
        return this.entries.get(id);
    }

    getAllEntries(): KnowledgeEntry[] {
        return Array.from(this.entries.values());
    }

    size(): number {
        return this.entries.size;
    }

    /**
     * 计算知识库内容的哈希值，用于判断缓存是否有效
     */
    private computeContentHash(): string {
        const allEntries = this.getAllEntries();
        const contentString = allEntries
            .map((entry) => `${entry.id}:${entry.title}:${entry.content}`)
            .sort()
            .join('|');
        return crypto.createHash('md5').update(contentString).digest('hex');
    }

    /**
     * 尝试从本地缓存加载向量索引
     * @returns 是否成功加载缓存
     */
    private async loadFromCache(): Promise<boolean> {
        try {
            if (!fs.existsSync(this.cacheFilePath)) {
                logInfo('No cache file found');
                return false;
            }

            const cacheData = JSON.parse(fs.readFileSync(this.cacheFilePath, 'utf-8'));
            const currentHash = this.computeContentHash();

            if (cacheData.contentHash !== currentHash) {
                logInfo('Cache hash mismatch, cache is outdated');
                return false;
            }

            if (!cacheData.vectors || cacheData.vectors.length === 0) {
                logInfo('Cache file is empty');
                return false;
            }

            // 向量维度校验：防止模型升级（如 v1→v3）后加载不兼容的旧缓存
            const cachedDimension = cacheData.vectors[0].vector.length;
            const expectedDimension = await this.getTestEmbeddingDimension();
            if (cachedDimension !== expectedDimension) {
                logWarn(`Cache vector dimension mismatch: cached=${cachedDimension}, expected=${expectedDimension}. Cache invalidated, will rebuild.`);
                return false;
            }

            // 加载缓存的向量数据
            this.vectorStore.addBatch(cacheData.vectors);
            logInfo(`Loaded ${cacheData.vectors.length} vectors from cache`);
            return true;
        } catch (error) {
            logWarn(`Failed to load cache: ${error}`);
            return false;
        }
    }

    /**
     * 保存向量索引到本地缓存
     */
    private saveToCache(): void {
        try {
            const cacheDir = path.dirname(this.cacheFilePath);
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }

            const cacheData = {
                contentHash: this.computeContentHash(),
                vectors: this.vectorStore.getAllVectors(),
                savedAt: new Date().toISOString(),
            };

            fs.writeFileSync(this.cacheFilePath, JSON.stringify(cacheData), 'utf-8');
            logInfo(`Saved ${cacheData.vectors.length} vectors to cache`);
        } catch (error) {
            logWarn(`Failed to save cache: ${error}`);
        }
    }

    /**
     * 为所有已添加的知识条目生成向量并索引
     */
    async buildIndex(): Promise<void> {
        const allEntries = this.getAllEntries();
        if (allEntries.length === 0) {
            logInfo('No entries to index');
            return;
        }

        // 先尝试从缓存加载
        if (await this.loadFromCache()) {
            logInfo('Using cached vector index, skipping API calls');
            return;
        }

        logInfo(`Building vector index for ${allEntries.length} entries...`);

        // text-embedding-v3 支持 batch size 25，可通过环境变量调整
        const batchSize = parseInt(process.env.EMBEDDING_BATCH_SIZE || '25', 10);
        const batchedVectors: Array<{ entryId: string; vector: number[] }> = [];

        const totalBatches = Math.ceil(allEntries.length / batchSize);
        const batchDelayMs = 3000; // 每批之间间隔 3 秒

        for (let i = 0; i < allEntries.length; i += batchSize) {
            const batch = allEntries.slice(i, i + batchSize);
            const batchIndex = Math.floor(i / batchSize) + 1;
            const texts = batch.map((entry) => `${entry.title}\n${entry.content}`);

            try {
                const embeddings = await this.embeddingProvider.generateBatchEmbeddings(texts);
                for (let j = 0; j < batch.length; j++) {
                    batchedVectors.push({
                        entryId: batch[j].id,
                        vector: embeddings[j].embedding,
                    });
                }
                logInfo(`Indexed batch ${batchIndex}/${totalBatches}`);
            } catch (error) {
                logError(`Failed to index batch starting at ${i}: ${error}`);
            }

            // 非最后一批时添加延迟，避免触发 API 限频
            if (i + batchSize < allEntries.length) {
                logInfo(`Waiting ${batchDelayMs / 1000}s before next batch to respect rate limits...`);
                await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
            }
        }

        this.vectorStore.addBatch(batchedVectors);
        logInfo(`Vector index built. Total vectors: ${this.vectorStore.size()}`);

        // 校验：向量索引为空说明构建失败，不保存空缓存，避免后续启动永远加载空缓存
        if (this.vectorStore.size() === 0) {
            logError('Vector index is empty after build, NOT saving cache. Index build likely failed.');
            return;
        }

        // 构建成功后保存到本地缓存
        this.saveToCache();
    }

    /**
     * 判断向量索引是否就绪（可用于健康检查）
     */
    isIndexReady(): boolean {
        return this.vectorStore.size() > 0;
    }

    /**
     * 获取测试文本的 embedding 维度，结果缓存以避免重复 API 调用
     */
    private async getTestEmbeddingDimension(): Promise<number> {
        if (this.cachedTestDimension !== null) {
            return this.cachedTestDimension;
        }
        try {
            const result = await this.embeddingProvider.generateEmbedding('dimension_check');
            this.cachedTestDimension = result.dimensions;
            logInfo(`Test embedding dimension: ${this.cachedTestDimension}`);
        } catch (error) {
            logWarn(`Failed to get test embedding dimension: ${error}`);
            // 返回当前模型默认维度作为 fallback
            const model = process.env.EMBEDDING_MODEL || 'text-embedding-v3';
            this.cachedTestDimension = model.includes('v3') ? 1024 : 1536;
        }
        return this.cachedTestDimension;
    }

    /**
     * 混合搜索：向量语义检索 + 关键词检索双通道融合
     * 解决长查询语义偏移和纯向量检索遗漏的问题
     */
    async search(query: string, topK: number = 5): Promise<Array<{ entry: KnowledgeEntry; score: number }>> {
        const keywordResults = this.keywordSearch(query, topK);

        // 向量索引为空时直接跳过向量搜索，避免无意义的 API 调用和超时等待
        if (this.vectorStore.size() === 0) {
            logInfo(`Vector index empty, using keyword search only. Results: ${keywordResults.length}`);
            return keywordResults;
        }

        try {
            const queryEmbedding = await this.embeddingProvider.generateEmbedding(query);
            const vectorResults: VectorSearchResult[] = this.vectorStore.search(
                queryEmbedding.embedding,
                topK
            );

            const vectorEntries: Array<{ entry: KnowledgeEntry; score: number }> = [];
            for (const result of vectorResults) {
                const entry = this.entries.get(result.entryId);
                if (entry) {
                    vectorEntries.push({ entry, score: result.score });
                }
            }

            logInfo(`Vector search: ${vectorEntries.length}, Keyword search: ${keywordResults.length}`);

            // 融合两路结果：向量权重 0.6 + 关键词权重 0.4
            return this.mergeResults(vectorEntries, keywordResults, topK);
        } catch (error) {
            logError(`Vector search failed: ${error}, using keyword results only`);
            return keywordResults;
        }
    }

    /**
     * 融合向量和关键词搜索结果，去重并按综合分数排序
     */
    private mergeResults(
        vectorResults: Array<{ entry: KnowledgeEntry; score: number }>,
        keywordResults: Array<{ entry: KnowledgeEntry; score: number }>,
        topK: number
    ): Array<{ entry: KnowledgeEntry; score: number }> {
        const scoreMap = new Map<string, { entry: KnowledgeEntry; score: number }>();

        for (const result of vectorResults) {
            scoreMap.set(result.entry.id, {
                entry: result.entry,
                score: result.score * 0.6,
            });
        }

        for (const result of keywordResults) {
            const existing = scoreMap.get(result.entry.id);
            if (existing) {
                existing.score += result.score * 0.4;
            } else {
                scoreMap.set(result.entry.id, {
                    entry: result.entry,
                    score: result.score * 0.4,
                });
            }
        }

        const merged = Array.from(scoreMap.values());
        merged.sort((a, b) => b.score - a.score);
        return merged.slice(0, topK);
    }

    /**
     * 关键词降级搜索：提取核心词并按命中次数排序
     * 支持中文无空格查询的自动分词
     */
    private keywordSearch(query: string, topK: number): Array<{ entry: KnowledgeEntry; score: number }> {
        // 去除停用词和标点，提取有意义的关键词片段
        const stopWords = new Set(['的', '是', '什么', '怎么', '如何', '哪些', '哪个', '吗', '了', '在', '有', '和', '与', '及', '等', '为', '被', '把', '对', '从', '到', '不', '没', '请', '帮', '我', '一下', '可以']);
        
        // 加载业务术语词典
        let businessTerms: string[] = [];
        try {
            const termsPath = path.join(process.cwd(), 'data', 'business-terms.json');
            if (fs.existsSync(termsPath)) {
                businessTerms = JSON.parse(fs.readFileSync(termsPath, 'utf-8'));
            }
        } catch (e) {
            // 加载失败时使用空数组
        }

        const keywords: string[] = [];
        
        // 第一步：优先匹配业务术语词典
        const matchedTerms: string[] = [];
        for (const term of businessTerms) {
            if (query.includes(term)) {
                matchedTerms.push(term);
                keywords.push(term);
            }
        }

        // 第二步：对未匹配的部分做常规分词
        let processedQuery = query;
        for (const term of matchedTerms) {
            processedQuery = processedQuery.replace(term, ' ');
        }
        
        // 先按标点和空格分割，再对每段做 2-4 字滑动窗口提取候选词
        const rawSegments = processedQuery.replace(/[？?！!。，,\s、]+/g, '|').split('|').filter((segment) => segment.length > 0);
        
        for (const segment of rawSegments) {
            if (stopWords.has(segment)) continue;
            
            if (segment.length <= 4) {
                keywords.push(segment);
            } else {
                // 对长片段做 2-4 字滑动窗口，生成候选关键词
                for (let windowSize = 4; windowSize >= 2; windowSize--) {
                    for (let i = 0; i <= segment.length - windowSize; i++) {
                        const candidate = segment.substring(i, i + windowSize);
                        if (!stopWords.has(candidate)) {
                            keywords.push(candidate);
                        }
                    }
                }
            }
        }

        // 去重并保留较长的词优先
        const uniqueKeywords = [...new Set(keywords)].sort((a, b) => b.length - a.length).slice(0, 15);
        
        if (uniqueKeywords.length === 0) {
            return [];
        }

        logInfo(`Extracted keywords: ${uniqueKeywords.join(', ')}`);

        const scored: Array<{ entry: KnowledgeEntry; score: number }> = [];
        for (const entry of this.entries.values()) {
            const text = `${entry.title} ${entry.content}`;
            let hitCount = 0;
            let matchedKeywordCount = 0;
            
            for (const keyword of uniqueKeywords) {
                if (text.includes(keyword)) {
                    hitCount++;
                    matchedKeywordCount++;
                }
            }
            
            if (matchedKeywordCount > 0) {
                // 分数 = 命中关键词数 / 总关键词数，命中的词越长权重越高
                scored.push({ entry, score: matchedKeywordCount / uniqueKeywords.length });
            }
        }

        scored.sort((a, b) => b.score - a.score);
        const results = scored.slice(0, topK);
        logInfo(`Keyword search returned ${results.length} results`);
        return results;
    }
}