import { newId } from './store.js';
import {
  selfIntroPrompt,
  summarizeReferencePrompt,
  nextQuestionPrompt,
  scoreAnswerPrompt,
  finalSummaryPrompt,
  practiceQuestionPrompt,
  scorePracticePrompt,
  referenceAnswerPrompt,
  projectListPrompt,
  SCENARIO_ANGLES,
  PRACTICE_MODES,
  MODES,
  MAX_FOLLOWUPS,
} from './prompts.js';
import { collectReferenceFiles, readReferenceContent, referenceCacheKey, rankReferenceFiles } from './reference.js';
import { leetcodeTop100Problem } from './leetcode.js';

/**
 * Server-side interview/practice state machine. Every mutation is persisted
 * immediately so a closed page resumes exactly where it stopped.
 *
 * status: in-progress | completed | abandoned
 * stage (mock):     selfintro | question | followup | done
 * stage (practice): picking (leetcode only) | question | review | done
 */
export class InterviewEngine {
  constructor({ store, llm, cacheDir }) {
    this.store = store;
    this.llm = llm;
    this.cacheDir = cacheDir;
  }

  list() {
    return this.store.list().map((iv) => ({
      id: iv.id,
      createdAt: iv.createdAt,
      updatedAt: iv.updatedAt,
      status: iv.status,
      mode: iv.config.mode || 'mock',
      techStack: iv.config.techStack,
      topic: iv.config.topic || null,
      level: iv.config.level,
      questionCount: iv.config.questionCount,
      answered: iv.questions.filter((q) => q.score != null).length + (iv.selfIntro ? 1 : 0),
      totalScore: iv.totalScore ?? null,
      reportDir: iv.reportDir ?? null,
    }));
  }

  get(id) {
    return this.store.get(id);
  }

  isPractice(interview) {
    return PRACTICE_MODES.has(interview.config.mode);
  }

  async create(config) {
    validateConfig(config);
    const normalized = normalizeConfig(config);
    // 只有模拟面试 / 简历押题 / 场景题才结合个人经历；
    // 背八股只出技术通用高频题，刷力扣本身就是题库，都不读参考资料。
    const usesReference = ['mock', 'resume', 'scenario'].includes(normalized.mode);
    let referenceSummary = null;
    if (usesReference && normalized.referenceDirs.length) {
      referenceSummary = await this.summarizeReference(normalized.referenceDirs);
    }
    // 场景题 + 参考资料：提取项目清单，出题时按题号轮换项目，避免重复场景
    if (normalized.mode === 'scenario' && referenceSummary && !normalized.fixedProject) {
      normalized.projects = await this.extractProjectsFromSummary(referenceSummary, normalized.referenceDirs);
    }
    const interview = {
      id: newId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'in-progress',
      stage: normalized.mode === 'mock' ? 'selfintro' : normalized.mode === 'leetcode' ? 'picking' : 'question',
      config: normalized,
      referenceSummary,
      currentQuestionIndex: 0,
      selfIntro: null,
      questions: [],
      totalScore: null,
      summary: null,
      reportDir: null,
    };
    if (interview.stage === 'question') {
      const { question, project, angle } = await this.generatePracticeQuestion(interview);
      interview.questions.push({ index: 0, question, project, angle, attempts: [] });
    }
    this.store.save(interview);
    return this.view(interview);
  }

  async summarizeReference(dirs) {
    const key = referenceCacheKey(dirs);
    const cacheFile = `${this.cacheDir}/reference-${key}.txt`;
    const fs = await import('node:fs');
    try {
      const cached = fs.readFileSync(cacheFile, 'utf8');
      if (cached.trim()) return cached;
    } catch { /* no cache */ }
    const { files, errors } = collectReferenceFiles(dirs, { limit: 2000, walkCap: 2000 });
    if (!files.length) {
      throw new Error(errors.length ? errors.join('；') : '参考文件夹中没有可读取的笔记文件（支持 .md/.txt）');
    }
    const ranked = rankReferenceFiles(files).slice(0, 60);
    const content = readReferenceContent(ranked);
    const prompt = summarizeReferencePrompt({ fileList: ranked.map((f) => f.split('/').pop()), content });
    const summary = await this.llm.callText({ system: prompt.system, prompt: prompt.prompt, temperature: 0.3, maxTokens: 2048 });
    try {
      fs.writeFileSync(cacheFile, summary);
    } catch { /* cache best-effort */ }
    return summary;
  }

