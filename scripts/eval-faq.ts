/**
 * FAQ 准确度评测脚本
 *
 * 1. 解析 tests/eval/海外本地仓FAQ-100条.md 提取 Q&A 对
 * 2. 逐条调用本地 RAG API (/api/query) 获取回答
 * 3. 用 LLM 对比 RAG 回答与标准答案，打分 0-100
 * 4. 输出详细结果 + 统计摘要到 tests/eval/eval-result-YYYYMMDD-HHmmss.md
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";

// ─── 配置 ───────────────────────────────────────────────
const FAQ_PATH = path.resolve(__dirname, "../tests/eval/海外本地仓FAQ-100条.md");
const RAG_BASE = "http://localhost:3000";
const RAG_QUERY_URL = `${RAG_BASE}/api/query`;

// DashScope (从 .env 读取或硬编码)
const API_KEY = process.env.DASHSCOPE_API_KEY || "sk-2ff1d8ee48bb4cc29d0ab2b79c5580c5";
const API_BASE = process.env.API_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const JUDGE_MODEL = "qwen-plus";

const CONCURRENCY = 3;       // 并发请求数
const DELAY_MS = 500;         // 每批间延迟(ms)
const JUDGE_DELAY_MS = 300;   // LLM 评分间延迟(ms)

// ─── 类型定义 ────────────────────────────────────────────
interface FAQPair {
  id: number;        // Q 编号
  chapter: string;   // 所属章节
  question: string;
  standardAnswer: string;
}

interface KeyPointCheck {
  point: string;     // 关键点描述
  status: "hit" | "miss" | "wrong"; // 命中/遗漏/矛盾
  detail: string;    // 判定理由
}

interface EvalResult extends FAQPair {
  ragAnswer: string;
  sources: string[];
  score: number;
  judgeReason: string;
  latencyMs: number;
  // 新增: 关键点评分详情
  keyPoints: KeyPointCheck[];
  hitCount: number;
  missCount: number;
  wrongCount: number;
  rawScore: number;       // 覆盖率原始分
  penaltyScore: number;   // 矛盾扣分后最终分
}

// ─── 1. 解析 FAQ ─────────────────────────────────────────
function parseFAQ(filePath: string): FAQPair[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const pairs: FAQPair[] = [];

  let currentChapter = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // 匹配章节标题: ## 一、退件服务概况（Q1–Q5）
    const chapterMatch = line.match(/^##\s+(.+)$/);
    if (chapterMatch) {
      currentChapter = chapterMatch[1].trim();
      i++;
      continue;
    }

    // 匹配问题: **Q1：xxx** 或 **Q1: xxx**
    const qMatch = line.match(/^\*\*Q(\d+)[：:]\s*(.+?)\*\*$/);
    if (qMatch) {
      const id = parseInt(qMatch[1]);
      const question = qMatch[2].trim();

      // 下一行是答案: A：xxx 或 A: xxx
      i++;
      let answerLine = "";
      while (i < lines.length) {
        const aLine = lines[i].trim();
        if (aLine.match(/^A[：:]/)) {
          answerLine = aLine.replace(/^A[：:]\s*/, "");
          // 答案可能跨多行（直到空行或下一个 **Q）
          i++;
          while (i < lines.length) {
            const nextLine = lines[i].trim();
            if (nextLine === "" || nextLine.match(/^\*\*Q\d+/) || nextLine.match(/^##\s+/) || nextLine === "---") {
              break;
            }
            answerLine += nextLine;
            i++;
          }
          break;
        }
        i++;
      }

      pairs.push({ id, chapter: currentChapter, question, standardAnswer: answerLine });
      continue;
    }
    i++;
  }

  return pairs;
}

