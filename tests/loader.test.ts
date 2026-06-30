import * as fs from 'fs';
import * as path from 'path';
import { loadFromLocalFiles } from '../src/knowledge/loader';
import { KnowledgeStore } from '../src/knowledge/store';
import { MockEmbeddingProvider } from './__mocks__/embeddingProvider';

describe('Knowledge Loader', () => {
    let store: KnowledgeStore;
    const testDir = path.join(__dirname, 'fixtures');
    const testFile = path.join(testDir, 'test.md');

    beforeEach(() => {
        const mockEmbedding = new MockEmbeddingProvider(1024);
        store = new KnowledgeStore(mockEmbedding as any);
    });

    beforeAll(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }

        const testContent = `# 测试文档

## 第一章
这是第一章的内容，包含质检拍照要求。

## 第二章
这是第二章的内容，关于出库流程。

~~删除线内容~~ 正常内容

![流程图](https://example.com/image.png)
**图示说明（退件流程）：**

| 步骤 | 操作 |
|------|------|
| 1 | 入库 |
| 2 | 质检 |
`;
        fs.writeFileSync(testFile, testContent, 'utf-8');
    });

    afterAll(() => {
        if (fs.existsSync(testFile)) {
            fs.unlinkSync(testFile);
        }
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    describe('loadFromLocalFiles', () => {
        it('should load markdown file', async () => {
            await loadFromLocalFiles(store, testFile);
            expect(store.size()).toBeGreaterThan(0);
        });

        it('should load directory with markdown files', async () => {
            await loadFromLocalFiles(store, testDir);
            expect(store.size()).toBeGreaterThan(0);
        });

        it('should split content into chunks with required fields', async () => {
            await loadFromLocalFiles(store, testFile);
            const entries = store.getAllEntries();
            expect(entries.length).toBeGreaterThan(0);
            for (const entry of entries) {
                expect(entry.id).toBeDefined();
                expect(entry.title).toBeDefined();
                expect(entry.content).toBeDefined();
                expect(entry.source).toBeDefined();
            }
        });
    });

    describe('cleanDocumentNoise', () => {
        it('should remove strikethrough content', async () => {
            const noiseFile = path.join(testDir, 'noise.md');
            fs.writeFileSync(noiseFile, '# 测试\n~~删除的内容~~ 保留的内容', 'utf-8');
            await loadFromLocalFiles(store, noiseFile);
            const entries = store.getAllEntries();
            const content = entries.map(e => e.content).join('');
            expect(content).not.toContain('删除的内容');
            expect(content).toContain('保留的内容');
            fs.unlinkSync(noiseFile);
        });

        it('should extract image description and remove image links', async () => {
            const imgFile = path.join(testDir, 'image.md');
            fs.writeFileSync(imgFile, '# 流程\n![图](https://x.com/a.png)\n\n**图示说明（退件流程）：**\n步骤说明', 'utf-8');
            await loadFromLocalFiles(store, imgFile);
            const entries = store.getAllEntries();
            const content = entries.map(e => e.content).join('');
            // 验证图片链接被移除
            expect(content).not.toContain('![图]');
            expect(content).not.toContain('https://x.com/a.png');
            // 验证内容保留
            expect(content).toContain('步骤说明');
            fs.unlinkSync(imgFile);
        });
    });

    describe('breadcrumb injection', () => {
        it('should inject breadcrumb title into chunk content', async () => {
            await loadFromLocalFiles(store, testFile);
            const entries = store.getAllEntries();
            // 至少有一个 chunk 包含面包屑前缀
            const hasBreadcrumb = entries.some(e => e.content.includes('[文档:'));
            expect(hasBreadcrumb).toBe(true);
        });
    });
});