  /** Current prompt the candidate should answer. */
  currentPrompt(interview) {
    if (interview.stage === 'selfintro') return selfIntroPrompt();
    if (interview.stage === 'followup') {
      const q = interview.questions[interview.currentQuestionIndex];
      // 模拟面试用单轮 q.followup；场景题用追问链 q.followups
      if (q?.followups?.length) return q.followups[q.followups.length - 1].question;
      return q?.followup?.question ?? null;
    }
    if (interview.stage === 'question') {
      const q = interview.questions[interview.currentQuestionIndex];
      return q?.question ?? null;
    }
    return null; // picking / review / done
  }

  /** Submit an answer for the current prompt. */
  async answer(id, text) {
    const interview = this.mustGet(id);
    if (interview.status !== 'in-progress') throw new Error('面试已结束');
    if (this.isPractice(interview)) return this.answerPractice(interview, text);

    const answer = String(text || '').trim();
    if (!answer) throw new Error('回答内容为空');
    const prompt = this.currentPrompt(interview);
    if (!prompt) throw new Error('当前没有待回答的问题');

    const isSelfIntro = interview.stage === 'selfintro';
    const isFollowup = interview.stage === 'followup';
    const scored = normalizeScore(await this.llm.callJSON(
      scoreAnswerPrompt({ config: interview.config, question: prompt, answer, isFollowup, isSelfIntro }),
    ));

    if (isSelfIntro) {
      interview.selfIntro = { answer, ...scored };
      interview.stage = 'question';
      interview.questions = [];
      const question = await this.generateQuestion(interview);
      interview.questions.push({ index: 0, question, attempts: [] });
      this.store.save(interview);
      return { scored, next: this.view(interview) };
    }

    const q = interview.questions[interview.currentQuestionIndex];
    if (isFollowup) {
      q.followup.answer = answer;
      q.followup.scored = scored;
      q.scored = averageScore(q.scored, scored);
      q.score = q.scored.total;
      q.comment = scored.comment;
      q.suggestions = scored.suggestions;
      this.advance(interview);
    } else {
      q.answer = answer;
      q.attempts = [{ answer, scored, at: new Date().toISOString() }];
      q.scored = scored;
      q.score = scored.total;
      q.comment = scored.comment;
      q.suggestions = scored.suggestions;
      // 追问与否完全由面试官模型按回答深度判断（见 scoreAnswerPrompt）。
      if (scored.followup && !q.followup) {
        q.followup = { question: scored.followup };
        interview.stage = 'followup';
        this.store.save(interview);
        return { scored, followup: scored.followup, next: this.view(interview) };
      }
      this.advance(interview);
    }

    if (interview.stage === 'question' && interview.status === 'in-progress') {
      if (!interview.questions[interview.currentQuestionIndex]) {
        const question = await this.generateQuestion(interview);
        interview.questions.push({ index: interview.currentQuestionIndex, question, attempts: [] });
      }
    }
    this.store.save(interview);
    return { scored, next: this.view(interview) };
  }

