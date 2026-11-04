/** Prompt builders for the interviewer persona. All prompts are Chinese-first. */

export const LEVELS = {
  mid: '中级开发工程师（3-5 年）',
  senior: '高级开发工程师（5-8 年）',
  staff: '资深开发工程师（8 年以上）',
  architect: '架构师',
};

export const MODES = {
  mock: '模拟面试',
  fundamentals: '背八股',
  resume: '简历押题',
  scenario: '场景题',
  leetcode: '刷力扣',
};

export const PRACTICE_MODES = new Set(['fundamentals', 'resume', 'scenario', 'leetcode']);

export const STYLES = {
  normal: '常规技术面：循序渐问，氛围友好，给候选人思考空间',
  pressure: '压力面：追问犀利，针对回答漏洞和模糊点穷追猛打，质疑不合理的结论',
  'project-deepdive': '项目深挖面：围绕项目经历持续深挖，追问设计动机、取舍、数据指标的由来',
};

export const FOCUS_LABELS = {
  fundamentals: '基础知识与原理（八股）',
  project: '项目经历深挖',
  system: '系统设计',
};

const NOTE_AUTHORITY = `重要：候选人的参考资料（笔记/简历）只用于了解背景，不作为事实依据。笔记可能存在错误或缺失（例如 MySQL MVCC 等高频考点笔记中可能没有或理解有误）——高频考点即使资料缺失也应正常考察，评分与讲解一律以业界标准答案为准；如果候选人的回答沿用了笔记中的错误理解，要在讲解中指出并纠正。`;

export const LEVEL_DEPTH = {
  mid: '深度约束：以概念理解与常见应用为主，源码级实现细节**较少涉及、点到为止**（偶尔触及关键设计思路即可，不作硬性要求）',
  senior: '深度约束：考察原理机制与生产实践经验，可涉及关键源码的设计思路（为什么这样设计），但不纠结逐行源码细节',
  staff: '深度约束：可深入源码级实现、底层机制与方案权衡（如 AQS 的 CLH 队列、InnoDB 的 MVCC 实现），要求能量化、能权衡',
  architect: '深度约束：聚焦架构权衡、技术演进与组织级影响，源码细节不作硬性要求但需体现驾驭能力',
};

const RUBRIC = `评分维度（每项 0-25 分，总分 100）：
- accuracy（准确性）：技术事实正确，概念不混淆，没有明显错误
- depth（深度）：是否触及底层原理、设计动机、边界情况，而非停留在使用层
- expression（表达）：逻辑清晰、结构化（如先结论后展开）、术语使用恰当
- structure（完整性）：覆盖问题要点，有取舍分析（trade-off）、有实际经验佐证`;

export function selfIntroPrompt() {
  return '请先做一个自我介绍：介绍一下你的基本情况、技术栈和最有代表性的项目经历，时间控制在 2 分钟以内。';
}

export function summarizeReferencePrompt({ fileList, content }) {
  return {
    system: '你是一位技术面试官的助理，负责把候选人的背景资料压缩成面试可用的摘要。',
    prompt: `以下是候选人提供的参考资料（来自其个人笔记/简历文件夹），包含 ${fileList.length} 个文件：${fileList.map((f) => f).join('、')}。

请输出一份 1500 字以内的中文摘要，提取：
1. 候选人的技术栈与熟练程度
2. 项目经历清单：每个项目的名称、角色、技术架构、量化成果
3. 可被深挖的技术亮点与难点
4. 资料中暴露的潜在薄弱点或值得追问的细节
5. **每个项目的关键技术决策点/改造点清单**（如：单体升级微服务、分库分表、引入消息队列、缓存一致性方案等），每个决策点附上可追问的维度：为什么选择这套方案、方案对比与取舍、上线出问题如何回滚、数据一致性怎么保证、拆分边界（如 DDD 限界上下文）怎么划
6. 资料中**缺失的高频面试考点**（按该技术栈的业界面试标准盘点，如 Java 后端的 MySQL MVCC、Redis 持久化等资料中未覆盖的）
7. 资料中**疑似错误或过时理解**的知识点（如有，指出正确结论）

资料原文：
${content}`,
  };
}

