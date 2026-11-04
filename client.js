window.__ModuleLoader__.load({
  id: 'dsh-interview-coach',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const API = '/api/interview-coach';
    const PANEL_ID = 'interview-coach';
    const NS = 'dsh-interview-coach';

    // ---------- HTTP ----------
    async function request(path, options = {}) {
      const res = await fetch(API + path, options.body
        ? { method: options.method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }
        : { method: options.method || 'GET' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `请求失败 (${res.status})`);
      return data;
    }

    // ---------- Audio capture: getUserMedia + MediaRecorder → 16kHz mono WAV ----------
    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2);
      const view = new DataView(bytes.buffer);
      const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
      text(0, 'RIFF');
      view.setUint32(4, bytes.length - 8, true);
      text(8, 'WAVE');
      text(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true);
      view.setUint32(28, 32000, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      text(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
      return bytes;
    }

    function audioBase64(bytes) {
      let text = '';
      for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(text);
    }

    function createRecorder() {
      let stream = null;
      let recorder = null;
      let chunks = [];
      return {
        async start() {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          });
          chunks = [];
          recorder = new MediaRecorder(stream);
          recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
          recorder.start();
        },
        async stop() {
          if (!recorder) throw new Error('录音未开始');
          await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
          stream?.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: recorder.mimeType });
          if (!blob.size) throw new Error('没有录到声音');
          const context = new AudioContext();
          try {
            const decoded = await context.decodeAudioData(await blob.arrayBuffer());
            const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(decoded.duration * 16000)), 16000);
            const source = offline.createBufferSource();
            source.buffer = decoded;
            source.connect(offline.destination);
            source.start();
            const resampled = await offline.startRendering();
            return encodeWave(resampled.getChannelData(0));
          } finally {
            context.close();
          }
        },
        cancel() {
          try { recorder?.stop(); } catch { /* noop */ }
          stream?.getTracks().forEach((t) => t.stop());
        },
      };
    }

    // ---------- TTS：系统音色（离线）或 Edge TTS（在线，更自然） ----------
    const ttsConfig = { engine: 'system', voice: '', rate: 0, pitch: 0 };
    let ttsAudio = null;
    let ttsToken = 0;          // 并发令牌：只有最新一次播放请求有效
    let ttsAbort = null;       // Edge TTS 请求的取消器
    let ttsStopCallback = null;

    /** 播放一段语音。onEnd 在播放结束/被取消时回调一次。 */
    async function speak(text, onEnd) {
      const token = ++ttsToken;
      stopSpeakInternal(true);
      if (!text) { onEnd?.(); return; }
      ttsStopCallback = onEnd || null;
      const done = () => { if (token === ttsToken) ttsStopCallback = null; onEnd?.(); };

      if (ttsConfig.engine === 'edge') {
        try {
          ttsAbort = new AbortController();
          const res = await fetch(`${API}/tts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, voice: ttsConfig.voice || undefined, rate: ttsConfig.rate, pitch: ttsConfig.pitch }),
            signal: ttsAbort.signal,
          });
          if (!res.ok) throw new Error('edge tts failed');
          const blob = await res.blob();
          if (token !== ttsToken) return; // 已被新的播放请求取代
          const audio = new Audio(URL.createObjectURL(blob));
          ttsAudio = audio;
          audio.onended = () => { if (ttsAudio === audio) { URL.revokeObjectURL(audio.src); ttsAudio = null; } done(); };
          audio.onerror = () => { URL.revokeObjectURL(audio.src); ttsAudio = null; done(); };
          await audio.play();
          return;
        } catch {
          if (token !== ttsToken) return;
          /* 回退系统音色 */
        }
      }
      try {
        if (token !== ttsToken) return;
        speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'zh-CN';
        const voices = speechSynthesis.getVoices();
        const chosen = ttsConfig.voice && voices.find((v) => v.name === ttsConfig.voice);
        utter.voice = chosen || voices.find((v) => /zh|中文|Chinese/i.test(v.lang + v.name)) || null;
        utter.rate = Math.max(0.5, Math.min(2, 1 + (ttsConfig.rate || 0) / 100));
        utter.pitch = Math.max(0, Math.min(2, 1 + (ttsConfig.pitch || 0) / 100));
        utter.onend = done;
        utter.onerror = done;
        speechSynthesis.speak(utter);
      } catch { /* TTS unavailable */ }
    }

    function stopSpeak() {
      ttsToken++;
      stopSpeakInternal();
    }

    function stopSpeakInternal(notify) {
      try { ttsAbort?.abort(); } catch { /* noop */ }
      ttsAbort = null;
      try { speechSynthesis.cancel(); } catch { /* noop */ }
      if (ttsAudio) { try { ttsAudio.pause(); URL.revokeObjectURL(ttsAudio.src); } catch { /* noop */ } ttsAudio = null; }
      const cb = ttsStopCallback;
      ttsStopCallback = null;
      if (notify && cb) cb();
    }

    // ---------- Styles (theme tokens only) ----------
    const css = {
      shell: { height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', color: 'var(--dsw-alias-label-primary)', colorScheme: 'light dark' },
      tabbar: { display: 'flex', gap: 10, padding: '14px 28px 0', flex: '0 0 auto' },
      scroll: { flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0 },
      page: { padding: '18px 28px 32px', maxWidth: 900, margin: '0 auto', fontSize: 14, lineHeight: 1.6 },
      card: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 16, marginBottom: 14 },
      title: { fontSize: 20, fontWeight: 600, marginBottom: 4 },
      label: { display: 'block', marginBottom: 6, fontWeight: 500 },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 14 },
      // 主按钮用「品牌色描边+品牌色文字+淡品牌底色」，任何主题下对比度都安全
      // （纯色填充+白字在亮色品牌色主题下会看不清字）。
      btn: { padding: '8px 18px', borderRadius: 8, border: '1px solid var(--dsw-alias-brand-primary)', background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent)', color: 'var(--dsw-alias-brand-primary)', fontSize: 14, cursor: 'pointer', fontWeight: 600 },
      btnGhost: { padding: '8px 18px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 14, cursor: 'pointer' },
      btnDanger: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-error-primary)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, cursor: 'pointer' },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      scoreBig: { fontSize: 42, fontWeight: 700, color: 'var(--dsw-alias-brand-primary)' },
      tag: { display: 'inline-block', padding: '2px 8px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)', fontSize: 12, marginRight: 6 },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 13 },
      warn: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 13 },
      prompt: { fontSize: 17, fontWeight: 600, lineHeight: 1.75, whiteSpace: 'pre-wrap' },
      modeCard: { flex: '1 1 150px', minWidth: 140, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer', textAlign: 'left', color: 'var(--dsw-alias-label-primary)', position: 'relative' },
      modeCardActive: { borderColor: 'var(--dsw-alias-brand-primary)', boxShadow: '0 0 0 1px var(--dsw-alias-brand-primary)' },
      pre: { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 12, overflowX: 'auto' },
    };

    const MODE_DEFS = [
      { id: 'mock', name: '模拟面试', desc: '完整流程：自我介绍 → 出题 → 追问 → 打分，不提供答案' },
      { id: 'fundamentals', name: '背八股', desc: '围绕一个主题刷高频题，作答后给讲解和参考答案' },
      { id: 'resume', name: '简历押题', desc: '基于简历/JD 押高概率题，作答后给评分与讲解' },
      { id: 'scenario', name: '场景题', desc: '系统设计、故障排查等开放式场景演练' },
      { id: 'leetcode', name: '刷力扣', desc: 'Hot 100 抽题，思路 + 代码 + 复杂度分析' },
    ];
    const MODE_NAMES = Object.fromEntries(MODE_DEFS.map((m) => [m.id, m.name]));
    const DIFF_STYLE = {
      easy: { label: '简单', color: 'var(--dsw-alias-state-success-primary)' },
      medium: { label: '中等', color: 'var(--dsw-alias-state-warn-primary)' },
      hard: { label: '困难', color: 'var(--dsw-alias-state-error-primary)' },
    };

    function Field({ label, hint, children }) {
      return h('div', { style: { marginBottom: 14 } },
        h('label', { style: css.label }, label),
        children,
        hint ? h('div', { style: css.hint }, hint) : null);
    }

    function DirPicker({ label, value, onChange, uiWorkspace, multiple }) {
      const [manual, setManual] = useState(false);
      const values = multiple ? value : [value].filter(Boolean);
      const pick = async () => {
        try {
          const dir = await uiWorkspace?.pickDirectory?.();
          if (!dir) return;
          if (multiple) onChange([...new Set([...value, dir])]);
          else onChange(dir);
        } catch { setManual(true); }
      };
      return h(Field, { label },
        values.map((dir) => h('div', { key: dir, style: { ...css.row, marginBottom: 6 } },
          h('code', { style: { fontSize: 12, flex: 1, wordBreak: 'break-all' } }, dir),
          h('button', { style: css.btnDanger, onClick: () => onChange(multiple ? value.filter((d) => d !== dir) : '') }, '移除'))),
        h('div', { style: css.row },
          uiWorkspace?.pickDirectory ? h('button', { style: css.btnGhost, onClick: pick }, '选择文件夹') : null,
          h('button', { style: { ...css.btnGhost, padding: '8px 12px' }, onClick: () => setManual(!manual) }, '手动输入')),
        manual ? h('input', {
          style: { ...css.input, marginTop: 8 },
          placeholder: '/Users/you/notes/简历',
          onKeyDown: (e) => {
            if (e.key === 'Enter' && e.target.value.trim()) {
              const v = e.target.value.trim();
              if (multiple) onChange([...new Set([...value, v])]); else onChange(v);
              e.target.value = '';
            }
          },
        }) : null);
    }

    // ---------- Self-check banner ----------
    function SelfCheck({ status, speech, onPrepare }) {
      if (!status) return null;
      const items = [];
      items.push(status.llm.available
        ? { ok: true, text: `模型连接正常（${status.llm.provider}/${status.llm.model}）` }
        : { ok: false, text: '未检测到可用的模型连接，请先在 Harness 设置中配置默认模型' });
      if (!status.speech.available) {
        items.push({ ok: false, text: '语音服务未启用：请在插件管理中启用官方「Voice Input」插件包（本地 SenseVoice 语音识别）' });
      } else {
        const provider = speech?.providers?.find((p) => p.id === speech.selection?.providerId) || speech?.providers?.[0];
        const phase = provider?.preparation?.phase;
        if (!provider) items.push({ ok: false, text: '没有可用的语音识别提供方' });
        else if (['ready', 'standby', 'waking'].includes(phase)) items.push({ ok: true, text: `语音识别就绪（${provider.name}）` });
        else if (phase === 'downloading') {
          const d = provider.preparation;
          const pct = d.totalBytes ? Math.round((d.completedBytes / d.totalBytes) * 100) : null;
          items.push({ ok: 'warn', text: `语音运行时下载中${pct != null ? ` ${pct}%` : '…'}` });
        } else if (['checking', 'loading'].includes(phase)) items.push({ ok: 'warn', text: '语音运行时准备中…' });
        else items.push({
          ok: false,
          text: `语音识别未就绪（${provider.name}，首次使用需下载本地运行时）`,
          action: h('button', { style: { ...css.btn, marginLeft: 8 }, onClick: () => onPrepare(provider) }, '下载并准备'),
        });
      }
      const blocking = items.some((i) => i.ok === false);
      return h('div', { style: { ...css.card, borderColor: blocking ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)' } },
        h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '运行环境自检'),
        items.map((item, i) => h('div', { key: i, style: item.ok === true ? css.ok : item.ok === 'warn' ? css.warn : css.error },
          `${item.ok === true ? '✓ ' : item.ok === 'warn' ? '… ' : '✕ '}${item.text}`, item.action || null)));
    }

    // ---------- TTS 设置 ----------
    function TtsSettings() {
      const [open, setOpen] = useState(false);
      const [engine, setEngine] = useState(ttsConfig.engine);
      const [voice, setVoice] = useState(ttsConfig.voice);
      const [rate, setRate] = useState(ttsConfig.rate);
      const [pitch, setPitch] = useState(ttsConfig.pitch);
      const [edgeVoices, setEdgeVoices] = useState([]);
      const [sysVoices, setSysVoices] = useState([]);
      const [testing, setTesting] = useState(false);

      useEffect(() => {
        if (!open) return;
        const loadSys = () => {
          try { setSysVoices(speechSynthesis.getVoices().filter((v) => /zh|中文|Chinese/i.test(v.lang + v.name))); } catch { /* noop */ }
        };
        loadSys();
        speechSynthesis.onvoiceschanged = loadSys;
        request('/tts/voices').then((d) => setEdgeVoices(d.voices || [])).catch(() => {});
      }, [open]);

      const apply = (patch) => {
        Object.assign(ttsConfig, patch);
        fetch(`${API}/settings`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ttsEngine: ttsConfig.engine, ttsVoice: ttsConfig.voice, ttsRate: ttsConfig.rate, ttsPitch: ttsConfig.pitch }),
        }).catch(() => {});
      };

      const voices = engine === 'edge' ? edgeVoices : sysVoices.map((v) => ({ id: v.name, name: v.name }));
      const currentVoiceName = engine === 'edge'
        ? (edgeVoices.find((v) => v.id === voice)?.name || '默认（云健）')
        : (voice || '自动选择');

      return h('div', { style: css.card },
        h('div', { style: { ...css.row, cursor: 'pointer' }, onClick: () => setOpen(!open) },
          h('div', { style: { fontWeight: 600 } }, '面试官音色'),
          h('span', { style: css.hint }, `${engine === 'edge' ? 'Edge TTS 在线' : '系统'} · ${currentVoiceName} · 语速 ${rate > 0 ? '+' : ''}${rate}%`),
          h('span', { style: { marginLeft: 'auto', ...css.hint } }, open ? '▾ 收起' : '▸ 展开')),
        open ? h('div', { style: { marginTop: 12 } },
          h(Field, { label: '音色来源', hint: 'Edge TTS 音色更自然，但需要联网；接口为非官方渠道，失败时自动回退系统音色' },
            h('select', { style: css.input, value: engine, onChange: (e) => { setEngine(e.target.value); setVoice(''); apply({ engine: e.target.value, voice: '' }); } },
              h('option', { value: 'system' }, '系统音色（离线）'),
              h('option', { value: 'edge' }, 'Edge TTS 在线音色（更自然）'))),
          h(Field, { label: '音色' },
            h('select', { style: css.input, value: voice, onChange: (e) => { setVoice(e.target.value); apply({ voice: e.target.value }); } },
              h('option', { value: '' }, engine === 'edge' ? '默认（云健，男声）' : '自动选择'),
              voices.map((v) => h('option', { key: v.id, value: v.id }, v.name)))),
          h('div', { style: { display: 'flex', gap: 14 } },
            h('div', { style: { flex: 1 } }, h(Field, { label: `语速：${rate > 0 ? '+' : ''}${rate}%` },
              h('input', { type: 'range', min: -30, max: 30, value: rate, style: { width: '100%' }, onChange: (e) => { const v = Number(e.target.value); setRate(v); apply({ rate: v }); } }))),
            h('div', { style: { flex: 1 } }, h(Field, { label: `语调：${pitch > 0 ? '+' : ''}${pitch}%` },
              h('input', { type: 'range', min: -20, max: 20, value: pitch, style: { width: '100%' }, onChange: (e) => { const v = Number(e.target.value); setPitch(v); apply({ pitch: v }); } })))),
          h('button', {
            style: css.btnGhost, disabled: testing,
            onClick: async () => { setTesting(true); await speak('你好，我是今天的面试官。请先做一个自我介绍，控制在两分钟以内。'); setTesting(false); },
          }, testing ? '合成中…' : '🔊 试听')) : null);
    }

    // ---------- 面试模型选择 ----------
    function ModelPicker({ value, onChange }) {
      const [open, setOpen] = useState(false);
      const [catalog, setCatalog] = useState(null);
      const [loadError, setLoadError] = useState('');
      const [busy, setBusy] = useState(false);
      const [query, setQuery] = useState('');

      const load = useCallback(() => {
        setBusy(true);
        setLoadError('');
        request('/models')
          .then(setCatalog)
          .catch((e) => setLoadError(e.message || '加载失败'))
          .finally(() => setBusy(false));
      }, []);

      useEffect(() => { if (open && !catalog) load(); }, [open]);

      const defaultLabel = catalog?.default
        ? `跟随 Harness 默认（${catalog.default.provider} / ${catalog.default.model}）`
        : '跟随 Harness 默认';
      const currentLabel = value.provider
        ? `${value.provider} / ${value.model || '（未选模型）'}`
        : defaultLabel;

      // 扁平模型清单 + 模糊查询（模型过多时纯下拉无法选）
      const allModels = (catalog?.providers || []).flatMap((p) =>
        p.models.map((m) => ({ provider: p.id, providerName: p.name, id: m.id, name: m.name || m.id })));
      const q = query.trim().toLowerCase();
      const matched = (q
        ? allModels.filter((m) => `${m.provider} ${m.providerName} ${m.id} ${m.name}`.toLowerCase().includes(q))
        : allModels).slice(0, 200);
      const isCurrent = (m) => m.provider === value.provider && m.id === value.model;

      return h('div', { style: css.card },
        h('div', { style: { ...css.row, cursor: 'pointer' }, onClick: () => setOpen(!open) },
          h('div', { style: { fontWeight: 600 } }, '面试模型'),
          h('span', { style: css.hint }, currentLabel),
          h('span', { style: { marginLeft: 'auto', ...css.hint } }, open ? '▾ 收起' : '▸ 展开')),
        open ? h('div', { style: { marginTop: 12 } },
          loadError ? h('div', { style: { ...css.error, marginBottom: 8 } },
            `模型列表加载失败：${loadError}`,
            /404/.test(loadError) ? h('div', { style: { ...css.hint, marginTop: 4 } }, '宿主插件可能是旧代码：请在插件管理中关闭再开启本插件，然后刷新页面') : null,
            h('button', { style: { ...css.btnGhost, padding: '4px 10px', marginLeft: 8, fontSize: 12 }, onClick: load }, '重试')) : null,
          busy && !catalog ? h('div', { style: css.hint }, '正在读取 DSH 可用模型…') : null,
          catalog ? h(React.Fragment, null,
            h(Field, { label: '选择具体模型', hint: `支持模糊查询：输入 provider、模型名或 id 过滤（共 ${allModels.length} 个模型）` },
              h('input', {
                style: css.input,
                placeholder: '搜索模型，如 k3 / glm / deepseek / magpie …',
                value: query,
                onChange: (e) => setQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Escape') setQuery('');
                  if (e.key === 'Enter' && matched.length) {
                    const first = matched[0];
                    onChange({ provider: first.provider, model: first.id });
                    setQuery('');
                  }
                },
              }),
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 } },
                h('button', {
                  style: { ...css.btnGhost, padding: '4px 10px', fontSize: 12 },
                  onClick: () => { onChange({ provider: '', model: '' }); setQuery(''); },
                }, '跟随 Harness 默认'),
                h('span', { style: css.hint }, value.provider ? `已选：${currentLabel}` : defaultLabel)),
              h('div', {
                style: {
                  maxHeight: 240, overflowY: 'auto', marginTop: 8,
                  border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8,
                },
              },
                matched.length
                  ? matched.map((m) => h('button', {
                      key: `${m.provider}::${m.id}`,
                      style: {
                        display: 'flex', width: '100%', gap: 8, alignItems: 'center',
                        padding: '6px 10px', border: 'none', textAlign: 'left', cursor: 'pointer',
                        background: isCurrent(m) ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent)' : 'transparent',
                        color: 'var(--dsw-alias-label-primary)', fontSize: 13,
                      },
                      onClick: () => { onChange({ provider: m.provider, model: m.id }); setQuery(''); },
                    },
                      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        `${m.name}${m.name !== m.id ? ` · ${m.id}` : ''}`),
                      h('span', { style: { ...css.hint, flex: '0 0 auto' } }, m.provider)))
                  : h('div', { style: { padding: '10px 12px', ...css.hint } },
                      query ? `没有匹配「${query}」的模型` : '没有可选的模型'))),
            h('div', { style: { ...css.hint, marginTop: 8 } }, '修改后立即生效于后续出题、评分与总结；选「跟随 Harness 默认」恢复默认模型'),
            h(Field, { label: '手动指定（可选）', hint: '列表里没有的模型可直接填：先填 provider，再填模型 id' },
              h('div', { style: css.row },
                h('input', {
                  style: { ...css.input, width: 200 }, placeholder: 'provider',
                  defaultValue: value.provider || '',
                  onBlur: (e) => { const v = e.target.value.trim(); if (v !== value.provider) onChange({ provider: v, model: value.model || '' }); },
                }),
                h('input', {
                  style: { ...css.input, width: 200 }, placeholder: 'model id',
                  defaultValue: value.model || '',
                  onBlur: (e) => { const v = e.target.value.trim(); if (v !== value.model) onChange({ provider: value.provider, model: v }); },
                })))) : null) : null);
    }

    // ---------- Setup form ----------
    function Setup({ uiWorkspace, status, speech, onRefreshStatus, onStart, resumeInterview }) {
      const [mode, setMode] = useState('mock');
      const [topic, setTopic] = useState('');
      const [language, setLanguage] = useState('java');
      const [techStack, setTechStack] = useState('');
      const [level, setLevel] = useState('staff');
      const [questionCount, setQuestionCount] = useState(10);
      const [style, setStyle] = useState('normal');
      const [jd, setJd] = useState('');
      const [focus, setFocus] = useState({ fundamentals: 34, project: 33, system: 33 });
      const [referenceDirs, setReferenceDirs] = useState([]);
      const [outputDir, setOutputDir] = useState('');
      const [fixedProject, setFixedProject] = useState('');
      const [refProjects, setRefProjects] = useState([]);
      const [projectsBusy, setProjectsBusy] = useState(false);
      const [sceneCustom, setSceneCustom] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [projectsError, setProjectsError] = useState('');
      const [llmRoute, setLlmRoute] = useState({ provider: '', model: '' });
      const modeTouched = useRef(false);
      const [projectsReloadKey, setProjectsReloadKey] = useState(0);
      const parsedSig = useRef('');

      // 参考文件夹变化时自动解析一次项目清单；失败只报原因、不自动重试，
      // 由用户点击「重新解析」手动触发（避免反复请求和不明所以的失败）。
      useEffect(() => {
        if (mode !== 'scenario' || !referenceDirs.length) {
          setRefProjects([]); setProjectsError(''); parsedSig.current = ''; return;
        }
        const sig = referenceDirs.join('|');
        if (parsedSig.current === sig) return; // 已解析过（成功或失败），不再自动尝试
        parsedSig.current = sig;
        setProjectsBusy(true);
        setProjectsError('');
        const timer = setTimeout(() => {
          request('/projects', { body: { referenceDirs } })
            .then((d) => {
              const list = d.projects || [];
              setRefProjects(list);
              if (!list.length) setProjectsError('参考资料里没有识别到明确的项目名称（可能需要更完整的项目经历描述，或改用「手动输入场景」）');
            })
            .catch((e) => { setRefProjects([]); setProjectsError(e.message || '解析失败'); })
            .finally(() => setProjectsBusy(false));
        }, 600);
        return () => clearTimeout(timer);
      }, [mode, referenceDirs, projectsReloadKey]);

      const persistSettings = (patch) => {
        fetch(API + '/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {});
      };

      const chooseMode = (id, e) => {
        modeTouched.current = true;
        setMode(id);
        persistSettings({ mode: id });
        e?.currentTarget?.blur();
      };

      // 通用选择持久化：技术栈/参考目录/输出目录等一次设置、各模式共用；
      // 任何模式下改了新值，即成为新的通用选择。用户已手动切换过模式时不再用存档覆盖。
      useEffect(() => {
        request('/settings').then((s) => {
          if (s.mode && !modeTouched.current) setMode(s.mode);
          if (s.topic) setTopic(s.topic);
          if (s.language) setLanguage(s.language);
          if (s.techStack) setTechStack(s.techStack);
          if (s.level) setLevel(s.level);
          if (s.questionCount) setQuestionCount(s.questionCount);
          if (s.style) setStyle(s.style);
          if (s.jd) setJd(s.jd);
          if (s.focus) setFocus(s.focus);
          if (Array.isArray(s.referenceDirs)) setReferenceDirs(s.referenceDirs);
          if (s.outputDir) setOutputDir(s.outputDir);
          setLlmRoute({ provider: s.llmProvider || '', model: s.llmModel || '' });
        }).catch(() => {});
      }, []);

      const start = async () => {
        setError('');
        if (mode === 'fundamentals' && !topic.trim()) return setError('请填写练习主题');
        if (mode === 'scenario' && !topic.trim() && !referenceDirs.length) return setError('请填写场景主题，或选择简历/项目参考文件夹');
        if (mode !== 'fundamentals' && mode !== 'scenario' && !techStack.trim()) return setError('请填写技术栈');
        if (!outputDir) return setError('请选择输出目录');
        setBusy(true);
        try {
          const config = { mode, topic, language, techStack, level, questionCount, style, jd, focus, referenceDirs, outputDir, fixedProject };
          const interview = await request('/interviews', { body: config });
          fetch(API + '/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) }).catch(() => {});
          onStart(interview);
        } catch (e) { setError(e.message); } finally { setBusy(false); }
      };

      const slider = (key, label) => h(Field, { label: `${label}：${focus[key]}%` },
        h('input', {
          type: 'range', min: 0, max: 100, value: focus[key], style: { width: '100%' },
          onChange: (e) => setFocus({ ...focus, [key]: Number(e.target.value) }),
        }));

      const levelField = h(Field, { label: '目标职级' },
        h('select', { style: css.input, value: level, onChange: (e) => setLevel(e.target.value) },
          h('option', { value: 'mid' }, '中级（3-5 年）'),
          h('option', { value: 'senior' }, '高级（5-8 年）'),
          h('option', { value: 'staff' }, '资深（8 年以上）'),
          h('option', { value: 'architect' }, '架构师')));
      const countField = h(Field, { label: '题量', hint: '只控制问题数量；问题深度由目标职级决定' },
        h('select', { style: css.input, value: questionCount, onChange: (e) => setQuestionCount(Number(e.target.value)) },
          h('option', { value: 5 }, '5 题（约 15 分钟）'),
          h('option', { value: 10 }, '10 题（约 30 分钟）'),
          h('option', { value: 15 }, '15 题（约 45 分钟）')));
      const outputField = h(DirPicker, { label: '输出目录（必选，记录与报告存放处）', value: outputDir, onChange: setOutputDir, uiWorkspace, multiple: false });

      const formByMode = () => {
        if (mode === 'leetcode') {
          return h(React.Fragment, null,
            h(Field, { label: '编程语言' },
              h('select', { style: css.input, value: language, onChange: (e) => setLanguage(e.target.value) },
                h('option', { value: 'java' }, 'Java'),
                h('option', { value: 'python' }, 'Python'),
                h('option', { value: 'go' }, 'Go'),
                h('option', { value: 'cpp' }, 'C++'),
                h('option', { value: 'javascript' }, 'JavaScript'),
                h('option', { value: 'typescript' }, 'TypeScript'))),
            outputField);
        }
        if (mode === 'scenario') {
          return h(React.Fragment, null,
            h(DirPicker, { label: '简历/项目参考文件夹（选了之后可下拉选择项目场景）', value: referenceDirs, onChange: (d) => { setReferenceDirs(d); setFixedProject(''); }, uiWorkspace, multiple: true }),
            referenceDirs.length ? h(Field, { label: '场景来源', hint: projectsBusy ? '正在从简历中提取项目清单（首次解析要做资料摘要，可能需要一两分钟）…' : refProjects.length ? '自动轮换会从各项目轮流出题，角度不重复' : undefined },
              h('select', {
                style: css.input,
                value: sceneCustom ? '__custom' : fixedProject || '',
                onChange: (e) => {
                  if (e.target.value === '__custom') { setSceneCustom(true); setFixedProject(''); }
                  else { setSceneCustom(false); setFixedProject(e.target.value); }
                },
              },
                h('option', { value: '' }, '自动轮换各项目（推荐）'),
                refProjects.map((p) => h('option', { key: p, value: p }, `项目：${p}`)),
                h('option', { value: '__custom' }, '手动输入场景…')),
              projectsError ? h('div', { style: { ...css.error, marginTop: 8 } },
                `项目解析失败：${projectsError}`,
                h('div', { style: { ...css.hint, marginTop: 4 } }, '不会自动重试，可修正文件夹后手动重新解析，或直接选「手动输入场景」')) : null,
              h('div', { style: { ...css.row, marginTop: 6 } },
                !projectsBusy && !refProjects.length
                  ? h('button', {
                      style: { ...css.btnGhost, padding: '4px 12px', fontSize: 12 },
                      onClick: () => { parsedSig.current = ''; setProjectsReloadKey((k) => k + 1); },
                    }, projectsError ? '↻ 重新解析项目清单' : '▶ 解析项目清单')
                  : null),
              !sceneCustom && refProjects.length ? h('div', { style: { ...css.hint, marginTop: 8 } },
                fixedProject
                  ? `本场将围绕「${fixedProject}」从多个考察角度深挖（架构选型 → 性能并发 → 故障排查 → 数据一致性 → 演进权衡…）`
                  : `本场将依次覆盖：${refProjects.map((p) => `「${p}」`).join('、')}，每个项目一个考察角度，循环推进`) : null)
              : null,
            (sceneCustom || !referenceDirs.length) ? h(Field, { label: '场景主题', hint: '如：设计秒杀系统、线上接口变慢排查；选了参考文件夹后可留空' },
              h('input', { style: css.input, value: topic, onChange: (e) => setTopic(e.target.value) })) : null,
            h(Field, { label: '技术栈（可选）' }, h('input', { style: css.input, placeholder: '如：Java 后端', value: techStack, onChange: (e) => setTechStack(e.target.value) })),
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              h('div', { style: { flex: 1, minWidth: 160 } }, levelField),
              h('div', { style: { flex: 1, minWidth: 160 } }, countField)),
            h('div', { style: { ...css.hint, marginBottom: 14 } }, '职级决定问题深度与追问节奏：中级≈实现层（最多1轮追问）→ 架构师≈架构权衡（最多3轮追问）'),
            outputField);
        }
        if (mode === 'fundamentals') {
          return h(React.Fragment, null,
            h(Field, { label: '练习主题', hint: '如：Java 并发、JVM、MySQL、Redis、Spring、计算机网络' },
              h('input', { style: css.input, value: topic, onChange: (e) => setTopic(e.target.value) })),
            h(Field, { label: '技术栈（可选）' }, h('input', { style: css.input, placeholder: '如：Java 后端', value: techStack, onChange: (e) => setTechStack(e.target.value) })),
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              h('div', { style: { flex: 1, minWidth: 160 } }, levelField),
              h('div', { style: { flex: 1, minWidth: 160 } }, countField)),
            outputField);
        }
        if (mode === 'resume') {
          return h(React.Fragment, null,
            h(Field, { label: '技术栈' }, h('input', { style: css.input, placeholder: '如：Java 后端', value: techStack, onChange: (e) => setTechStack(e.target.value) })),
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              h('div', { style: { flex: 1, minWidth: 160 } }, levelField),
              h('div', { style: { flex: 1, minWidth: 160 } }, countField)),
            h(Field, { label: '目标岗位 JD（可选）' },
              h('textarea', { style: { ...css.input, minHeight: 90, resize: 'vertical' }, placeholder: '粘贴目标岗位 JD，押题更精准', value: jd, onChange: (e) => setJd(e.target.value) })),
            h(DirPicker, { label: '简历/笔记参考文件夹（押题强烈建议选）', value: referenceDirs, onChange: setReferenceDirs, uiWorkspace, multiple: true }),
            outputField);
        }
        // mock
        return h(React.Fragment, null,
          h(Field, { label: '技术栈' }, h('input', { style: css.input, placeholder: '如：Java 后端 / Python / 前端 React', value: techStack, onChange: (e) => setTechStack(e.target.value) })),
          h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
            h('div', { style: { flex: 1, minWidth: 160 } }, levelField),
            h('div', { style: { flex: 1, minWidth: 160 } }, countField),
            h('div', { style: { flex: 1, minWidth: 160 } }, h(Field, { label: '面试风格' },
              h('select', { style: css.input, value: style, onChange: (e) => setStyle(e.target.value) },
                h('option', { value: 'normal' }, '常规技术面'),
                h('option', { value: 'pressure' }, '压力面'),
                h('option', { value: 'project-deepdive' }, '项目深挖面'))))),
          h(Field, { label: '考察配比', hint: '三个方向的出题占比，按比例归一' },
            slider('fundamentals', '基础知识与原理'),
            slider('project', '项目经历深挖'),
            slider('system', '系统设计')),
          h(Field, { label: '目标岗位 JD（可选）' },
            h('textarea', { style: { ...css.input, minHeight: 90, resize: 'vertical' }, placeholder: '粘贴目标岗位 JD，题目会对齐岗位要求', value: jd, onChange: (e) => setJd(e.target.value) })),
          h(DirPicker, { label: '参考文件夹（可选，可多选）', value: referenceDirs, onChange: setReferenceDirs, uiWorkspace, multiple: true }),
          h('div', { style: css.hint }, '选择你的简历/笔记所在文件夹，面试前会预摘要为出题参考；不选则仅按技术栈出题'),
          h('div', { style: { height: 10 } }),
          outputField);
      };

      return h('div', { style: css.page },
        h('div', { style: css.title }, '语音面试助手'),
        h('div', { style: { ...css.hint, marginBottom: 16 } }, '语音作答、逐题百分制打分、讲解与参考答案、自动生成面试记录文档'),
        h(SelfCheck, { status, speech, onPrepare: async (provider) => { await request('/speech/prepare', { body: { providerId: provider.id, downloadSource: provider.downloadSources?.[1] || provider.downloadSources?.[0] } }); setTimeout(onRefreshStatus, 1500); } }),
        h(ModelPicker, {
          value: llmRoute,
          onChange: (next) => {
            setLlmRoute(next);
            persistSettings({ llmProvider: next.provider || null, llmModel: next.model || null });
          },
        }),
        h(TtsSettings, null),
        resumeInterview ? h('div', { style: css.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '有一场未完成的练习'),
          h('div', { style: css.hint }, `${MODE_NAMES[resumeInterview.mode] || '模拟面试'} · ${resumeInterview.topic || resumeInterview.techStack} · ${resumeInterview.answered} 题已答 · ${resumeInterview.createdAt.slice(0, 16).replace('T', ' ')}`),
          h('div', { style: { ...css.row, marginTop: 10 } },
            h('button', { style: css.btn, onClick: () => onStart({ id: resumeInterview.id, resume: true }) }, '继续'),
            h('button', { style: css.btnDanger, onClick: async () => { await request(`/interviews/${resumeInterview.id}/abandon`, { body: {} }); onRefreshStatus(); } }, '作废'))) : null,
        h('div', { style: css.card },
          h(Field, { label: '练习模式' },
            h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
              MODE_DEFS.map((m) => h('button', {
                key: m.id,
                style: { ...css.modeCard, ...(mode === m.id ? css.modeCardActive : {}), outline: 'none' },
                onClick: (e) => chooseMode(m.id, e),
              },
                mode === m.id ? h('span', { style: { position: 'absolute', top: 8, right: 10, color: 'var(--dsw-alias-brand-primary)', fontWeight: 700 } }, '✓') : null,
                h('div', { style: { fontWeight: 600, marginBottom: 4, color: 'var(--dsw-alias-label-primary)' } }, m.name),
                h('div', { style: css.hint }, m.desc))))),
          formByMode(),
          error ? h('div', { style: { ...css.error, marginTop: 8 } }, error) : null,
          h('div', { style: { marginTop: 14 } },
            h('button', { style: { ...css.btn, opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: start },
              busy ? '准备中（资料摘要可能需要一分钟）…' : mode === 'mock' ? '开始面试' : '开始练习'))));
    }

    // ---------- Score rail: 10 blocks colored by score ----------
    function ScoreRail({ score }) {
      const filled = Math.round((score ?? 0) / 10);
      const color = score >= 80 ? 'var(--dsw-alias-state-success-primary)' : score >= 60 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)';
      return h('span', { style: { display: 'inline-grid', gridTemplateColumns: 'repeat(10, 8px)', gap: 3, verticalAlign: 'middle' } },
        Array.from({ length: 10 }, (_, i) => h('i', {
          key: i,
          style: { display: 'block', height: 15, borderRadius: 2, background: i < filled ? color : 'var(--dsw-alias-bg-layer-2)' },
        })));
    }

    // ---------- Score card ----------
    function ScoreCard({ scored, title }) {
      if (!scored) return null;
      const dims = scored.dims || scored;
      const total = scored.total ?? scored.score;
      return h('div', { style: { ...css.card, borderColor: 'var(--dsw-alias-brand-primary)' } },
        h('div', { style: css.row },
          title ? h('div', { style: { fontWeight: 600 } }, title) : null,
          h('div', { style: { marginLeft: 'auto', ...css.row, gap: 12 } },
            h(ScoreRail, { score: total }),
            h('div', { style: { fontSize: 24, fontWeight: 700, color: total >= 80 ? 'var(--dsw-alias-state-success-primary)' : total >= 60 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)' } }, `${total} 分`))),
        h('div', { style: { ...css.row, marginTop: 6 } },
          h('span', { style: css.tag }, `准确性 ${dims.accuracy}/25`),
          h('span', { style: css.tag }, `深度 ${dims.depth}/25`),
          h('span', { style: css.tag }, `表达 ${dims.expression}/25`),
          h('span', { style: css.tag }, `完整性 ${dims.structure}/25`)),
        scored.comment ? h('div', { style: { marginTop: 8 } }, scored.comment) : null,
        scored.suggestions?.length ? h('ul', { style: { margin: '8px 0 0', paddingLeft: 18 } },
          scored.suggestions.map((s, i) => h('li', { key: i }, s))) : null);
    }

    // ---------- Collapsible section ----------
    function Collapsible({ label, children, code }) {
      const [open, setOpen] = useState(false);
      return h('div', { style: { marginTop: 10 } },
        h('button', { style: css.btnGhost, onClick: () => setOpen(!open) }, `${open ? '▾' : '▸'} ${label}`),
        open ? (code ? h('pre', { style: { ...css.pre, marginTop: 8 } }, children) : h('div', { style: { marginTop: 8, whiteSpace: 'pre-wrap' } }, children)) : null);
    }

    // ---------- LeetCode picker ----------
    function LeetCodePicker({ done, onPick, busy }) {
      const [catalog, setCatalog] = useState(null);
      const [filter, setFilter] = useState('');
      useEffect(() => { request('/leetcode').then(setCatalog).catch(() => {}); }, []);
      if (!catalog) return h('div', { style: css.card }, '题库加载中…');
      const doneSlugs = new Set(done || []);
      const groups = catalog.groups
        .map((g) => ({ ...g, problems: g.problems.filter((p) => !filter || p.title.includes(filter) || p.id.includes(filter)) }))
        .filter((g) => g.problems.length);
      return h('div', { style: css.card },
        h('div', { style: { ...css.row, marginBottom: 10 } },
          h('div', { style: { fontWeight: 600 } }, `选择下一题（${catalog.source.name}）`),
          h('input', { style: { ...css.input, width: 200, marginLeft: 'auto' }, placeholder: '搜索题号/题名', value: filter, onChange: (e) => setFilter(e.target.value) })),
        groups.map((g) => h('div', { key: g.category, style: { marginBottom: 12 } },
          h('div', { style: { ...css.hint, marginBottom: 6, fontWeight: 600 } }, g.category),
          g.problems.map((p) => {
            const isDone = doneSlugs.has(p.slug);
            const diff = DIFF_STYLE[p.difficulty] || DIFF_STYLE.medium;
            return h('div', { key: p.slug, style: { ...css.row, padding: '4px 0', opacity: isDone ? 0.45 : 1 } },
              h('code', { style: { fontSize: 11, width: 34, textAlign: 'right', color: 'var(--dsw-alias-label-secondary)' } }, p.id),
              h('button', {
                style: { border: 'none', background: 'none', padding: 0, cursor: isDone || busy ? 'default' : 'pointer', color: 'var(--dsw-alias-label-primary)', fontSize: 13, flex: 1, textAlign: 'left' },
                disabled: isDone || busy,
                onClick: () => onPick(p.slug),
              }, `${p.title}${isDone ? ' ✓' : ''}`),
              h('span', { style: { fontSize: 11, color: diff.color } }, diff.label),
              h('a', { href: p.url, target: '_blank', rel: 'noreferrer', style: { fontSize: 11, color: 'var(--dsw-alias-brand-primary)' } }, '原题'));
          }))));
    }

    // ---------- Attempts comparison ----------
    function AttemptsList({ attempts }) {
      if (!attempts || attempts.length < 2) return null;
      return h('div', { style: { marginTop: 10 } },
        h('div', { style: { ...css.hint, fontWeight: 600, marginBottom: 6 } }, `多次作答对比（${attempts.length} 次）`),
        attempts.map((a, i) => h('div', { key: i, style: { borderLeft: '3px solid var(--dsw-alias-brand-primary)', padding: '8px 12px', marginBottom: 8, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '0 8px 8px 0' } },
          h('div', { style: css.row },
            h('span', { style: css.hint }, `第 ${i + 1} 次 · ${(a.at || '').slice(5, 16).replace('T', ' ')}`),
            h('span', { style: { marginLeft: 'auto', fontWeight: 600 } }, `${a.scored?.total ?? '-'} 分`),
            h(ScoreRail, { score: a.scored?.total ?? 0 })),
          h('div', { style: { fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap' } }, a.answer))));
    }

    // ---------- Interview / practice room ----------
    function Room({ interviewId, onExit }) {
      const [interview, setInterview] = useState(null);
      const [recording, setRecording] = useState(false);
      const [busy, setBusy] = useState(false);
      const [draft, setDraft] = useState('');
      const [error, setError] = useState('');
      const [autoSpeak, setAutoSpeak] = useState(true);
      const [speaking, setSpeaking] = useState(false);
      const [retrying, setRetrying] = useState(false);
      const recorderRef = useRef(null);
      const spokenRef = useRef('');
      const [hint, setHint] = useState(null);
      const [hintOpen, setHintOpen] = useState(false);
      const [hintBusy, setHintBusy] = useState(false);

      const refresh = useCallback(async () => {
        const iv = await request(`/interviews/${interviewId}`);
        setInterview(iv);
        return iv;
      }, [interviewId]);

      useEffect(() => { refresh().catch((e) => setError(e.message)); }, []);
      useEffect(() => () => { stopSpeak(); recorderRef.current?.cancel(); }, []);

      const playPrompt = useCallback((text) => {
        if (!text) return;
        // 先发起新的播放（内部会同步取消旧播放并触发旧回调），再置为播放中，
        // 避免旧回调把新播放的状态误置为未播放。
        speak(text, () => setSpeaking(false));
        setSpeaking(true);
      }, []);

      const toggleSpeak = useCallback((text) => {
        if (speaking) { stopSpeak(); setSpeaking(false); return; }
        playPrompt(text);
      }, [speaking, playPrompt]);

      // 参考回答：只有主动点击才生成/展示，按题缓存
      const toggleHint = useCallback(async () => {
        if (hint && hintOpen) { setHintOpen(false); return; }
        if (hint) { setHintOpen(true); return; }
        setHintBusy(true);
        try {
          const h0 = await request(`/interviews/${interviewId}/hint`, { body: {} });
          setHint(h0);
          setHintOpen(true);
        } catch (e) { setError(e.message); } finally { setHintBusy(false); }
      }, [hint, hintOpen, interviewId]);

      useEffect(() => {
        setHint(null);
        setHintOpen(false);
      }, [interview?.currentPrompt]);

      useEffect(() => {
        const prompt = interview?.currentPrompt;
        if (prompt && autoSpeak && spokenRef.current !== prompt && interview?.stage !== 'review') {
          spokenRef.current = prompt;
          playPrompt(prompt);
        }
      }, [interview?.currentPrompt, autoSpeak]);

      if (!interview) return h('div', { style: css.page }, error ? h('div', { style: css.error }, error) : '加载中…');
      if (interview.status === 'completed') return h(Report, { interview, onExit });

      const isMock = interview.mode === 'mock';
      const total = interview.config.questionCount;
      const index = interview.currentQuestionIndex;
      const stage = interview.stage;
      const stageLabel = stage === 'selfintro' ? '自我介绍'
        : stage === 'followup' ? `第 ${index + 1} 题 · 追问`
        : stage === 'picking' ? '选题'
        : stage === 'review' ? `第 ${index + 1} 题 · 点评`
        : isMock ? `第 ${index + 1} / ${total} 题` : `第 ${index + 1} 题`;

      const startRecording = async () => {
        setError('');
        try {
          stopSpeak();
          const rec = createRecorder();
          recorderRef.current = rec;
          await rec.start();
          setRecording(true);
        } catch {
          setError('无法使用麦克风：请检查浏览器麦克风权限后重试');
        }
      };

      const stopAndTranscribe = async () => {
        setRecording(false);
        setBusy(true);
        try {
          const wav = await recorderRef.current.stop();
          const { text } = await request('/transcribe', { body: { audioBase64: audioBase64(wav), language: 'zh' } });
          setDraft((d) => (d ? d + '\n' : '') + text);
        } catch (e) { setError(e.message); } finally { setBusy(false); }
      };

      const submitAnswer = async (retry) => {
        if (!draft.trim()) return setError('请先录音或手动输入回答');
        setBusy(true);
        setError('');
        try {
          const result = await request(`/interviews/${interviewId}/${retry ? 'retry' : 'answer'}`, { body: { text: draft.trim() } });
          setDraft('');
          setRetrying(false);
          setInterview(result.next ?? result);
          const next = result.next ?? result;
          if (next.status === 'in-progress' && next.stage === 'done') {
            const finished = await request(`/interviews/${interviewId}/finish`, { body: {} });
            setInterview(finished);
          }
        } catch (e) { setError(e.message); } finally { setBusy(false); }
      };

      const nextQuestion = async () => {
        setBusy(true);
        setError('');
        try {
          const next = await request(`/interviews/${interviewId}/next`, { body: {} });
          if (next.status === 'in-progress' && next.stage === 'done') {
            const finished = await request(`/interviews/${interviewId}/finish`, { body: {} });
            setInterview(finished);
          } else {
            setInterview(next);
          }
        } catch (e) { setError(e.message); } finally { setBusy(false); }
      };

      const finishEarly = async () => {
        setBusy(true);
        try {
          const finished = await request(`/interviews/${interviewId}/finish`, { body: {} });
          setInterview(finished);
        } catch (e) { setError(e.message); } finally { setBusy(false); }
      };

      const currentQuestion = interview.currentQuestion;
      const answering = stage === 'question' || stage === 'selfintro' || stage === 'followup' || retrying;

      const answerCard = h('div', { style: css.card },
        h('div', { style: { ...css.hint, marginBottom: 6 } }, retrying ? '重新作答（录音转写后可编辑）' : '你的回答（录音转写后可编辑，再提交评分）'),
        h('textarea', {
          style: { ...css.input, minHeight: 120, resize: 'vertical', fontFamily: interview.mode === 'leetcode' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit' },
          placeholder: recording ? '录音中…说完后点击「回答完毕」' : interview.mode === 'leetcode' ? '写解题思路 + 代码，或先录音讲思路' : '点击「开始回答」录音，或手动输入',
          value: draft,
          onChange: (e) => setDraft(e.target.value),
        }),
        error ? h('div', { style: { ...css.error, marginTop: 6 } }, error) : null,
        h('div', { style: { ...css.row, marginTop: 10 } },
          recording
            ? h('button', { style: { ...css.btn, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent)' }, onClick: stopAndTranscribe }, '■ 回答完毕')
            : h('button', { style: css.btn, disabled: busy, onClick: startRecording }, '🎙 开始回答'),
          busy ? h('span', { style: css.hint }, '处理中（转写/评分可能需要几十秒）…') : null,
          retrying ? h('button', { style: css.btnGhost, onClick: () => { setRetrying(false); setDraft(''); } }, '取消重答') : null,
          h('button', { style: { ...css.btn, marginLeft: 'auto' }, disabled: busy || recording, onClick: () => submitAnswer(retrying) }, retrying ? '提交重答' : '提交回答')));

      const reviewCard = stage === 'review' && currentQuestion?.scored ? h('div', null,
        h(ScoreCard, { scored: { ...currentQuestion.scored, total: currentQuestion.score }, title: '本题得分' }),
        h('div', { style: css.card },
          currentQuestion.scored.explanation ? h(Collapsible, { label: '知识讲解' }, currentQuestion.scored.explanation) : null,
          currentQuestion.scored.referenceAnswer ? h(Collapsible, { label: '参考答案', code: interview.mode === 'leetcode' }, currentQuestion.scored.referenceAnswer) : null,
          h(AttemptsList, { attempts: currentQuestion.attempts }),
          h('div', { style: { ...css.row, marginTop: 14 } },
            h('button', { style: css.btnGhost, disabled: busy, onClick: () => { setRetrying(true); setDraft(''); } }, '重新作答'),
            h('button', { style: css.btn, disabled: busy, onClick: nextQuestion }, interview.mode === 'leetcode' ? '选下一题' : '下一题')))) : null;

      return h('div', { style: css.page },
        h('div', { style: css.row },
          h('div', { style: css.title }, `${MODE_NAMES[interview.mode] || '模拟面试'} · ${stageLabel}`),
          h('div', { style: { marginLeft: 'auto' } },
            h('label', { style: { ...css.hint, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: autoSpeak, onChange: (e) => setAutoSpeak(e.target.checked) }), ' 自动朗读题目'))),
        isMock ? h('div', { style: { height: 8, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 4, margin: '8px 0 16px' } },
          h('div', { style: { height: 8, borderRadius: 4, background: 'var(--dsw-alias-brand-primary)', width: `${Math.min(100, (index / total) * 100)}%` } })) : h('div', { style: { height: 8 } }),
        stage === 'picking'
          ? h(LeetCodePicker, {
              done: (interview.questions || []).map((q) => q.problem?.slug).filter(Boolean),
              busy,
              onPick: async (slug) => {
                setBusy(true);
                try { setInterview(await request(`/interviews/${interviewId}/pick`, { body: { slug } })); }
                catch (e) { setError(e.message); } finally { setBusy(false); }
              },
            })
          : h(React.Fragment, null,
              stage !== 'review' || retrying ? h('div', { style: css.card },
                h('div', { style: { ...css.hint, marginBottom: 6 } },
                  '面试官',
                  currentQuestion?.project ? h('span', { style: { ...css.tag, marginLeft: 8 } }, `项目：${currentQuestion.project}`) : null,
                  currentQuestion?.angle ? h('span', { style: css.tag }, currentQuestion.angle) : null),
                h('div', { style: css.prompt }, interview.currentPrompt || currentQuestion?.question || '…'),
                currentQuestion?.problem ? h('div', { style: { marginTop: 6 } },
                  h('a', { href: currentQuestion.problem.url, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-brand-primary)', fontSize: 13 } }, '查看力扣原题 →')) : null,
                h('div', { style: { marginTop: 8, ...css.row } },
                  h('button', {
                    style: speaking ? { ...css.btnGhost, color: 'var(--dsw-alias-state-warn-primary)', borderColor: 'var(--dsw-alias-state-warn-primary)' } : css.btnGhost,
                    onClick: () => toggleSpeak(interview.currentPrompt || currentQuestion?.question || ''),
                  }, speaking ? '⏹ 停止' : '🔊 重播'),
                  h('button', {
                    style: hintOpen ? { ...css.btnGhost, color: 'var(--dsw-alias-state-warn-primary)', borderColor: 'var(--dsw-alias-state-warn-primary)' } : css.btnGhost,
                    disabled: hintBusy,
                    onClick: toggleHint,
                  }, hintBusy ? '生成中…' : hintOpen ? '收起参考回答' : '💡 参考回答'),
                  h('span', { style: css.hint }, hintOpen ? '查看参考不影响本题评分' : '答不上来时再点，按每题缓存'))) : null,
              hintOpen && hint ? h('div', { style: { ...css.card, borderColor: 'var(--dsw-alias-state-warn-primary)' } },
                h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '参考回答（答不上来时参考，评分为你的实际回答）'),
                hint.outline ? h('div', { style: { marginBottom: 8 } },
                  h('div', { style: { ...css.hint, fontWeight: 600 } }, '答题提纲'),
                  h('div', { style: { whiteSpace: 'pre-wrap' } }, hint.outline)) : null,
                h('div', { style: { whiteSpace: 'pre-wrap' } }, hint.answer),
                hint.pitfalls ? h('div', { style: { ...css.hint, marginTop: 8 } }, `💡 ${hint.pitfalls}`) : null) : null,
              stage === 'review' && !retrying ? reviewCard : null,
              answering && stage !== 'review' ? answerCard : null,
              retrying ? answerCard : null),
        h('div', { style: css.row },
          h('button', { style: css.btnGhost, disabled: busy, onClick: finishEarly }, isMock ? '结束面试并生成报告' : '结束练习并生成报告'),
          h('button', { style: css.btnGhost, onClick: onExit }, '暂离（进度已保存）')));
    }

    // ---------- Report ----------
    function Report({ interview, onExit }) {
      const q = interview.questions || [];
      return h('div', { style: css.page },
        h('div', { style: css.title }, `${MODE_NAMES[interview.mode] || '模拟面试'}报告`),
        h('div', { style: { ...css.card, textAlign: 'center' } },
          h('div', { style: css.scoreBig }, `${interview.totalScore ?? '-'}`),
          h('div', { style: css.hint }, '总分 / 100')),
        interview.summary ? h('div', { style: css.card }, h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '总结'), interview.summary) : null,
        interview.reportDir ? h('div', { style: css.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '记录文档已生成'),
          h('code', { style: { fontSize: 12, wordBreak: 'break-all' } }, interview.reportDir),
          h('div', { style: { ...css.hint, marginTop: 6 } }, '包含 面试记录.md、面试记录.docx、scores.json、transcript.md')) : null,
        interview.selfIntro ? h(ScoreCard, { scored: interview.selfIntro, title: '自我介绍' }) : null,
        q.map((item) => h('div', { key: item.index }, h(ScoreCard, { scored: item.scored ? { ...item.scored, total: item.score } : null, title: `第 ${item.index + 1} 题：${item.question.slice(0, 40)}${item.question.length > 40 ? '…' : ''}` }),
          h('div', { style: { ...css.card, marginTop: -8 } },
            h(AttemptsList, { attempts: item.attempts }),
            item.scored?.explanation ? h(Collapsible, { label: '知识讲解' }, item.scored.explanation) : null,
            item.scored?.referenceAnswer ? h(Collapsible, { label: '参考答案', code: Boolean(item.problem) }, item.scored.referenceAnswer) : null))),
        h('button', { style: css.btn, onClick: onExit }, '返回'));
    }

    // ---------- History ----------
    function History({ onResume, refreshKey }) {
      const [items, setItems] = useState([]);
      useEffect(() => { request('/interviews').then((d) => setItems(d.items || [])).catch(() => {}); }, [refreshKey]);
      const completed = items.filter((i) => i.status === 'completed' && i.totalScore != null).slice().reverse();

      const exportItem = async (id) => {
        const data = await request(`/interviews/${id}`);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `interview-${id}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      };

      const trend = completed.length >= 2 ? (() => {
        const w = 520, hgt = 120, pad = 20;
        const stepX = (w - pad * 2) / Math.max(1, completed.length - 1);
        const points = completed.map((i, idx) => `${pad + idx * stepX},${hgt - pad - (i.totalScore / 100) * (hgt - pad * 2)}`).join(' ');
        return h('svg', { viewBox: `0 0 ${w} ${hgt}`, style: { width: '100%', height: 120 } },
          h('polyline', { points, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2 }),
          completed.map((i, idx) => h('circle', {
            key: i.id, cx: pad + idx * stepX, cy: hgt - pad - (i.totalScore / 100) * (hgt - pad * 2), r: 4,
            fill: 'var(--dsw-alias-brand-primary)',
          }, h('title', {}, `${i.techStack || i.topic} ${i.totalScore}分`))));
      })() : null;

      return h('div', { style: css.page },
        h('div', { style: css.title }, '历史记录'),
        trend ? h('div', { style: css.card }, h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '得分趋势'), trend)
          : h('div', { style: css.card }, h('div', { style: css.hint }, '完成两场以上练习后展示得分趋势')),
        items.length === 0 ? h('div', { style: css.card }, '还没有记录') : null,
        items.map((i) => h('div', { key: i.id, style: { ...css.card, ...css.row } },
          h('div', { style: { flex: 1 } },
            h('div', { style: { fontWeight: 600 } },
              h('span', { style: css.tag }, MODE_NAMES[i.mode] || '模拟面试'),
              `${i.topic || i.techStack} · ${i.totalScore != null ? `${i.totalScore} 分` : i.status === 'in-progress' ? '进行中' : '已作废'}`),
            h('div', { style: css.hint }, `${i.createdAt.slice(0, 16).replace('T', ' ')} · ${i.answered}/${i.questionCount} 题`)),
          i.status === 'in-progress' ? h('button', { style: css.btn, onClick: () => onResume(i.id) }, '继续') : null,
          h('button', { style: css.btnGhost, onClick: () => exportItem(i.id) }, '导出'),
          h('button', { style: css.btnDanger, onClick: async () => { await request(`/interviews/${i.id}`, { method: 'DELETE' }); setItems(items.filter((x) => x.id !== i.id)); } }, '删除'))));
    }

    // ---------- Root panel ----------
    function Panel(props) {
      const t = props.t || ((k) => k);
      const uiWorkspace = props.uiWorkspace;
      const [view, setView] = useState('setup');
      const [status, setStatus] = useState(null);
      const [speech, setSpeech] = useState(null);
      const [activeId, setActiveId] = useState(null);
      const [resumable, setResumable] = useState(null);
      const [refreshKey, setRefreshKey] = useState(0);

      const refreshStatus = useCallback(async () => {
        try {
          setStatus(await request('/status'));
          setSpeech(await request('/speech'));
          const { items } = await request('/interviews');
          setResumable((items || []).find((i) => i.status === 'in-progress') || null);
        } catch { /* server not ready */ }
      }, []);

      useEffect(() => {
        refreshStatus();
        // 加载 TTS 偏好（直接进入面试间时也要生效）
        request('/settings').then((s) => {
          ttsConfig.engine = s.ttsEngine || 'system';
          ttsConfig.voice = s.ttsVoice || '';
          ttsConfig.rate = Number(s.ttsRate) || 0;
          ttsConfig.pitch = Number(s.ttsPitch) || 0;
        }).catch(() => {});
        const timer = setInterval(refreshStatus, 5000);
        return () => clearInterval(timer);
      }, []);

      const startInterview = (iv) => {
        setActiveId(iv.id);
        setView('room');
      };

      if (view === 'room' && activeId) {
        return h('div', { style: css.shell },
          h('div', { style: css.scroll },
            h(Room, {
              interviewId: activeId,
              onExit: () => { setView('setup'); setActiveId(null); refreshStatus(); },
            })));
      }

      return h('div', { style: css.shell },
        h('div', { style: css.tabbar },
          h('button', { style: { ...(view === 'setup' ? css.btn : css.btnGhost), outline: 'none' }, onClick: (e) => { setView('setup'); e.currentTarget.blur(); } }, '新建'),
          h('button', { style: { ...(view === 'history' ? css.btn : css.btnGhost), outline: 'none' }, onClick: (e) => { setView('history'); e.currentTarget.blur(); } }, '历史记录')),
        h('div', { style: css.scroll },
          view === 'setup'
            ? h(Setup, { uiWorkspace, status, speech, onRefreshStatus: refreshStatus, onStart: startInterview, resumeInterview: resumable })
            : h(History, { onResume: (id) => { setActiveId(id); setView('room'); }, refreshKey })));
    }

    function MicIcon({ size = 16 }) {
      return h('svg', { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true },
        h('rect', { x: 27, y: 12, width: 10, height: 24, rx: 5, fill: 'currentColor' }),
        h('path', { d: 'M20 32 a12 12 0 0 0 24 0', fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round' }),
        h('line', { x1: 32, y1: 44, x2: 32, y2: 52, stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round' }));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale ? ctx.locale.bind(NS) : (k) => k;
        let uiWorkspace;
        try {
          // Optional client service: native directory picker.
          ctx.inject(['uiWorkspace'], (scoped) => { uiWorkspace = scoped.uiWorkspace; });
        } catch { /* picker unavailable; manual path input remains */ }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
          inject: () => ({ t, uiWorkspace }),
        }, (ownerProps) => h(Panel, { t, uiWorkspace })));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS,
          label: () => '面试助手',
        }, (owner = {}) => h(MicIcon, { size: owner.size ?? 16 })));
      },
    };
  },
});