  /** Practice modes: score with explanation + reference answer; scenario mode
   *  runs a follow-up chain (rounds capped by level) before the review. */
  async answerPractice(interview, text) {
    const answer = String(text || '').trim();
    if (!answer) throw new Error('回答内容为空');
    const q = interview.questions[interview.currentQuestionIndex];
    if (!q) throw new Error('当前没有待回答的问题');
    const isScenario = interview.config.mode === 'scenario';
    const maxFollowups = isScenario ? (MAX_FOLLOWUPS[interview.config.level] ?? 2) : 0;

    if (interview.stage === 'followup' && isScenario) {
      const chain = q.followups || [];
      const current = chain[chain.length - 1];
      if (!current) throw new Error('追问状态异常');
      const scored = normalizePracticeScore(await this.llm.callJSON(scorePracticePrompt({
        config: interview.config,
        question: current.question,
        answer,
        problem: null,
        language: interview.config.language,
        isFollowup: true,
        followupsDone: chain.length,
        maxFollowups,
      })));
      current.answer = answer;
      current.scored = scored;
      // 继续追问或进入点评
      if (scored.followup && chain.length < maxFollowups) {
        chain.push({ question: scored.followup });
        q.followups = chain;
        interview.stage = 'followup';
      } else {
        this.mergeScenarioReview(interview, q, scored);
        interview.stage = 'review';
      }
      this.store.save(interview);
      return { scored, followup: interview.stage === 'followup' ? scored.followup : null, next: this.view(interview) };
    }

    if (interview.stage !== 'question') throw new Error('当前不在作答环节');
    const scored = normalizePracticeScore(await this.llm.callJSON(scorePracticePrompt({
      config: interview.config,
      question: q.question,
      answer,
      problem: q.problem ?? null,
      language: interview.config.language,
      followupsDone: 0,
      maxFollowups,
    })));
    // 场景题：深度未达职级期望时先追问，点评（讲解/参考答案）在追问链结束后才展示
    if (isScenario && scored.followup && maxFollowups > 0) {
      q.attempts = [...(q.attempts || []), { answer, scored, at: new Date().toISOString() }];
      q.pendingMain = { answer, scored };
      q.followups = [{ question: scored.followup }];
      interview.stage = 'followup';
      this.store.save(interview);
      return { scored, followup: scored.followup, next: this.view(interview) };
    }
    q.followups = []; // 重答或无需追问时清掉旧追问链
    q.attempts = [...(q.attempts || []), { answer, scored, at: new Date().toISOString() }];
    q.answer = answer;
    q.scored = scored;
    q.score = scored.total;
    q.comment = scored.comment;
    q.suggestions = scored.suggestions;
    interview.stage = 'review';
    this.store.save(interview);
    return { scored, next: this.view(interview) };
  }

  /** Merge main answer + follow-up chain into the question's final review. */
  mergeScenarioReview(interview, q, lastScored) {
    const main = q.pendingMain;
    const chainScores = (q.followups || []).filter((f) => f.scored).map((f) => f.scored);
    const all = [main?.scored, ...chainScores].filter(Boolean);
    if (all.length) {
      const dims = {};
      for (const key of ['accuracy', 'depth', 'expression', 'structure']) {
        dims[key] = Math.round(all.reduce((n, s) => n + s.dims[key], 0) / all.length);
      }
      q.scored = {
        ...lastScored,
        dims,
        total: dims.accuracy + dims.depth + dims.expression + dims.structure,
        followup: null,
      };
    } else {
      q.scored = lastScored;
    }
    q.answer = main?.answer || q.answer;
    q.score = q.scored.total;
    q.comment = lastScored.comment;
    q.suggestions = lastScored.suggestions;
    delete q.pendingMain;
  }

  /** Retry the current question (practice modes): append an attempt, stay in review. */
  async retry(id, text) {
    const interview = this.mustGet(id);
    if (interview.status !== 'in-progress') throw new Error('练习已结束');
    if (!this.isPractice(interview)) throw new Error('仅练习模式支持重新作答');
    if (interview.stage !== 'review') throw new Error('当前不在可以重新作答的状态');
    interview.stage = 'question';
    this.store.save(interview);
    return this.answerPractice(interview, text);
  }

  /** 用户主动求助：为当前问题生成参考回答（按题目缓存，不进入评分）。 */
  async referenceAnswer(id) {
    const interview = this.mustGet(id);
    if (interview.status !== 'in-progress') throw new Error('面试已结束');
    const stage = interview.stage;
    let prompt = null;
    let key = null;
    let problem = null;
    if (stage === 'selfintro') {
      prompt = selfIntroPrompt();
      key = 'selfintro';
    } else if (stage === 'followup' || stage === 'question') {
      const q = interview.questions[interview.currentQuestionIndex];
      if (!q) throw new Error('当前没有可参考的问题');
      if (stage === 'followup') {
        const chain = q.followups || [];
        prompt = chain.length ? chain[chain.length - 1].question : q.followup?.question;
        key = `q${q.index}-followup-${chain.length}`;
      } else {
        prompt = q.question;
        key = `q${q.index}`;
        problem = q.problem ?? null;
      }
    } else {
      throw new Error('当前阶段没有可参考的问题');
    }
    if (!prompt) throw new Error('当前没有可参考的问题');

    const hints = interview.hints || {};
    if (hints[key]) return hints[key];
    const result = await this.llm.callJSON(referenceAnswerPrompt({
      config: interview.config,
      question: prompt,
      problem,
      language: interview.config.language,
      isSelfIntro: stage === 'selfintro',
    }));
    const hint = {
      outline: String(result.outline || ''),
      answer: String(result.answer || ''),
      pitfalls: String(result.pitfalls || ''),
    };
    if (!hint.answer.trim()) throw new Error('参考回答生成失败');
    interview.hints = { ...hints, [key]: hint };
    this.store.save(interview);
    return hint;
  }

