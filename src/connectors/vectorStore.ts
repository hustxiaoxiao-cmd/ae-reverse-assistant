import { VectorSearchResult } from '../types';
import { logInfo } from '../utils/logger';

interface StoredVector {
    entryId: string;
    vector: number[];
}

export class VectorStore {
    private vectors: StoredVector[] = [];

    addBatch(entries: Array<{ entryId: string; vector: number[] }>): void {
        for (const entry of entries) {
            this.vectors.push(entry);
        }
        logInfo(`Added ${entries.length} vectors to store. Total: ${this.vectors.length}`);
    }

    search(queryVector: number[], topK: number = 5, threshold: number = 0.0): VectorSearchResult[] {
        const scored: VectorSearchResult[] = [];

        for (const stored of this.vectors) {
            const score = this.cosineSimilarity(queryVector, stored.vector);
            if (score >= threshold) {
                scored.push({ entryId: stored.entryId, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }

    size(): number {
        return this.vectors.length;
    }

    getAllVectors(): StoredVector[] {
        return this.vectors;
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        if (vecA.length !== vecB.length) {
            return 0;
        }

        let dotProduct = 0;
        let magnitudeA = 0;
        let magnitudeB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            magnitudeA += vecA[i] * vecA[i];
            magnitudeB += vecB[i] * vecB[i];
        }

        const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
        if (denominator === 0) {
            return 0;
        }

        return dotProduct / denominator;
    }
}