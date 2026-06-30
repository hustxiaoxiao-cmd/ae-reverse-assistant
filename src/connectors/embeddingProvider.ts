import { EmbeddingResult } from '../types';
import { logInfo, logError, logWarn } from '../utils/logger';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface EmbeddingApiResponse {
    success?: boolean;
    message?: string;
    data: Array<{ embedding: number[] }>;
}

export class EmbeddingProvider {
    private apiKey: string;
    private baseUrl: string;
    private model: string;
    private maxRetries: number;
    private retryDelayMs: number;

    constructor(apiKey?: string, model?: string) {
        this.apiKey = apiKey || process.env.DASHSCOPE_API_KEY || '';
        this.baseUrl = process.env.API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        this.model = model || process.env.EMBEDDING_MODEL || 'text-embedding-v1';
        this.maxRetries = 3;
        this.retryDelayMs = 8000;
    }

    private async callWithRetry<T>(operation: () => Promise<T>, description: string): Promise<T> {
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logError(`${description} failed: ${errorMessage}`);

                if (attempt < this.maxRetries) {
                    const delay = this.retryDelayMs * attempt;
                    logWarn(`${description} failed (attempt ${attempt}/${this.maxRetries}), retrying in ${delay}ms...`);
                    await sleep(delay);
                    continue;
                }
                throw error;
            }
        }
        throw new Error(`${description} failed after ${this.maxRetries} retries`);
    }

    private async callApi(input: string | string[]): Promise<EmbeddingApiResponse> {
        const url = `${this.baseUrl}/embeddings`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model: this.model, input }),
        });

        const parsed = await response.json() as EmbeddingApiResponse;

        if (parsed.success === false) {
            throw new Error(`API error: ${parsed.message}`);
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${parsed.message || 'Unknown error'}`);
        }

        return parsed;
    }

    async generateEmbedding(text: string): Promise<EmbeddingResult> {
        const response = await this.callWithRetry(
            () => this.callApi(text),
            'generateEmbedding'
        );

        const embedding = response.data[0].embedding;
        logInfo(`Generated embedding for text (length=${text.length}), dimensions=${embedding.length}`);

        return { embedding, dimensions: embedding.length };
    }

    async generateBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
        const response = await this.callWithRetry(
            () => this.callApi(texts),
            `generateBatchEmbeddings(${texts.length} texts)`
        );

        return response.data.map((item) => ({
            embedding: item.embedding,
            dimensions: item.embedding.length,
        }));
    }
}