  /** Move on from review: next question, next pick, or done. */
  async next(id) {
    const interview = this.mustGet(id);
    if (interview.status !== 'in-progress') throw new Error('练习已结束');
    if (!this.isPractice(interview)) throw new Error('仅练习模式支持手动下一题');
    if (interview.stage !== 'review') throw new Error('请先完成当前题目的作答');
    const done = interview.questions.length >= interview.config.questionCount && interview.config.mode !== 'leetcode';
    if (done) {
      interview.stage = 'done';
      this.store.save(interview);
      return this.view(interview);
    }
    if (interview.config.mode === 'leetcode') {
      interview.stage = 'picking';
      this.store.save(interview);
      return this.view(interview);
    }
    interview.currentQuestionIndex = interview.questions.length;
    const { question, project, angle } = await this.generatePracticeQuestion(interview);
    interview.questions.push({ index: interview.currentQuestionIndex, question, project, angle, attempts: [] });
    interview.stage = 'question';
    this.store.save(interview);
    return this.view(interview);
  }

  /** LeetCode mode: pick a problem from the Hot 100 catalog. */
  async pick(id, slug) {
    const interview = this.mustGet(id);
    if (interview.status !== 'in-progress') throw new Error('练习已结束');
    if (interview.config.mode !== 'leetcode') throw new Error('当前练习不是刷力扣模式');
    if (interview.stage !== 'picking') throw new Error('当前不在选题环节');
    const problem = leetcodeTop100Problem(String(slug || ''));
    if (!problem) throw new Error('题目不存在');
    if (interview.questions.some((q) => q.problem?.slug === slug)) throw new Error('这道题已经练过了');
    interview.currentQuestionIndex = interview.questions.length;
    interview.questions.push({
      index: interview.currentQuestionIndex,
      question: `【${problem.category} · ${problem.id}. ${problem.title}】请用 ${interview.config.language} 解答：先讲清解题思路，再给出代码实现，最后分析时间与空间复杂度。`,
      problem,
      attempts: [],
    });
    interview.stage = 'question';
    this.store.save(interview);
    return this.view(interview);
  }

  advance(interview) {
    interview.stage = 'question';
    if (interview.currentQuestionIndex + 1 >= interview.config.questionCount) {
      interview.stage = 'done';
      return;
    }
    interview.currentQuestionIndex += 1;
  }

  async generateQuestion(interview) {
    const history = interview.questions
      .filter((q) => q.answer)
      .map((q) => ({ question: q.question, answerSummary: (q.answer || '').slice(0, 300) }));
    const result = await this.llm.callJSON(nextQuestionPrompt({
      config: interview.config,
      referenceSummary: interview.referenceSummary,
      history,
    }));
    if (!result.question || typeof result.question !== 'string') throw new Error('面试官未能生成有效题目');
    return result.question.trim();
  }

  /** Extract project names from the summary; fall back to raw file content. */
  async extractProjectsFromSummary(referenceSummary, dirs) {
    const fromSummary = await this.extractProjectsFromText(referenceSummary);
    if (fromSummary.length || !dirs || !dirs.length) return fromSummary;

    // 摘要没覆盖项目时（大文件夹只摘要了部分文件），直接读原始资料再试一次，
    // 优先简历/项目类文件，保证"选了参考文件夹就有项目场景"可用。
    try {
      const { files } = collectReferenceFiles(dirs, { limit: 2000, walkCap: 2000 });
      const ranked = rankReferenceFiles(files).slice(0, 20);
      const excerpt = readReferenceContent(ranked).slice(0, 40000);
      if (!excerpt.trim()) return [];
      return await this.extractProjectsFromText(excerpt);
    } catch {
      return [];
    }
  }

