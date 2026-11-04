import fs from 'node:fs';
import path from 'node:path';
import { buildDocx } from './docx.js';
import { LEVELS, STYLES } from './prompts.js';

/** Write the four deliverables into <outputDir>/interview-<timestamp>/. */
export async function writeReport(interview) {
  const stamp = interview.createdAt.slice(0, 16).replace(/[:T]/g, '-');
  const dir = path.join(interview.config.outputDir, `interview-${stamp}-${interview.id.slice(-6)}`);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, '面试记录.md'), renderMarkdown(interview));
  fs.writeFileSync(path.join(dir, 'transcript.md'), renderTranscript(interview));
  fs.writeFileSync(path.join(dir, 'scores.json'), JSON.stringify(renderScores(interview), null, 2));
  fs.writeFileSync(path.join(dir, '面试记录.docx'), Buffer.from(buildDocx(renderDocxParagraphs(interview))));
  return dir;
}

function headerLines(interview) {
  const c = interview.config;
  const focus = c.focus;
  return [
    `技术栈：${c.techStack}`,
    `目标职级：${LEVELS[c.level] || c.level}`,
    `面试风格：${STYLES[c.style] || c.style}`,
    `考察配比：基础 ${focus.fundamentals}% / 项目 ${focus.project}% / 系统设计 ${focus.system}%`,
    `时间：${interview.createdAt}`,
    c.jd ? `目标岗位 JD：${c.jd.slice(0, 500)}${c.jd.length > 500 ? '…' : ''}` : null,
  ].filter(Boolean);
}

export function renderMarkdown(iv) {
  const lines = ['# 面试记录', '', ...headerLines(iv).map((l) => `- ${l}`), ''];
  lines.push(`## 总分：${iv.totalScore ?? '-'} / 100`, '');
  if (iv.summary) lines.push('## 面试总结', '', iv.summary, '');
  if (iv.selfIntro) {
    lines.push('## 自我介绍', '', `**得分：${iv.selfIntro.total} / 100**（准确性 ${iv.selfIntro.dims.accuracy} · 深度 ${iv.selfIntro.dims.depth} · 表达 ${iv.selfIntro.dims.expression} · 完整性 ${iv.selfIntro.dims.structure}）`, '');
    lines.push(`**回答**：${iv.selfIntro.answer}`, '');
    lines.push(`**总评**：${iv.selfIntro.comment}`, '');
    lines.push('**改进建议**：', ...iv.selfIntro.suggestions.map((s) => `- ${s}`), '');
  }
  for (const q of iv.questions) {
    const qLabel = [q.project && `项目：${q.project}`, q.angle].filter(Boolean).join(' · ');
    lines.push(`## 第 ${q.index + 1} 题${qLabel ? `（${qLabel}）` : ''}：${q.question}`, '');
    if (q.score != null && q.scored?.dims) {
      lines.push(`**得分：${q.score} / 100**（准确性 ${q.scored.dims.accuracy} · 深度 ${q.scored.dims.depth} · 表达 ${q.scored.dims.expression} · 完整性 ${q.scored.dims.structure}）`, '');
    } else if (q.score != null) {
      lines.push(`**得分：${q.score} / 100**`, '');
    }
    const attempts = q.attempts?.length ? q.attempts : (q.answer ? [{ answer: q.answer, scored: q.scored }] : []);
    if (attempts.length > 1) {
      lines.push(`**共作答 ${attempts.length} 次**（得分变化：${attempts.map((a) => a.scored?.total ?? '-').join(' → ')}）`, '');
      attempts.forEach((a, i) => lines.push(`**第 ${i + 1} 次作答**：${a.answer}`, ''));
    } else {
      lines.push(`**回答**：${q.answer || '（未作答）'}`, '');
    }
    if (q.followup) {
      lines.push(`**追问**：${q.followup.question}`, '');
      lines.push(`**追问回答**：${q.followup.answer || '（未作答）'}`, '');
    }
    for (const [i, f] of (q.followups || []).entries()) {
      lines.push(`**追问 ${i + 1}**：${f.question}`, '');
      lines.push(`**追问回答**：${f.answer || '（未作答）'}${f.scored ? `（本轮 ${f.scored.total} 分）` : ''}`, '');
    }
    if (q.comment) lines.push(`**总评**：${q.comment}`, '');
    if (q.suggestions?.length) lines.push('**改进建议**：', ...q.suggestions.map((s) => `- ${s}`), '');
    if (q.scored?.explanation) lines.push('**知识讲解**：', '', q.scored.explanation, '');
    if (q.scored?.referenceAnswer) lines.push('**参考答案**：', '', '```', q.scored.referenceAnswer, '```', '');
  }
  return lines.join('\n');
}

