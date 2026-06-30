import * as dotenv from 'dotenv';
import { Agent } from '../src/agent/agent';
import { loadKnowledge } from '../src/knowledge/loader';
import { logInfo } from '../src/utils/logger';

// 加载环境变量
dotenv.config();

// 评估用例：基于真实查询数据
const EVAL_CASES = [
    { query: '退件质检的拍照要求是什么', expectedKeywords: ['3-5张', '外包装', '销售包装', '内物'] },
    { query: '大包存储到期后怎么办', expectedKeywords: ['销毁', '26天', '12天'] },
    { query: '商家自提超期如何处理', expectedKeywords: ['17CD', '超时', '销毁'] },
    { query: '免质检销毁的流程', expectedKeywords: ['入库扫描', '敏感信息', '脱敏'] },
    { query: 'RMS系统登录失败怎么办', expectedKeywords: ['账号密码', '重置', '仓运营'] },
    { query: '质检发现假货怎么处理', expectedKeywords: ['假货', '销毁', '拍照'] },
    { query: '退件组包的要求', expectedKeywords: ['大包', '面单', '重量'] },
    { query: '质检标准中哪些情况判定为次品', expectedKeywords: ['破损', '污渍', '次品'] },
    { query: '销毁作业的标准流程', expectedKeywords: ['扫描', '拍照', '销毁'] },
    { query: '异常件如何处理', expectedKeywords: ['异常', '上报', '处理'] },
];

interface EvalResult {
    query: string;
    expectedKeywords: string[];
    searchRecall: number;
    answerRecall: number;
    searchRecallKeywords: string[];
    answerRecallKeywords: string[];
}

/**
 * 计算 recall：expectedKeywords 中有多少个出现在 text 中
 */
function calculateRecall(text: string, expectedKeywords: string[]): { recall: number; matched: string[] } {
    const matched: string[] = [];
    for (const keyword of expectedKeywords) {
        if (text.includes(keyword)) {
            matched.push(keyword);
        }
    }
    return {
        recall: matched.length / expectedKeywords.length,
        matched,
    };
}

/**
 * 收集流式回答的完整内容
 */
async function collectFullAnswer(agent: Agent, query: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let fullAnswer = '';
        agent.processQueryStream(
            query,
            (chunk) => { fullAnswer += chunk; },
            () => {},
            () => { resolve(fullAnswer); },
            (error) => { reject(new Error(error)); }
        );
    });
}

async function main() {
    logInfo('=== RAG 系统评估开始 ===');

    // 初始化 Agent
    const agent = new Agent();
    await agent.initialize();

    // 加载知识库
    await loadKnowledge(agent.getKnowledgeStore());

    const results: EvalResult[] = [];
    let totalSearchRecall = 0;
    let totalAnswerRecall = 0;

    for (let i = 0; i < EVAL_CASES.length; i++) {
        const testCase = EVAL_CASES[i];
        logInfo(`\n[${i + 1}/${EVAL_CASES.length}] 评估: ${testCase.query}`);

        // 1. 检索评估
        const searchResults = await agent.getKnowledgeStore().search(testCase.query, 5);
        const searchContent = searchResults.map(r => r.entry.content).join('\n');
        const searchRecallResult = calculateRecall(searchContent, testCase.expectedKeywords);

        // 2. 回答评估
        let answerContent = '';
        try {
            answerContent = await collectFullAnswer(agent, testCase.query);
        } catch (error) {
            logInfo(`  回答生成失败: ${error}`);
        }
        const answerRecallResult = calculateRecall(answerContent, testCase.expectedKeywords);

        const result: EvalResult = {
            query: testCase.query,
            expectedKeywords: testCase.expectedKeywords,
            searchRecall: searchRecallResult.recall,
            answerRecall: answerRecallResult.recall,
            searchRecallKeywords: searchRecallResult.matched,
            answerRecallKeywords: answerRecallResult.matched,
        };
        results.push(result);

        totalSearchRecall += result.searchRecall;
        totalAnswerRecall += result.answerRecall;

        logInfo(`  检索 recall: ${(result.searchRecall * 100).toFixed(1)}% [${result.searchRecallKeywords.join(', ')}]`);
        logInfo(`  回答 recall: ${(result.answerRecall * 100).toFixed(1)}% [${result.answerRecallKeywords.join(', ')}]`);
    }

    // 汇总报告
    const avgSearchRecall = totalSearchRecall / EVAL_CASES.length;
    const avgAnswerRecall = totalAnswerRecall / EVAL_CASES.length;

    logInfo('\n=== 评估报告 ===');
    logInfo(`平均检索 recall: ${(avgSearchRecall * 100).toFixed(1)}%`);
    logInfo(`平均回答 recall: ${(avgAnswerRecall * 100).toFixed(1)}%`);

    logInfo('\n--- 详细结果 ---');
    for (const result of results) {
        const searchStatus = result.searchRecall < 0.5 ? '⚠️ 需优化' : '✅';
        const answerStatus = result.answerRecall < 0.5 ? '⚠️ 需优化' : '✅';
        logInfo(`${searchStatus} ${answerStatus} | ${result.query}`);
        logInfo(`   检索: ${(result.searchRecall * 100).toFixed(1)}% | 回答: ${(result.answerRecall * 100).toFixed(1)}%`);
    }

    logInfo('\n=== 评估完成 ===');
}

main().catch((error) => {
    console.error('评估失败:', error);
    process.exit(1);
});
