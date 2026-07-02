import OpenAI from 'openai';
import { KnowledgeStore } from '../knowledge/store';
import { EmbeddingProvider } from '../connectors/embeddingProvider';
import { QueryResponse, ChatMessage } from '../types';
import { logInfo, logError, logWarn } from '../utils/logger';

const SYSTEM_PROMPT = `你是AE逆向消退智能助手，根据知识库内容回答关于海外本地仓逆向物流的问题。

回答要求：
1. **结构化输出**：使用清晰的层级结构
   - 用 **加粗** 标注关键信息
   - 用编号列表（1. 2. 3.）展示步骤或要点
   - 用无序列表（-）展示并列信息
   - 适当使用表格对比不同情况
2. **简洁直接**：先给结论，再给细节，每条要点不超过一句话
3. **基于知识库**：综合多个信息片段给出有价值的回答
4. **合理推理**：如果知识库中没有直接答案，但有相关信息可以推导出结论，请进行合理推理并明确标注"基于已有信息推理"
5. **诚实回答**：只有完全无法从知识库中获取任何相关信息时，才说"知识库中未找到相关信息"
6. **不重复问题**：直接回答，不要重复用户的问题
7. **严禁编造**：只使用知识库中明确提到的信息，不要编造具体的系统名称、API、时间、数字等细节。如果知识库没有提到，就说"知识库中未提及"
8. **使用专业术语**：保持业务术语的准确性，如"质检"、"销毁"、"退国内"、"退香港"等
9. **禁止总结性段落**：不要在回答末尾或段落中添加"关键逻辑"、"注意"、"总结"、"提示"等总结性 blockquote 段落，直接给出事实即可`;

export class Agent {
    private knowledgeStore: KnowledgeStore;
    private llmClient: OpenAI;
    private model: string;
    private modelFallbacks: string[];
    private currentModelIndex: number = 0;

    constructor(apiKey?: string, model?: string) {
        const embeddingProvider = new EmbeddingProvider(apiKey);
        this.knowledgeStore = new KnowledgeStore(embeddingProvider);
        this.model = model || process.env.LLM_MODEL || 'qwen-plus';

        // 解析降级模型列表
        const fallbackStr = process.env.LLM_MODEL_FALLBACK || 'qwen-turbo,qwen-long';
        this.modelFallbacks = fallbackStr.split(',').map(m => m.trim()).filter(m => m);

        this.llmClient = new OpenAI({
            apiKey: apiKey || process.env.DASHSCOPE_API_KEY,
            baseURL: process.env.API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        });
    }

    /**
     * 切换到下一个备用模型
     */
    private switchToNextModel(): boolean {
        if (this.currentModelIndex < this.modelFallbacks.length) {
            const oldModel = this.model;
            this.model = this.modelFallbacks[this.currentModelIndex];
            this.currentModelIndex++;
            logWarn(`模型切换: ${oldModel} -> ${this.model} (原因: 额度不足)`);
            return true;
        }
        logError('所有模型额度均已用完，无法继续调用');
        return false;
    }

    getKnowledgeStore(): KnowledgeStore {
        return this.knowledgeStore;
    }

    async initialize(): Promise<void> {
        logInfo('Initializing agent and building knowledge index...');
        await this.knowledgeStore.buildIndex();
        logInfo('Agent initialization complete');
    }