function renderTranscript(iv) {
  const lines = ['# 面试文字稿', '', ...headerLines(iv).map((l) => `- ${l}`), ''];
  if (iv.selfIntro) {
    lines.push('## 自我介绍', '', `**面试官**：${'请先做一个自我介绍。'}`, '', `**候选人**：${iv.selfIntro.answer}`, '');
  }
  for (const q of iv.questions) {
    lines.push(`## 第 ${q.index + 1} 题`, '', `**面试官**：${q.question}`, '', `**候选人**：${q.answer || '（未作答）'}`, '');
    if (q.followup) {
      lines.push(`**面试官（追问）**：${q.followup.question}`, '', `**候选人**：${q.followup.answer || '（未作答）'}`, '');
    }
    for (const f of q.followups || []) {
      lines.push(`**面试官（追问）**：${f.question}`, '', `**候选人**：${f.answer || '（未作答）'}`, '');
    }
  }
  return lines.join('\n');
}

function renderScores(iv) {
  return {
    id: iv.id,
    createdAt: iv.createdAt,
    techStack: iv.config.techStack,
    level: iv.config.level,
    style: iv.config.style,
    totalScore: iv.totalScore,
    selfIntro: iv.selfIntro ? { score: iv.selfIntro.total, dims: iv.selfIntro.dims } : null,
    questions: iv.questions.map((q) => ({
      index: q.index,
      question: q.question,
      project: q.project ?? null,
      angle: q.angle ?? null,
      score: q.score ?? null,
      dims: q.scored?.dims ?? null,
      followup: Boolean(q.followup),
      followups: (q.followups || []).map((f) => ({ question: f.question, answer: f.answer ?? null, score: f.scored?.total ?? null })),
      attempts: (q.attempts || []).map((a) => ({ answer: a.answer, score: a.scored?.total ?? null, dims: a.scored?.dims ?? null, at: a.at })),
      explanation: q.scored?.explanation ?? null,
      referenceAnswer: q.scored?.referenceAnswer ?? null,
      problem: q.problem ?? null,
    })),
  };
}

function renderDocxParagraphs(iv) {
  const ps = [{ text: '面试记录', style: 'title' }];
  for (const line of headerLines(iv)) ps.push({ text: line });
  ps.push({ text: `总分：${iv.totalScore ?? '-'} / 100`, style: 'heading' });
  if (iv.summary) ps.push({ text: '面试总结', style: 'heading' }, { text: iv.summary });
  if (iv.selfIntro) {
    ps.push({ text: '自我介绍', style: 'heading' });
    ps.push({ text: `得分：${iv.selfIntro.total} / 100（准确性 ${iv.selfIntro.dims.accuracy} · 深度 ${iv.selfIntro.dims.depth} · 表达 ${iv.selfIntro.dims.expression} · 完整性 ${iv.selfIntro.dims.structure}）` });
    ps.push({ text: `回答：${iv.selfIntro.answer}` });
    ps.push({ text: `总评：${iv.selfIntro.comment}` });
    for (const s of iv.selfIntro.suggestions) ps.push({ text: `改进建议：${s}` });
  }
  for (const q of iv.questions) {
    const qLabel = [q.project && `项目：${q.project}`, q.angle].filter(Boolean).join(' · ');
    ps.push({ text: `第 ${q.index + 1} 题${qLabel ? `（${qLabel}）` : ''}：${q.question}`, style: 'heading' });
    if (q.score != null) {
      ps.push({ text: `得分：${q.score} / 100（准确性 ${q.scored.dims.accuracy} · 深度 ${q.scored.dims.depth} · 表达 ${q.scored.dims.expression} · 完整性 ${q.scored.dims.structure}）` });
    }
    ps.push({ text: `回答：${q.answer || '（未作答）'}` });
    if (q.attempts?.length > 1) {
      ps.push({ text: `共作答 ${q.attempts.length} 次，得分变化：${q.attempts.map((a) => a.scored?.total ?? '-').join(' → ')}` });
    }
    if (q.followup) {
      ps.push({ text: `追问：${q.followup.question}` });
      ps.push({ text: `追问回答：${q.followup.answer || '（未作答）'}` });
    }
    for (const [i, f] of (q.followups || []).entries()) {
      ps.push({ text: `追问 ${i + 1}：${f.question}` });
      ps.push({ text: `追问回答：${f.answer || '（未作答）'}${f.scored ? `（本轮 ${f.scored.total} 分）` : ''}` });
    }
    if (q.comment) ps.push({ text: `总评：${q.comment}` });
    for (const s of q.suggestions || []) ps.push({ text: `改进建议：${s}` });
    if (q.scored?.explanation) ps.push({ text: `知识讲解：${q.scored.explanation}` });
    if (q.scored?.referenceAnswer) ps.push({ text: `参考答案：${q.scored.referenceAnswer}` });
  }
  return ps;
}
