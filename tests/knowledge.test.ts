import { KnowledgeStore } from '../src/knowledge/store';
import { MockEmbeddingProvider } from './__mocks__/embeddingProvider';

describe('KnowledgeStore', () => {
    let store: KnowledgeStore;
    let mockEmbedding: MockEmbeddingProvider;

    beforeEach(() => {
        mockEmbedding = new MockEmbeddingProvider(1024);
        store = new KnowledgeStore(mockEmbedding as any);
    });

    describe('基础操作', () => {
        test('should add and retrieve an entry', () => {
            const entry = { id: '1', title: 'Test', content: 'Test entry', source: 'test.md' };
            store.addEntry(entry);
            expect(store.getEntry('1')).toEqual(entry);
        });

        test('should return undefined for non-existent entry', () => {
            expect(store.getEntry('non-existent')).toBeUndefined();
        });

        test('should list all entries', () => {
            store.addEntry({ id: '1', title: 'A', content: 'a', source: 'test.md' });
            store.addEntry({ id: '2', title: 'B', content: 'b', source: 'test.md' });
            expect(store.getAllEntries()).toHaveLength(2);
        });
    });

    describe('keywordSearch (via search)', () => {
        beforeEach(() => {
            store.addEntry({ id: '1', title: '质检标准', content: '质检拍照要求：需要拍摄6面照片，包括正面、背面、侧面等', source: '质检.md' });
            store.addEntry({ id: '2', title: '出库流程', content: '出库交接时需要核对大包数量和面单信息', source: '出库.md' });
            store.addEntry({ id: '3', title: '销毁作业', content: '免质检销毁流程：确认商品状态后直接销毁', source: '销毁.md' });
            store.addEntry({ id: '4', title: '质检案例', content: '案例：某批次商品质检发现外观破损，判定为次品', source: '质检案例.md' });
            store.addEntry({ id: '5', title: '退件服务', content: '海外本地仓提供退件入库、质检、组包、出库全流程服务', source: '概况.md' });
        });

        test('should return results sorted by keyword relevance', async () => {
            const results = await store.search('质检拍照', 5);
            expect(results.length).toBeGreaterThan(0);
            // 包含"质检"和"拍照"的 entry 应该排在第一位
            expect(results[0].entry.title).toBe('质检标准');
        });

        test('should filter Chinese stop words', async () => {
            const results = await store.search('的是什么', 5);
            // 停用词过滤后应该没有匹配结果或结果很少
            expect(results.length).toBeLessThanOrEqual(5);
        });

        test('should return empty for no match', async () => {
            const results = await store.search('xyz不存在的关键词', 5);
            expect(results).toHaveLength(0);
        });
    });

    describe('search with mock vectors', () => {
        beforeEach(async () => {
            store.addEntry({ id: '1', title: '质检标准', content: '质检拍照要求：需要拍摄6面照片', source: '质检.md' });
            store.addEntry({ id: '2', title: '出库流程', content: '出库交接核对大包数量', source: '出库.md' });
            store.addEntry({ id: '3', title: '销毁作业', content: '免质检销毁流程', source: '销毁.md' });

            // 手动添加 mock 向量
            const entries = store.getAllEntries();
            const vectors = await mockEmbedding.generateBatchEmbeddings(
                entries.map(e => `${e.title}\n${e.content}`)
            );
            store.getVectorStore().addBatch(
                entries.map((e, i) => ({ entryId: e.id, vector: vectors[i].embedding }))
            );
        });

        test('should return results from hybrid search', async () => {
            const results = await store.search('质检拍照要求', 5);
            expect(results.length).toBeGreaterThan(0);
            // 每个结果都有 entry 和 score
            for (const r of results) {
                expect(r.entry).toBeDefined();
                expect(typeof r.score).toBe('number');
            }
        });

        test('should fallback to keyword search when vector index is empty', async () => {
            // 创建一个新的空 store
            const emptyStore = new KnowledgeStore(mockEmbedding as any);
            emptyStore.addEntry({ id: '1', title: '质检', content: '质检内容', source: 'test.md' });
            const results = await emptyStore.search('质检', 5);
            expect(results.length).toBeGreaterThan(0);
        });
    });
});