export function nextQuestionPrompt({ config, referenceSummary, history }) {
  const historyText = history.length
    ? history.map((h) => `Q: ${h.question}\nA: ${h.answerSummary || h.answer || '（未答）'}`).join('\n\n')
    : '（尚无提问）';
  const focus = config.focus || { fundamentals: 34, project: 33, system: 33 };
  return {
    system: '你是一位严格但公正的资深技术面试官，正在为一场真实的技术面试出题。',
    prompt: `面试配置：
- 技术栈：${config.techStack}
- 目标职级：${LEVELS[config.level] || config.level}
- 面试风格：${STYLES[config.style] || STYLES.normal}
- 考察配比：基础知识 ${focus.fundamentals}% / 项目深挖 ${focus.project}% / 系统设计 ${focus.system}%
${LEVEL_DEPTH[config.level] || ''}
${config.jd ? `- 目标岗位 JD：\n${config.jd.slice(0, 2000)}` : ''}
${referenceSummary ? `\n候选人背景资料摘要：\n${referenceSummary}\n` : ''}
已问过的问题及回答：
${historyText}

${NOTE_AUTHORITY}

请出下一道面试题（第 ${history.length + 1} 题，共 ${config.questionCount} 题）。要求：
1. 难度匹配目标职级「${LEVELS[config.level] || config.level}」的标准
2. 与已问题目不重复、不雷同，按考察配比选题方向
3. 优先结合候选人的项目经历和技术栈提问
4. **一次只问一个聚焦的问题**：不要在一题里罗列 (1)(2)(3) 多个子问题；候选人的技术深度由你在后续追问中逐层考察
5. 题目要具体、有区分度，避免空泛
6. 只输出一个 JSON 代码块：{"question": "题目内容"}，不要其它文字`,
  };
}

export function scoreAnswerPrompt({ config, question, answer, isFollowup, isSelfIntro }) {
  return {
    system: '你是一位严格但公正的资深技术面试官，正在为候选人的回答打分。',
    prompt: `${isSelfIntro ? '这是面试的开场自我介绍环节。' : isFollowup ? '这是对上一回答的追问环节。' : '这是正式面试题的回答。'}

面试技术栈：${config.techStack}；目标职级：${LEVELS[config.level] || config.level}。

${isSelfIntro ? '自我介绍要求' : '题目'}：${question}

候选人的回答（语音转写，可能有少量识别误差，评分时忽略明显的同音错字）：
${answer}

${RUBRIC}

${NOTE_AUTHORITY}

评分标准锚点（以${LEVELS[config.level] || config.level}为基准）：
- 20-25 分档：达到该职级期望，有据有深度
- 15-19 分档：基本达标但深度或完整性不足
- 10-14 分档：部分正确但有明显欠缺
- 0-9 分档：答非所问、严重错误或完全不会

只输出一个 JSON 代码块，字段如下，不要其它文字：
{
  "accuracy": 0-25 的整数,
  "depth": 0-25 的整数,
  "expression": 0-25 的整数,
  "structure": 0-25 的整数,
  "comment": "一句话总评（50 字以内）",
  "suggestions": ["具体改进建议 1", "具体改进建议 2", "具体改进建议 3"],
  "followup": "根据回答的技术深度结合技术栈要求判断：回答只停留在表层、有漏洞、或有值得深挖的点时，给出一个聚焦的追问（同样一次只问一个问题）；回答已足够深入完整或本题已追问过时为 null"
}`,
  };
}

export function finalSummaryPrompt({ config, interview }) {
  const lines = [];
  if (interview.selfIntro) {
    lines.push(`【自我介绍】得分 ${interview.selfIntro.score}\n回答：${interview.selfIntro.answer}\n总评：${interview.selfIntro.comment}`);
  }
  for (const q of interview.questions) {
    lines.push(`【第 ${q.index + 1} 题】${q.question}\n得分 ${q.score ?? '（未答）'}\n回答：${q.answer || '（未答）'}\n总评：${q.comment || ''}`);
  }
  return {
    system: '你是一位资深技术面试官，正在为整场面试写总结评语。',
    prompt: `这是一场${LEVELS[interview.config.level] || ''}级别、${interview.config.techStack}方向的语音面试记录：

${lines.join('\n\n')}

总分：${interview.totalScore}

请输出 300 字以内的面试总结：整体评价、最突出的优点、最需要改进的方向、是否达到目标职级标准的结论。只输出总结正文，不要标题。`,
    _config: config,
  };
}

// ---------- Practice modes (背八股 / 简历押题 / 场景题 / 刷力扣) ----------

