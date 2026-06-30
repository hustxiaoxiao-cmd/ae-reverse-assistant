import { EmbeddingResult } from '../../src/types';

/**
 * MockEmbeddingProvider: 确定性 mock，相同输入返回相同向量
 * 使用简单 hash 保证测试可重复性
 */
export class MockEmbeddingProvider {
    private dimensions: number;

    constructor(dimensions: number = 1024) {
        this.dimensions = dimensions;
    }

    /**
     * 简单字符串 hash → 固定种子
     */
    private hashString(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash);
    }

    /**
     * 基于种子生成确定性伪随机向量
     */
    private generateDeterministicVector(seed: number): number[] {
        const vector: number[] = [];
        let state = seed;
        for (let i = 0; i < this.dimensions; i++) {
            // 线性同余生成器
            state = (state * 1664525 + 1013904223) & 0xffffffff;
            // 归一化到 [-1, 1]
            vector.push((state / 0x7fffffff) - 1);
        }
        // 归一化向量（单位向量）
        const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
        if (magnitude > 0) {
            for (let i = 0; i < vector.length; i++) {
                vector[i] /= magnitude;
            }
        }
        return vector;
    }

    async generateEmbedding(text: string): Promise<EmbeddingResult> {
        const seed = this.hashString(text);
        return {
            embedding: this.generateDeterministicVector(seed),
            dimensions: this.dimensions,
        };
    }

    async generateBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
        return texts.map((text) => {
            const seed = this.hashString(text);
            return {
                embedding: this.generateDeterministicVector(seed),
                dimensions: this.dimensions,
            };
        });
    }
}