  /** One LMM call asking for project names, tolerant JSON parsing. */
  async extractProjectsFromText(text) {
    try {
      const prompt = projectListPrompt({ referenceSummary: text });
      const reply = await this.llm.callText({ system: prompt.system, prompt: prompt.prompt, temperature: 0.2, maxTokens: 512 });
      return parseProjectList(reply);
    } catch {
      return [];
    }
  }

  /** For the setup UI: summarize the dirs (cached) and list projects. */
  async listReferenceProjects(dirs, debug) {
    const summary = await this.summarizeReference(dirs);
    const projects = await this.extractProjectsFromSummary(summary, dirs);
    return debug ? { raw: summary.slice(0, 500), projects } : projects;
  }

  async generatePracticeQuestion(interview) {
    const history = interview.questions.map((q) => ({ question: q.question }));
    const projects = interview.config.fixedProject ? [interview.config.fixedProject] : (interview.config.projects || []);
    const i = interview.questions.length;
    // 项目 × 角度对角线轮换：每题换一个项目、同时换一个考察角度，
    // 项目问完一圈后角度继续错开，覆盖面最大且不重复。
    const assignedProject = projects.length ? projects[i % projects.length] : null;
    const assignedAngle = interview.config.mode === 'scenario'
      ? SCENARIO_ANGLES[i % SCENARIO_ANGLES.length]
      : null;
    const result = await this.llm.callJSON(practiceQuestionPrompt({
      config: interview.config,
      referenceSummary: interview.config.mode === 'fundamentals' ? null : interview.referenceSummary,
      history,
      assignedProject,
      assignedAngle,
    }));
    if (!result.question || typeof result.question !== 'string') throw new Error('出题失败');
    return { question: result.question.trim(), project: assignedProject, angle: assignedAngle };
  }

  /** Finish now (all questions answered or the candidate ends early). */
  async finish(id, report) {
    const interview = this.mustGet(id);
    if (interview.status !== 'in-progress') return this.view(interview);
    interview.stage = 'done';
    interview.status = 'completed';
    const scores = [];
    if (interview.selfIntro) scores.push(interview.selfIntro.total);
    for (const q of interview.questions) if (q.score != null) scores.push(q.score);
    interview.totalScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    try {
      interview.summary = await this.llm.callText(finalSummaryPrompt({ config: interview.config, interview }));
    } catch {
      interview.summary = '（总结生成失败）';
    }
    if (interview.config.outputDir) {
      interview.reportDir = await report(interview);
    }
    this.store.save(interview);
    return this.view(interview);
  }

  abandon(id) {
    const interview = this.mustGet(id);
    if (interview.status === 'in-progress') {
      interview.status = 'abandoned';
      this.store.save(interview);
    }
    return this.view(interview);
  }

  remove(id) {
    this.store.remove(id);
  }

  mustGet(id) {
    const interview = this.store.get(id);
    if (!interview) throw new Error('面试不存在');
    return interview;
  }

  /** Public view: everything the UI needs, nothing it doesn't. */
  view(interview) {
    return {
      id: interview.id,
      status: interview.status,
      stage: interview.stage,
      mode: interview.config.mode || 'mock',
      practice: this.isPractice(interview),
      createdAt: interview.createdAt,
      config: interview.config,
      currentQuestionIndex: interview.currentQuestionIndex,
      currentPrompt: interview.status === 'in-progress' ? this.currentPrompt(interview) : null,
      currentQuestion: interview.status === 'in-progress'
        ? interview.questions[interview.currentQuestionIndex] ?? null : null,
      selfIntro: interview.selfIntro,
      questions: interview.questions,
      totalScore: interview.totalScore,
      summary: interview.summary,
      reportDir: interview.reportDir,
    };
  }
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('缺少面试配置');
  const mode = config.mode || 'mock';
  if (!Object.keys(MODES).includes(mode)) throw new Error('未知的练习模式');
  if (mode === 'fundamentals') {
    if (!config.topic || !String(config.topic).trim()) throw new Error('请填写练习主题');
  } else if (mode === 'scenario') {
    // 场景题：主题与参考文件夹至少其一（无主题时从简历项目经历改编）
    const hasTopic = config.topic && String(config.topic).trim();
    const hasRef = Array.isArray(config.referenceDirs) && config.referenceDirs.length > 0;
    if (!hasTopic && !hasRef) throw new Error('请填写场景主题，或选择简历/项目参考文件夹');
  } else if (mode !== 'leetcode') {
    if (!config.techStack || !String(config.techStack).trim()) throw new Error('请填写技术栈');
  }
  if (!config.outputDir || !String(config.outputDir).trim()) throw new Error('请选择输出目录');
}

