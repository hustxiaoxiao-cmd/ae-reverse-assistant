import { Agent } from '../agent/agent';
import { QueryRequest, QueryResponse } from '../types';
import { logInfo, logError } from '../utils/logger';

export class QueryService {
    private agent: Agent;

    constructor(agent: Agent) {
        this.agent = agent;
    }

    async handleQuery(request: QueryRequest): Promise<QueryResponse> {
        if (!request.query || !request.query.trim()) {
            return {
                success: false,
                message: '查询内容不能为空',
            };
        }

        logInfo(`Handling query from user: ${request.userId || 'anonymous'}`);
        return this.agent.processQuery(request.query.trim());
    }
}