// ─── 2. 调用 RAG API ─────────────────────────────────────
function callRAG(question: string): Promise<{ answer: string; sources: string[]; latencyMs: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: question });
    const start = Date.now();

    const req = http.request(
      RAG_QUERY_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const latencyMs = Date.now() - start;
          try {
            const json = JSON.parse(data);
            resolve({
              answer: json.answer || "",
              sources: (json.sources || []).map((s: any) => s.source || s.title || s),
              latencyMs,
            });
          } catch (e) {
            reject(new Error(`RAG response parse error: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── 3. LLM 关键点评分（三步法）─────────────────────────

/** 通用 LLM 调用 */
function callLLM(prompt: string, maxTokens: number = 2000): Promise<string> {
  const body = JSON.stringify({
    model: JUDGE_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    max_tokens: maxTokens,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}/chat/completions`);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.choices?.[0]?.message?.content || "");
          } catch (e: any) {
            reject(new Error(`LLM parse error: ${e.message}`));
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("LLM call timeout (30s)")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Phase 1: 从标准答案提取独立关键点 */
async function extractKeyPoints(question: string, standardAnswer: string): Promise<string[]> {
  const prompt = `你是一个知识库质量分析专家。请从以下标准答案中提取所有独立的事实关键点。

【问题】${question}

【标准答案】${standardAnswer}

要求：
1. 每个关键点应是一个独立的、可验证的事实陈述
2. 尽量细粒度拆分，但保持语义完整（如"5大环节依次为A→B→C→D→E"可以拆为5个独立环节）
3. 数量信息、时限要求、条件判断等都要单独列出
4. 不要添加标准答案中没有的信息
5. 每个关键点用一句话表述，不超过50字

请严格按JSON数组格式回复，不要输出其他内容：
["关键点1", "关键点2", "关键点3", ...]`;

  const content = await callLLM(prompt, 1500);
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`关键点提取失败: ${content.slice(0, 150)}`);
  }
  return JSON.parse(jsonMatch[0]);
}

/** Phase 2: 逐点验证 RAG 回答 */
async function verifyKeyPoints(
  question: string,
  keyPoints: string[],
  ragAnswer: string
): Promise<KeyPointCheck[]> {
  const pointsList = keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n");

  const prompt = `你是一个严格的问答质量评审员。请逐条验证RAG回答是否覆盖了标准答案的每个关键点。

【问题】${question}

【关键点列表】
${pointsList}

【RAG回答】${ragAnswer}

对每个关键点，判定其状态：
- "hit": RAG回答正确覆盖了该关键点（允许表述不同但语义一致）
- "miss": RAG回答中未提及该关键点的信息
- "wrong": RAG回答中包含了与该关键点矛盾或错误的信息

判定原则：
1. 语义等价即可判定hit，不要求完全相同的措辞
2. 只要RAG回答中有任何与该关键点矛盾的描述，就判wrong（即使同时也提到了正确信息）
3. 如果RAG明确说"知识库未提供"某信息但标准答案有，判miss
4. wrong的扣分权重高于miss，因为错误信息比遗漏更严重

请严格按JSON格式回复，不要输出其他内容：
{"checks": [{"point": "关键点原文", "status": "hit|miss|wrong", "detail": "15字以内判定理由"}, ...]}`;

  const content = await callLLM(prompt, 3000);
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`关键点验证失败: ${content.slice(0, 150)}`);
  }
  const result = JSON.parse(jsonMatch[0]);
  return (result.checks || []).map((c: any) => ({
    point: c.point || "",
    status: (["hit", "miss", "wrong"].includes(c.status) ? c.status : "miss") as "hit" | "miss" | "wrong",
    detail: c.detail || "",
  }));
}

/** Phase 3: 计算综合得分 */
function calculateScore(checks: KeyPointCheck[]): {
  score: number; rawScore: number; penaltyScore: number;
  hitCount: number; missCount: number; wrongCount: number; reason: string;
} {
  const total = checks.length;
  const hitCount = checks.filter((c) => c.status === "hit").length;
  const missCount = checks.filter((c) => c.status === "miss").length;
  const wrongCount = checks.filter((c) => c.status === "wrong").length;

  // 覆盖率得分（0-100）
  const rawScore = total > 0 ? Math.round((hitCount / total) * 100) : 0;
  // 每个矛盾扣15分
  const penalty = wrongCount * 15;
  const penaltyScore = Math.max(0, rawScore - penalty);

  // 生成评分理由
  const parts: string[] = [];
  parts.push(`覆盖${hitCount}/${total}个关键点`);
  if (missCount > 0) parts.push(`遗漏${missCount}个`);
  if (wrongCount > 0) parts.push(`矛盾${wrongCount}个(扣${penalty}分)`);
  parts.push(`最终${penaltyScore}分`);

  return { score: penaltyScore, rawScore, penaltyScore, hitCount, missCount, wrongCount, reason: parts.join("，") };
}

