export interface KnowledgeEntry {
    id: string;
    title: string;
    content: string;
    tags?: string[];
    source?: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface QueryRequest {
    query: string;
    userId?: string;
    history?: ChatMessage[];
}

export interface QueryResponse {
    success: boolean;
    answer?: string;
    sources?: Array<{ title: string; score: number }>;
    message?: string;
}

export interface VectorSearchResult {
    entryId: string;
    score: number;
}

export interface EmbeddingResult {
    embedding: number[];
    dimensions: number;
}

export interface FeedbackRecord {
    query: string;
    answer: string;
    type: string;
    reason?: string;
    timestamp: string;
}

export interface QueryRecord {
    query: string;
    answer: string;
    timestamp: string;
}