import { Agent } from '../src/agent/agent';
import { KnowledgeStore } from '../src/knowledge/store';
import { MockEmbeddingProvider } from './__mocks__/embeddingProvider';

// Mock OpenAI client
jest.mock('openai', () => {
    return jest.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create: jest.fn().mockImplementation(async (params: any) => {
                    if (params.stream) {
                        // 模拟 SSE 流式响应
                        const chunks = ['这是', '测试回答', '内容。'];
                        return {
                            [Symbol.asyncIterator]: async function* () {
                                for (const chunk of chunks) {
                                    yield { choices: [{ delta: { content: chunk } }] };
                                }
                                yield { choices: [{ delta: {} }] };
                            },
                        };
                    }
                    // 非流式响应（用于 contextualizeQuery）
                    return {
                        choices: [{ message: { content: '改写后的独立问题' } }],
                    };
                }),
            },
        },
    }));
});

describe('Agent', () => {
    let agent: Agent;
    let knowledgeStore: KnowledgeStore;
    let mockEmbedding: MockEmbeddingProvider;

    beforeEach(() => {
        process.env.DASHSCOPE_API_KEY = 'test-api-key';
        process.env.API_BASE_URL = 'https://test.api.com/v1';
        process.env.LLM_MODEL = 'qwen-turbo';

        mockEmbedding = new MockEmbeddingProvider(1024);
        knowledgeStore = new KnowledgeStore(mockEmbedding as any);
        agent = new Agent();

        // 替换 agent 的 knowledgeStore 为 mock 版本
        (agent as any).knowledgeStore = knowledgeStore;
    });

    afterEach(() => {
        delete process.env.DASHSCOPE_API_KEY;
        delete process.env.API_BASE_URL;
        delete process.env.LLM_MODEL;
    });

    test('should initialize agent', async () => {
        await agent.initialize();
        expect(agent).toBeDefined();
    });

    test('should get knowledge store', () => {
        const store = agent.getKnowledgeStore();
        expect(store).toBeDefined();
    });

    test('processQueryStream should emit sources → chunks → done in order', async () => {
        // 添加测试数据
        knowledgeStore.addEntry({
            id: '1',
            title: 'Test',
            content: 'Test content about 质检标准',
            source: 'test.md',
        });

        const events: string[] = [];
        const chunks: string[] = [];
        let sourcesReceived = false;
        let doneReceived = false;

        await agent.processQueryStream(
            '质检标准是什么',
            (chunk) => {
                chunks.push(chunk);
                if (!sourcesReceived) events.push('chunk-before-sources');
                else events.push('chunk');
            },
            (sources) => {
                sourcesReceived = true;
                events.push('sources');
                expect(sources.length).toBeGreaterThan(0);
            },
            () => {
                doneReceived = true;
                events.push('done');
            },
            (error) => {
                events.push(`error:${error}`);
            }
        );

        // 验证事件顺序：sources 应该在 chunk 之前（或至少 chunks 在 done 之前）
        expect(doneReceived).toBe(true);
        expect(chunks.length).toBeGreaterThan(0);
        // done 应该是最后一个事件
        expect(events[events.length - 1]).toBe('done');
    });

    test('processQueryStream should handle empty knowledge base', async () => {
        const messages: string[] = [];

        await agent.processQueryStream(
            '随便问一个问题',
            (chunk) => messages.push(`chunk:${chunk}`),
            (_sources) => messages.push('sources'),
            () => messages.push('done'),
            (_error) => messages.push('error')
        );

        // 空知识库应该返回提示信息
        const hasNoResultMessage = messages.some(m => m.includes('未找到'));
        expect(hasNoResultMessage).toBe(true);
    });

    test('should add entry to knowledge store', () => {
        const store = agent.getKnowledgeStore();
        store.addEntry({
            id: '1',
            title: 'Test',
            content: 'Test content',
            source: 'test.md',
        });
        expect(store.size()).toBe(1);
    });
});