/** 完整的三步评分 */
async function judgeAnswer(
  question: string,
  standardAnswer: string,
  ragAnswer: string
): Promise<{
  score: number; reason: string;
  keyPoints: KeyPointCheck[];
  hitCount: number; missCount: number; wrongCount: number;
  rawScore: number; penaltyScore: number;
}> {
  // Phase 1: 提取关键点
  const keyPointTexts = await extractKeyPoints(question, standardAnswer);

  // Phase 2: 逐点验证
  const checks = await verifyKeyPoints(question, keyPointTexts, ragAnswer);

  // Phase 3: 计算得分
  const result = calculateScore(checks);

  return {
    score: result.score,
    reason: result.reason,
    keyPoints: checks,
    hitCount: result.hitCount,
    missCount: result.missCount,
    wrongCount: result.wrongCount,
    rawScore: result.rawScore,
    penaltyScore: result.penaltyScore,
  };
}

// ─── 4. 检查 RAG 服务 ────────────────────────────────────
function checkHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    http.get(`${RAG_BASE}/api/health`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          console.log(`  ✓ RAG 服务就绪: ${json.entries || "?"} 条知识, 向量索引: ${json.indexReady ? "已就绪" : "构建中"}`);
          resolve(json.indexReady === true);
        } catch {
          resolve(false);
        }
      });
    }).on("error", () => resolve(false));
  });
}

// ─── 5. 生成报告 ─────────────────────────────────────────
function generateReport(results: EvalResult[]): string {
  const total = results.length;
  const scores = results.map((r) => r.score);
  const avg = scores.reduce((a, b) => a + b, 0) / total;
  const pass80 = results.filter((r) => r.score >= 80).length;
  const pass60 = results.filter((r) => r.score >= 60).length;
  const fail = results.filter((r) => r.score < 60).length;
  const avgLatency = results.reduce((a, b) => a + b.latencyMs, 0) / total;

  // 关键点全局统计
  const totalKeyPoints = results.reduce((a, r) => a + r.keyPoints.length, 0);
  const totalHits = results.reduce((a, r) => a + r.hitCount, 0);
  const totalMisses = results.reduce((a, r) => a + r.missCount, 0);
  const totalWrongs = results.reduce((a, r) => a + r.wrongCount, 0);
  const hitRate = totalKeyPoints > 0 ? ((totalHits / totalKeyPoints) * 100).toFixed(1) : "N/A";

  // 有矛盾的题目数
  const wrongCases = results.filter((r) => r.wrongCount > 0);

  // 按分数段统计
  const buckets = [
    { label: "90-100 (优秀)", count: results.filter((r) => r.score >= 90).length },
    { label: "70-89  (良好)", count: results.filter((r) => r.score >= 70 && r.score < 90).length },
    { label: "50-69  (一般)", count: results.filter((r) => r.score >= 50 && r.score < 70).length },
    { label: "30-49  (较差)", count: results.filter((r) => r.score >= 30 && r.score < 50).length },
    { label: "0-29   (不及格)", count: results.filter((r) => r.score < 30).length },
  ];

  // 按章节统计
  const chapters = [...new Set(results.map((r) => r.chapter))];
  const chapterStats = chapters.map((ch) => {
    const items = results.filter((r) => r.chapter === ch);
    const chAvg = items.reduce((a, b) => a + b.score, 0) / items.length;
    const chHits = items.reduce((a, b) => a + b.hitCount, 0);
    const chTotal = items.reduce((a, b) => a + b.keyPoints.length, 0);
    const chHitRate = chTotal > 0 ? ((chHits / chTotal) * 100).toFixed(1) : "N/A";
    return { chapter: ch, count: items.length, avg: chAvg, hitRate: chHitRate };
  });

  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

  let md = `# RAG 准确度评测报告（关键点验证版）

> 评测时间: ${now}
> 评分方法: 三步关键点验证（提取关键点 → 逐点验证 → 覆盖率算分 + 矛盾扣分）
> FAQ 总数: ${total} 条 | 知识库条目: 见 health check

## 总体统计

| 指标 | 数值 |
|---|---|
| 平均分 | **${avg.toFixed(1)}** |
| 关键点命中率 | **${hitRate}%**（${totalHits}/${totalKeyPoints}） |
| ≥80分 (通过) | ${pass80} / ${total} (${((pass80 / total) * 100).toFixed(1)}%) |
| ≥60分 | ${pass60} / ${total} (${((pass60 / total) * 100).toFixed(1)}%) |
| <60分 (未通过) | ${fail} / ${total} (${((fail / total) * 100).toFixed(1)}%) |
| 存在事实矛盾 | ${wrongCases.length} / ${total} 条（共 ${totalWrongs} 个矛盾点） |
| 平均检索延迟 | ${(avgLatency / 1000).toFixed(1)}s |

## 分数段分布

| 分数段 | 数量 | 占比 |
|---|---|---|
${buckets.map((b) => `| ${b.label} | ${b.count} | ${((b.count / total) * 100).toFixed(1)}% |`).join("\n")}

## 各章节表现

| 章节 | 题数 | 平均分 | 关键点命中率 |
|---|---|---|---|
${chapterStats.map((c) => `| ${c.chapter} | ${c.count} | ${c.avg.toFixed(1)} | ${c.hitRate}% |`).join("\n")}

## 事实矛盾汇总

以下题目的RAG回答中存在与标准答案矛盾的信息（wrong），需要优先关注：

`;

  for (const r of wrongCases) {
    const wrongPoints = r.keyPoints.filter((k) => k.status === "wrong");
    md += `**Q${r.id}**（${r.score}分）: ${wrongPoints.map((k) => `${k.point} — ${k.detail}`).join("; ")}\n\n`;
  }

  md += `\n## 逐条评测详情

`;

  for (const r of results) {
    const icon = r.score >= 80 ? "✅" : r.score >= 60 ? "⚠️" : "❌";
    const kpTotal = r.keyPoints.length;
    md += `### ${icon} Q${r.id} — ${r.chapter}（${r.score}分）

**问题**: ${r.question}

**标准答案**: ${r.standardAnswer}

**RAG回答**: ${r.ragAnswer}

**评分**: 覆盖 ${r.hitCount}/${kpTotal} | 遗漏 ${r.missCount} | 矛盾 ${r.wrongCount} | 原始分 ${r.rawScore} → 最终 ${r.penaltyScore}

**关键点验证**:
`;

    if (r.keyPoints.length > 0) {
      md += `| 关键点 | 状态 | 理由 |\n|---|---|---|\n`;
      for (const kp of r.keyPoints) {
        const statusIcon = kp.status === "hit" ? "✅" : kp.status === "miss" ? "⬜" : "❌";
        const statusLabel = kp.status === "hit" ? "命中" : kp.status === "miss" ? "遗漏" : "矛盾";
        md += `| ${kp.point} | ${statusIcon} ${statusLabel} | ${kp.detail} |\n`;
      }
    } else {
      md += `_（无关键点数据）_\n`;
    }

    md += `
**来源**: ${r.sources.join(", ") || "无"}

**延迟**: ${(r.latencyMs / 1000).toFixed(1)}s

---

`;
  }

  return md;
}