export function projectListPrompt({ referenceSummary }) {
  return {
    system: '你是一位技术面试官的助理，负责从候选人背景摘要中提取项目清单。',
    prompt: `以下是候选人的背景资料摘要：

${referenceSummary}

请提取摘要中提到的所有项目/产品名称（只提取明确出现的项目，不要编造）。
只输出一个 JSON 代码块：{"projects": ["项目名1", "项目名2"]}，不要其它文字。如果没有明确项目，输出 {"projects": []}`,
  };
}

export const SCENARIO_ANGLES = [
  '架构设计与技术选型',
  '性能优化与高并发',
  '故障排查与稳定性',
  '数据一致性与事务',
  '容量规划与演进权衡',
  '中间件与存储应用',
  '数据建模与接口设计',
];

export function practiceQuestionPrompt({ config, referenceSummary, history, assignedProject, assignedAngle }) {
  const historyText = history.length
    ? history.map((h) => `Q: ${h.question}`).join('\n')
    : '（尚无提问）';
  const depthGuide = LEVEL_DEPTH[config.level] || '';
  const scenarioIntro = referenceSummary
    ? `场景主题：${config.topic || '综合'}。请从候选人简历的项目经历中挑选一个真实项目，把其中的技术栈与业务场景改编成一道开放式场景题（系统设计/故障排查/性能优化/工程决策），让候选人在自己熟悉的项目背景下展示深度。**题目必须源自简历中的项目背景，禁止编造简历之外的业务场景**（尤其不要默认套用电商秒杀/订单类俗套案例，除非简历里确实有）。**优先围绕该项目的关键技术决策点/改造点出实战场景题**——例如"为什么选这套微服务/分布式方案、方案对比与取舍、上线出问题如何回滚、数据一致性怎么保证、拆分边界怎么划（如 DDD）"，要候选人复盘真实决策而非背概念。${assignedProject ? `**本题必须基于项目「${assignedProject}」出题**${assignedAngle ? `，**考察角度限定为「${assignedAngle}」**` : ''}；候选人该项目下已出过的题见下方历史，场景切入点不得重复。` : ''}${depthGuide}。`
    : `场景主题：${config.topic}。请出一道开放式场景题（系统设计/故障排查/性能优化/工程决策），要求描述具体场景背景，让候选人给出完整方案。**场景必须紧扣主题「${config.topic}」和技术栈「${config.techStack || '通用'}」，且与下方已出过的题的场景背景不重复，禁止默认套用电商秒杀/订单类俗套案例**。${depthGuide}。`;
  const modeIntro = {
    fundamentals: `练习主题：${config.topic}。请围绕该主题出一道**通用高频技术面试题**，考察对核心概念与原理的理解。
要求：只考该技术的通用知识点（如语法、原理、机制、最佳实践），**不要结合候选人的具体项目经历、公司或业务场景**——项目相关的考察属于"场景题 / 简历押题 / 模拟面试"。`,
    resume: `请基于候选人的简历背景和${config.jd ? '目标岗位 JD' : '目标岗位'}，出一道面试中最可能被问到的高概率问题，优先围绕项目经历、技术选型与岗位匹配度。`,
    scenario: scenarioIntro,
  }[config.mode] || '';
  return {
    system: '你是一位资深技术面试官，正在带候选人做针对性练习。',
    prompt: `${modeIntro}
- 技术栈：${config.techStack || '通用'}
- 目标职级：${LEVELS[config.level] || config.level}
${config.jd && config.mode !== 'resume' ? `- 目标岗位 JD：\n${config.jd.slice(0, 1500)}` : ''}
${config.jd && config.mode === 'resume' ? `- 目标岗位 JD：\n${config.jd.slice(0, 1500)}` : ''}
${config.mode === 'fundamentals' ? '' : `${referenceSummary ? `\n候选人背景资料摘要：\n${referenceSummary}\n` : ''}`}
${NOTE_AUTHORITY}

已出过的题（不要重复）：
${historyText}

注意：一次只出一道聚焦的题，不要罗列 (1)(2)(3) 多个子问题。
只输出一个 JSON 代码块：{"question": "题目内容"}，不要其它文字`,
  };
}

