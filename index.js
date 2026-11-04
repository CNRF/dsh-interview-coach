import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { InterviewStore } from './host/store.js';
import { createLlmCaller } from './host/llm.js';
import { InterviewEngine } from './host/engine.js';
import { writeReport } from './host/report.js';
import { registerRoutes } from './host/routes.js';
import { LEETCODE_TOP_100_GROUPS, LEETCODE_TOP_100_SOURCE } from './host/leetcode.js';
import { edgeTts, EDGE_VOICES } from './host/edge-tts.js';

export function apply(ctx) {
  // 数据目录固定为用户级 ~/.dsh/dsh-interview-coach（可用 DSH_INTERVIEW_COACH_HOME 覆盖），
  // 不随 profile/端口/应用重启漂移，避免历史记录和通用设置"看似丢失"。
  const root = process.env.DSH_INTERVIEW_COACH_HOME || path.join(os.homedir(), '.dsh', 'dsh-interview-coach');
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  const store = new InterviewStore(root);

  // User defaults shared across all modes: set once, reused everywhere; saving
  // from any mode updates the shared default.
  const settingsFile = path.join(root, 'settings.json');
  const SETTINGS_KEYS = ['mode', 'topic', 'language', 'techStack', 'level', 'questionCount', 'style', 'jd', 'focus', 'referenceDirs', 'outputDir', 'ttsEngine', 'ttsVoice', 'ttsRate', 'ttsPitch', 'llmProvider', 'llmModel'];
  const readSettings = () => {
    try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; }
  };
  const writeSettings = (patch) => {
    const current = readSettings();
    for (const key of SETTINGS_KEYS) {
      if (patch[key] !== undefined) current[key] = patch[key];
    }
    fs.writeFileSync(settingsFile, JSON.stringify(current, null, 2));
    return current;
  };

  // 插件自有模型偏好（空 = 跟随 Harness 默认模型）
  const llm = createLlmCaller(ctx, {
    route: () => {
      const s = readSettings();
      if (s.llmProvider && s.llmModel) return { provider: s.llmProvider, model: s.llmModel };
      return undefined;
    },
  });
  const engine = new InterviewEngine({ store, llm, cacheDir: path.join(root, 'cache') });

  // 模型目录：枚举当前 DSH 已注册的 provider 与其模型，短时缓存避免频繁查询
  let modelCache = null;
  let modelCacheAt = 0;
  async function listModels() {
    if (modelCache && Date.now() - modelCacheAt < 60 * 1000) return modelCache;
    const service = ctx.get('llm');
    const providers = [];
    if (service) {
      for (const provider of service.listProviders()) {
        let models = [];
        try {
          models = (await service.listModels(provider.id)).map((m) => ({ id: m.id, name: m.name || m.id }));
        } catch { /* provider 无模型目录时跳过 */ }
        providers.push({ id: provider.id, name: provider.name || provider.id, models });
      }
    }
    const defaultSel = ctx.get('agentDefaultModel')?.currentSelection?.();
    modelCache = {
      providers,
      default: defaultSel ? { provider: defaultSel.provider, model: defaultSel.model } : null,
      selected: (() => {
        const s = readSettings();
        return s.llmProvider && s.llmModel ? { provider: s.llmProvider, model: s.llmModel } : null;
      })(),
    };
    modelCacheAt = Date.now();
    return modelCache;
  }

  const speech = () => ctx.get('speechToText');

  const api = {
    status() {
      const route = llm.currentRoute();
      const speechSnap = speech()?.snapshot();
      return {
        llm: { available: llm.available && Boolean(route), provider: route?.provider ?? null, model: route?.model ?? null },
        speech: speechSnap
          ? { available: true, providers: speechSnap.providers.map(providerView), selection: speechSnap.selection }
          : { available: false, providers: [], selection: null },
      };
    },
    speechStatus() {
      const snap = speech()?.snapshot();
      if (!snap) return { available: false, providers: [], selection: null };
      return { available: true, providers: snap.providers.map(providerView), selection: snap.selection };
    },
    prepareSpeech(providerId, downloadSource) {
      const service = speech();
      if (!service) throw new Error('语音服务不可用：请先在插件管理中启用「Voice Input」插件包');
      if (!providerId) throw new Error('缺少 providerId');
      service.prepare(providerId, downloadSource ? { downloadSource } : undefined);
      return { started: true };
    },
    async transcribe(audioBase64, language) {
      const service = speech();
      if (!service) throw new Error('语音服务不可用：请先在插件管理中启用「Voice Input」插件包');
      if (!audioBase64) throw new Error('缺少音频数据');
      const audio = Buffer.from(String(audioBase64), 'base64');
      if (!audio.length) throw new Error('音频数据为空');
      const spec = service.resolve({ audio: new Uint8Array(audio), language: language || 'zh' });
      const transcript = await service.transcribe(spec, new AbortController().signal);
      return { text: transcript.text };
    },
    list: () => engine.list(),
    getSettings: () => readSettings(),
    saveSettings: (patch) => {
      const saved = writeSettings(patch && typeof patch === 'object' ? patch : {});
      modelCache = null;
      return saved;
    },
    listModels: () => listModels(),
    get: (id) => engine.get(id) ? engine.view(engine.get(id)) : undefined,
    create: (config) => engine.create(config),
    answer: (id, text) => engine.answer(id, text),
    hint: (id) => engine.referenceAnswer(id),
    retry: (id, text) => engine.retry(id, text),
    next: (id) => engine.next(id),
    pick: (id, slug) => engine.pick(id, slug),
    leetcodeCatalog: () => ({ groups: LEETCODE_TOP_100_GROUPS, source: LEETCODE_TOP_100_SOURCE }),
    listProjects: (dirs) => engine.listReferenceProjects(Array.isArray(dirs) ? dirs : []),
    edgeVoices: () => EDGE_VOICES,
    synthesize: (text, voice, rate, pitch) => edgeTts({
      text,
      voice: EDGE_VOICES.some((v) => v.id === voice) ? voice : EDGE_VOICES[0].id,
      rate: Math.max(-50, Math.min(100, Number(rate) || 0)),
      pitch: Math.max(-50, Math.min(50, Number(pitch) || 0)),
    }),
    finish: (id) => engine.finish(id, writeReport),
    abandon: (id) => engine.abandon(id),
    remove: (id) => (engine.remove(id), { removed: true }),
  };

  const webServer = ctx.get('webServer');
  if (webServer) {
    ctx.effect(() => registerRoutes(webServer, api));
  } else {
    // 启动竞态：插件可能先于 webServer 激活，此时 ctx.get 拿不到服务。
    // ctx.inject 会在服务就绪后回调，保证路由一定注册上。
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => registerRoutes(scoped.webServer, api));
    });
  }
}

function providerView(p) {
  return {
    id: p.id,
    name: p.name,
    location: p.location,
    languages: p.languages,
    preparation: p.preparation,
    setupEstimate: p.setupEstimate ?? null,
    downloadSources: p.downloadSources ?? [],
  };
}