// ─── 主流程 ──────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  RAG 准确度评测 — 100 条 FAQ");
  console.log("═══════════════════════════════════════════\n");

  // Step 0: 检查 RAG 服务
  console.log("[0/4] 检查 RAG 服务...");
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    ready = await checkHealth();
    if (ready) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!ready) {
    console.error("\n✗ RAG 服务未就绪（向量索引未完成），请确认服务已启动");
    process.exit(1);
  }

  // Step 1: 解析 FAQ
  console.log(`\n[1/4] 解析 FAQ 文件: ${FAQ_PATH}`);
  const faqs = parseFAQ(FAQ_PATH);
  console.log(`  ✓ 解析到 ${faqs.length} 条问答对`);
  if (faqs.length === 0) {
    console.error("✗ 未解析到任何问答对，请检查文件格式");
    process.exit(1);
  }

  // Step 2: 调用 RAG API
  console.log(`\n[2/4] 调用 RAG API（${faqs.length} 条）...`);
  const ragResults: (FAQPair & { ragAnswer: string; sources: string[]; latencyMs: number })[] = [];
  let ragErrors = 0;

  for (let i = 0; i < faqs.length; i++) {
    const faq = faqs[i];
    process.stdout.write(`  Q${faq.id} [${i + 1}/${faqs.length}]...`);
    try {
      const result = await callRAG(faq.question);
      ragResults.push({ ...faq, ragAnswer: result.answer, sources: result.sources, latencyMs: result.latencyMs });
      process.stdout.write(` ✓ (${(result.latencyMs / 1000).toFixed(1)}s)\n`);
    } catch (e: any) {
      ragResults.push({ ...faq, ragAnswer: `[ERROR] ${e.message}`, sources: [], latencyMs: 0 });
      ragErrors++;
      process.stdout.write(` ✗ ${e.message}\n`);
    }

    // 限速
    if ((i + 1) % CONCURRENCY === 0) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  console.log(`  ✓ RAG 查询完成: ${faqs.length - ragErrors} 成功, ${ragErrors} 失败`);

  // Step 3: LLM 评分
  console.log(`\n[3/4] LLM 自动评分（${ragResults.length} 条）...`);
  const evalResults: EvalResult[] = [];

  for (let i = 0; i < ragResults.length; i++) {
    const r = ragResults[i];
    process.stdout.write(`  Q${r.id} [${i + 1}/${ragResults.length}]...`);

    if (r.ragAnswer.startsWith("[ERROR]")) {
      evalResults.push({
        ...r, score: 0, judgeReason: "RAG 查询失败",
        keyPoints: [], hitCount: 0, missCount: 0, wrongCount: 0,
        rawScore: 0, penaltyScore: 0,
      });
      process.stdout.write(" ⊘ 跳过(查询失败)\n");
      continue;
    }

    try {
      const judge = await judgeAnswer(r.question, r.standardAnswer, r.ragAnswer);
      evalResults.push({
        ...r,
        score: judge.score,
        judgeReason: judge.reason,
        keyPoints: judge.keyPoints,
        hitCount: judge.hitCount,
        missCount: judge.missCount,
        wrongCount: judge.wrongCount,
        rawScore: judge.rawScore,
        penaltyScore: judge.penaltyScore,
      });
      process.stdout.write(` ${judge.score}分 (${judge.hitCount}/${judge.hitCount + judge.missCount + judge.wrongCount}命中${judge.wrongCount > 0 ? `,${judge.wrongCount}矛盾` : ""})\n`);
    } catch (e: any) {
      evalResults.push({
        ...r, score: 0, judgeReason: `评分失败: ${e.message}`,
        keyPoints: [], hitCount: 0, missCount: 0, wrongCount: 0,
        rawScore: 0, penaltyScore: 0,
      });
      process.stdout.write(` ✗ ${e.message}\n`);
    }

    await new Promise((r) => setTimeout(r, JUDGE_DELAY_MS));
  }

  // Step 4: 生成报告
  console.log(`\n[4/4] 生成评测报告...`);
  const report = generateReport(evalResults);

  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
  const reportPath = path.resolve(__dirname, `../tests/eval/eval-result-${ts}.md`);
  fs.writeFileSync(reportPath, report, "utf-8");
  console.log(`  ✓ 报告已保存: ${reportPath}\n`);

  // 输出摘要
  const scores = evalResults.map((r) => r.score);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const pass80 = evalResults.filter((r) => r.score >= 80).length;
  const fail60 = evalResults.filter((r) => r.score < 60).length;
  const totalKP = evalResults.reduce((a, r) => a + r.keyPoints.length, 0);
  const totalH = evalResults.reduce((a, r) => a + r.hitCount, 0);
  const totalM = evalResults.reduce((a, r) => a + r.missCount, 0);
  const totalW = evalResults.reduce((a, r) => a + r.wrongCount, 0);

  console.log("═══════════════════════════════════════════");
  console.log(`  评测完成! (关键点验证版)`);
  console.log(`  平均分: ${avg.toFixed(1)} | ≥80分: ${pass80}条 | <60分: ${fail60}条`);
  console.log(`  关键点命中: ${totalH}/${totalKP} | 矛盾: ${totalW}个`);
  console.log(`  报告: ${reportPath}`);
  console.log("═══════════════════════════════════════════");

  // 同时输出一份 JSON 方便后续分析
  const jsonPath = reportPath.replace(".md", ".json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        method: "key-point-verification",
        total: evalResults.length,
        avgScore: parseFloat(avg.toFixed(1)),
        pass80Count: pass80,
        fail60Count: fail60,
        keyPointStats: {
          total: totalKP,
          hits: totalH,
          misses: totalM,
          wrongs: totalW,
          hitRate: totalKP > 0 ? parseFloat(((totalH / totalKP) * 100).toFixed(1)) : null,
        },
        results: evalResults.map((r) => ({
          id: r.id,
          chapter: r.chapter,
          score: r.score,
          rawScore: r.rawScore,
          penaltyScore: r.penaltyScore,
          hitCount: r.hitCount,
          missCount: r.missCount,
          wrongCount: r.wrongCount,
          latencyMs: r.latencyMs,
          judgeReason: r.judgeReason,
          keyPoints: r.keyPoints,
        })),
      },
      null,
      2
    ),
    "utf-8"
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
