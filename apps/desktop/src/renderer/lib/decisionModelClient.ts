/**
 * Laya 本地决策客户端。
 *
 * 只负责把当前新任务映射成 typed decision，不执行 Agent，也不参与已经
 * 创建的 Session。服务不可达、响应异常或置信度不足时统一返回 null。
 */

import type { DecisionModelSettings } from '@/state/decisionModelSettings';

export type DecisionVendor = 'cc' | 'codex' | 'pi';

export interface DecisionResult {
  vendor: DecisionVendor;
  /** Laya 选中候选的概率；四分类下均匀分布约为 0.25，门槛按该值判断。 */
  probability: number;
  riskScore: number | null;
  needsReview: boolean | null;
}

const DECISION_CRITERIA: Record<DecisionVendor | 'other', string> = {
  codex: '需要直接修改代码、运行测试并完成工程实现',
  cc: '需要复杂代码分析、架构审查或长上下文工程推理',
  pi: '需要快速执行命令、批量自动化或轻量任务',
  other: '非工程任务或无法确定',
};

function buildQuestions() {
  return {
    task_type: {
      type: 'choice',
      instructions: '这个新任务最适合交给哪个 Agent？',
      criteria: DECISION_CRITERIA,
    },
    risk: {
      type: 'score',
      instructions: '这个任务的风险等级是什么？',
      criteria: [
        '低风险，只读或局部修改',
        '中风险，涉及多个模块',
        '高风险，涉及删除、发布或外部写入',
      ],
    },
    needs_review: {
      type: 'noul',
      instructions: '执行前是否需要人工确认？',
    },
  };
}

function isDecisionVendor(value: unknown): value is DecisionVendor {
  return value === 'cc' || value === 'codex' || value === 'pi';
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readResponse(raw: unknown, minConfidence: number): DecisionResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const answers = (raw as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  const task = (answers as { task_type?: unknown }).task_type;
  if (!task || typeof task !== 'object') return null;
  const choice = (task as { choice?: unknown }).choice;
  if (!isDecisionVendor(choice)) return null;
  const probabilities = (task as { probabilities?: unknown }).probabilities;
  const probability =
    probabilities && typeof probabilities === 'object'
      ? toFiniteNumber((probabilities as Record<string, unknown>)[choice])
      : null;
  // 门槛按候选概率判断：四分类下均匀分布约 25%，有效路由通常落在 30%~55%。
  // 注意不能拿响应里的 confidence（归一化熵，四分类时仅 0.0~0.15）当门槛。
  if (probability === null || probability < minConfidence) return null;

  const risk = (answers as { risk?: unknown }).risk;
  const review = (answers as { needs_review?: unknown }).needs_review;
  const riskScore =
    risk && typeof risk === 'object'
      ? toFiniteNumber((risk as { score?: unknown }).score)
      : null;
  const reviewProbability =
    review && typeof review === 'object'
      ? toFiniteNumber((review as { noul?: unknown }).noul)
      : null;
  return {
    vendor: choice,
    probability,
    riskScore,
    needsReview: reviewProbability === null ? null : reviewProbability >= 0.5,
  };
}

export async function decideAgentForTask(
  text: string,
  settings: DecisionModelSettings,
): Promise<DecisionResult | null> {
  const request = text.trim();
  const endpoint = settings.endpoint.trim();
  if (!settings.enabled || !request || !endpoint) return null;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: { request },
        questions: buildQuestions(),
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return readResponse(await response.json(), settings.minConfidence);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function checkDecisionModelEndpoint(endpoint: string): Promise<void> {
  const parsed = new URL(endpoint);
  const healthUrl = `${parsed.origin}/health`;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { ok?: unknown };
    if (body.ok !== true) throw new Error('服务未就绪');
  } finally {
    window.clearTimeout(timeout);
  }
}
