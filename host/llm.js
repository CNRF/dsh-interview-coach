/**
 * Thin wrapper over the host `llm` service: stream a call to completion and
 * collect the text. The route comes from the plugin's own model preference
 * when set, otherwise it falls back to the Harness default selection.
 */
export function createLlmCaller(ctx, options = {}) {
  // 服务懒解析：插件可能先于 llm/agentDefaultModel 激活。
  const llmService = () => ctx.get('llm');
  const defaults = () => ctx.get('agentDefaultModel');
  const preferredRoute = options.route || (() => undefined);

  function currentRoute() {
    const preferred = preferredRoute();
    if (preferred && preferred.provider && preferred.model) return { provider: preferred.provider, model: preferred.model };
    const sel = defaults()?.currentSelection?.();
    if (!sel || !sel.provider || !sel.model) return undefined;
    return { provider: sel.provider, model: sel.model };
  }

  async function callText({ system, prompt, temperature = 0.7, maxTokens = 4096, signal }) {
    const llm = llmService();
    if (!llm) throw new Error('LLM service unavailable in this profile');
    const route = currentRoute();
    if (!route) throw new Error('No default model configured in Harness settings');
    let text = '';
    let failure;
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature,
      maxTokens,
      signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          failure = chunk.reason.failure?.message || `model call ${chunk.reason.kind}`;
        }
      }
    }
    if (failure) throw new Error(failure);
    if (!text.trim()) throw new Error('Model returned an empty response');
    return text.trim();
  }

  /** Ask for a JSON object; tolerate prose around the fenced block. One retry. */
  async function callJSON(options) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await callText({
        ...options,
        prompt: options.prompt + (attempt > 0 ? '\n\n上一次输出不是合法 JSON。请只输出一个 JSON 代码块，不要任何其它文字。' : ''),
      });
      try {
        return parseJSON(text);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Model did not return valid JSON');
  }

  return { callText, callJSON, currentRoute, get available() { return Boolean(llmService()); } };
}

export function parseJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}