/** 用户主动求助时生成参考回答（答题前使用，不影响评分流程）。 */
export function referenceAnswerPrompt({ config, question, problem, language, isSelfIntro }) {
  const isLeetCode = Boolean(problem);
  const level = LEVELS[config.level] || config.level;
  const depth = LEVEL_DEPTH[config.level] || '';
  return {
    system: '你是一位资深技术面试官，候选人答不上来正在向你求助。请给出提纲 + 完整参考答案，深度严格匹配候选人目标职级。',
    prompt: `${isSelfIntro ? '自我介绍环节的要求' : isLeetCode ? `力扣题：${problem.id}. ${problem.title}（${problem.category}，${problem.difficulty}）` : '面试题目'}：${question}

${isLeetCode ? `作答语言：${language || 'Java'}` : `技术栈：${config.techStack || '通用'}；目标职级：${level}`}
${depth}

要求：
1. outline：3-5 个要点提纲，每个要点一行，保留原有的精简风格
2. answer：**完整参考答案**，不是摘要——按上述职级深度充分展开（一般 300-600 字，复杂题可更长）：
   - 先给结论，再分点展开原因与细节
   - 必须包含该职级应有的深度：底层原理、关键机制、边界情况、取舍分析（按上面 depth 约束决定深度，不要超出也不要低于职级）
   - 有数据就说数据（如 QPS、耗时、容量估算），有方案对比就说优缺点
   - 用第一人称"我会/我们"，像候选人在面试中口述
3. pitfalls：常见坑或加分点，一句话

请输出一个 JSON 代码块，不要其它文字：
{
  "outline": "3-5 个要点的答题提纲（每个要点一行，用 \\n 分隔）",
  "answer": "${isLeetCode ? '完整解法：思路 → 可运行代码 → 复杂度分析与边界讨论' : '可直接照着说的完整参考答案（300-600 字，按职级深度展开）'}",
  "pitfalls": "这个问题的常见坑或加分点，一句话"
}`,
  };
}

export function scorePracticePrompt({ config, question, answer, problem, language, isFollowup, followupsDone = 0, maxFollowups = 0 }) {
  const isLeetCode = Boolean(problem);
  const isScenario = config.mode === 'scenario';
  const canFollowup = isScenario && followupsDone < maxFollowups;
  return {
    system: '你是一位资深技术面试官兼导师，为候选人的练习作答打分并讲解。',
    prompt: `${isLeetCode ? `力扣题目：${problem.id}. ${problem.title}（${problem.category}，${problem.difficulty}）
题目链接：https://leetcode.cn/problems/${problem.slug}/
作答语言：${language || '未指定'}

候选人的解题思路与代码：` : `${isFollowup ? '这是对上一回答的场景追问。' : ''}题目：${question}

候选人的回答：`}
${answer}

${isLeetCode ? `评分维度（每项 0-25 分，总分 100）：
- accuracy（正确性）：算法思路正确，边界情况处理到位
- depth（复杂度）：时间/空间复杂度最优或接近最优，能分析权衡
- expression（表达）：思路讲解清晰，代码结构可读
- structure（完整性）：有完整解法、测试用例意识和复杂度分析` : RUBRIC}

${NOTE_AUTHORITY}

只输出一个 JSON 代码块，不要其它文字：
{
  "accuracy": 0-25 的整数,
  "depth": 0-25 的整数,
  "expression": 0-25 的整数,
  "structure": 0-25 的整数,
  "comment": "一句话总评（50 字以内）",
  "suggestions": ["具体改进建议 1", "具体改进建议 2"],
  "explanation": "知识讲解：把这道题考察的知识点讲透，200 字以内${isLeetCode ? '，说明最优解法的核心思路' : ''}",
  "referenceAnswer": "可以直接复述的参考答案${isLeetCode ? `，包含 ${language || 'Java'} 代码实现` : '，150 字以内'}",
  "followup": "${canFollowup ? `场景题追问决策：当前是第 ${followupsDone + 1} 轮回答，目标职级要求追问节奏为「${followupRhythm(config.level)}」。如果回答在深度上还未达到职级期望、方案有明显漏洞或可深挖的权衡点，给出一个聚焦的追问（一次只问一个问题，逐步逼近生产级/架构级深度）；已达到期望深度则给 null` : '本题不追问，固定为 null'}"
}`,
  };
}

export function followupRhythm(level) {
  return {
    mid: '浅尝辄止，最多追问 1 轮确认基本实现能力',
    senior: '适度深挖，最多追问 2 轮，考察生产环境意识',
    staff: '层层递进，最多追问 2 轮，逼到量级估算与权衡分析',
    architect: '穷追猛打，最多追问 3 轮，逼到架构权衡与技术演进',
  }[level] || '适度深挖，最多追问 2 轮';
}

export const MAX_FOLLOWUPS = { mid: 1, senior: 2, staff: 2, architect: 3 };