    /**
     * 上下文增强：将追问改写为独立完整的问题，提升检索精度
     */
    private async contextualizeQuery(query: string, history?: ChatMessage[]): Promise<string> {
        if (!history || history.length === 0) {
            return query;
        }

        // 取最近 3 轮（6 条）历史
        const recentHistory = history.slice(-6);
        const historyText = recentHistory
            .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}：${msg.content}`)
            .join('\n');

        const rewritePrompt = `根据对话历史，将用户的最新问题改写为一个独立、完整、可直接检索的问题。只输出改写后的问题。

对话历史：
${historyText}

用户最新问题：${query}

改写后的独立问题：`;

        try {
            // 3 秒超时
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Contextualize timeout')), 3000);
            });

            const rewritePromise = this.llmClient.chat.completions.create({
                model: this.model,
                messages: [{ role: 'user', content: rewritePrompt }],
                temperature: 0.3,
                max_tokens: 200,
            });

            const response = await Promise.race([rewritePromise, timeoutPromise]);
            const rewritten = response.choices[0]?.message?.content?.trim();

            if (rewritten && rewritten.length > 0) {
                logInfo(`Query rewritten: "${query}" → "${rewritten}"`);
                return rewritten;
            }
        } catch (error) {
            logWarn(`Contextualize failed, using original query: ${error}`);
        }

        return query;
    }

    /**
     * 流式处理查询，通过回调逐块返回内容
     */
    async processQueryStream(
        query: string,
        onChunk: (chunk: string) => void,
        onSources: (sources: Array<{ title: string; score: number }>) => void,
        onDone: () => void,
        onError: (error: string) => void,
        history?: ChatMessage[]
    ): Promise<void> {
        try {
            logInfo(`Processing stream query: "${query.substring(0, 80)}..."`);

            // 上下文增强：改写追问为独立问题
            const searchQuery = await this.contextualizeQuery(query, history);
            const searchResults = await this.knowledgeStore.search(searchQuery, 5);

            if (searchResults.length === 0) {
                onChunk('抱歉，知识库中未找到与您问题相关的信息。请尝试换一种方式提问。');
                onSources([]);
                onDone();
                return;
            }

            // 先发送来源信息
            const sources = searchResults.map((result) => ({
                title: result.entry.source || result.entry.title,
                score: Math.round(result.score * 1000) / 1000,
            }));
            onSources(sources);

            const context = searchResults
                .map((result, index) => `[来源${index + 1}: ${result.entry.source}]\n${result.entry.content}`)
                .join('\n\n---\n\n');

            // 构建消息列表：system → 历史消息(最近5轮) → 当前带检索上下文的用户问题
            const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
                { role: 'system', content: SYSTEM_PROMPT },
            ];

            if (history && history.length > 0) {
                const recentHistory = history.slice(-10); // 最多保留最近5轮(10条)
                for (const message of recentHistory) {
                    messages.push({ role: message.role, content: message.content });
                }
            }

            messages.push({
                role: 'user',
                content: `以下是从知识库中检索到的相关内容：\n\n${context}\n\n---\n\n用户问题：${query}`,
            });

            const stream = await this.llmClient.chat.completions.create({
                model: this.model,
                messages,
                temperature: 0.3,
                max_tokens: 4096,
                stream: true,
            });

            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                    onChunk(content);
                }
            }

            logInfo(`Stream query completed, found ${sources.length} sources`);
            onDone();
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            
            // 检查是否是额度不足错误
            if (errorMsg.includes('quota') || errorMsg.includes('余额') || errorMsg.includes('额度')) {
                logWarn(`检测到额度不足: ${errorMsg}`);
                // 尝试切换到备用模型
                if (this.switchToNextModel()) {
                    logInfo(`使用备用模型 ${this.model} 重新尝试...`);
                    // 递归调用自身重试
                    await this.processQueryStream(query, onChunk, onSources, onDone, onError, history);
                    return;
                }
            }
            
            logError(`Stream query failed: ${errorMsg}`);
            onError(errorMsg);
        }
    }

    /**
     * 非流式处理（保留兼容）
     */
    async processQuery(query: string): Promise<QueryResponse> {
        return new Promise((resolve) => {
            let answer = '';
            let sources: Array<{ title: string; score: number }> = [];

            this.processQueryStream(
                query,
                (chunk) => { answer += chunk; },
                (s) => { sources = s; },
                () => { resolve({ success: true, answer, sources }); },
                (error) => { resolve({ success: false, message: error }); }
            );
        });
    }
}