function normalizeConfig(config) {
  const focus = config.focus || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : d);
  const mode = Object.keys(MODES).includes(config.mode) ? config.mode : 'mock';
  const rawTopic = String(config.topic || '').trim().slice(0, 200);
  const rawStack = String(config.techStack || '').trim().slice(0, 200);
  // 背八股/场景题：主题即技术方向，无需重复填技术栈
  const effectiveStack = rawStack || ((mode === 'fundamentals' || mode === 'scenario') ? rawTopic : '');
  return {
    mode,
    topic: String(config.topic || '').trim().slice(0, 200),
    language: ['java', 'python', 'go', 'cpp', 'javascript', 'typescript'].includes(config.language) ? config.language : 'java',
    techStack: effectiveStack,
    level: ['mid', 'senior', 'staff', 'architect'].includes(config.level) ? config.level : 'staff',
    questionCount: [5, 10, 15].includes(Number(config.questionCount)) ? Number(config.questionCount) : 10,
    style: ['normal', 'pressure', 'project-deepdive'].includes(config.style) ? config.style : 'normal',
    jd: String(config.jd || '').slice(0, 4000),
    focus: {
      fundamentals: num(focus.fundamentals, 34),
      project: num(focus.project, 33),
      system: num(focus.system, 33),
    },
    referenceDirs: Array.isArray(config.referenceDirs) ? config.referenceDirs.map(String).slice(0, 5) : [],
    projects: Array.isArray(config.projects) ? config.projects.map(String).filter(Boolean).slice(0, 10) : [],
    fixedProject: String(config.fixedProject || '').trim().slice(0, 100) || null,
    outputDir: String(config.outputDir).trim(),
  };
}

function normalizeScore(raw) {
  const dim = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(0, Math.min(25, n)) : 0;
  };
  const accuracy = dim(raw.accuracy);
  const depth = dim(raw.depth);
  const expression = dim(raw.expression);
  const structure = dim(raw.structure);
  return {
    dims: { accuracy, depth, expression, structure },
    total: accuracy + depth + expression + structure,
    comment: String(raw.comment || '').slice(0, 300),
    suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.map((s) => String(s)).slice(0, 5) : [],
    followup: typeof raw.followup === 'string' && raw.followup.trim() && raw.followup !== 'null' ? raw.followup.trim() : null,
  };
}

function normalizePracticeScore(raw) {
  const base = normalizeScore(raw);
  return {
    ...base,
    explanation: String(raw.explanation || '').slice(0, 2000),
    referenceAnswer: String(raw.referenceAnswer || '').slice(0, 4000),
  };
}

function averageScore(a, b) {
  const dims = {};
  for (const key of ['accuracy', 'depth', 'expression', 'structure']) {
    dims[key] = Math.round((a.dims[key] + b.dims[key]) / 2);
  }
  return {
    dims,
    total: dims.accuracy + dims.depth + dims.expression + dims.structure,
    comment: b.comment,
    suggestions: b.suggestions,
    followup: null,
  };
}

/** 宽容解析模型返回的项目列表：对象/裸数组/带说明文字都能取到。 */
function parseProjectList(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  let list = [];
  const arrStart = candidate.indexOf('[');
  const arrEnd = candidate.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      const parsed = JSON.parse(candidate.slice(arrStart, arrEnd + 1));
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* fall through */ }
  }
  if (!list.length) {
    const objStart = candidate.indexOf('{');
    const objEnd = candidate.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      try {
        const parsed = JSON.parse(candidate.slice(objStart, objEnd + 1));
        if (Array.isArray(parsed.projects)) list = parsed.projects;
      } catch { /* fall through */ }
    }
  }
  return list.map((p) => String(p).trim()).filter(Boolean).slice(0, 10);
}
