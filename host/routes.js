const MAX_BODY_BYTES = 24 * 1024 * 1024; // WAV audio up to ~12 minutes at 16kHz PCM16

/** Register the plugin's HTTP API on the harness web server. */
export function registerRoutes(webServer, api) {
  return webServer.register({
    kind: 'prefix',
    path: '/api/interview-coach',
    handler: (req, res) => handle(api, req, res).catch((error) => send(res, 500, { error: String(error?.message || error) })),
  });
}

async function handle(api, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const sub = url.pathname.replace(/^\/api\/interview-coach/, '') || '/';
  const method = req.method || 'GET';

  if (method === 'GET' && sub === '/status') return send(res, 200, api.status());
  if (method === 'GET' && sub === '/speech') return send(res, 200, api.speechStatus());
  if (method === 'POST' && sub === '/speech/prepare') {
    const body = await readBody(req);
    return send(res, 200, api.prepareSpeech(body.providerId, body.downloadSource));
  }
  if (method === 'POST' && sub === '/transcribe') {
    const body = await readBody(req);
    return send(res, 200, await api.transcribe(body.audioBase64, body.language));
  }
  if (method === 'GET' && sub === '/tts/voices') return send(res, 200, { voices: api.edgeVoices() });
  if (method === 'POST' && sub === '/tts') {
    const body = await readBody(req);
    const audio = await api.synthesize(body.text, body.voice, body.rate, body.pitch);
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
    res.end(Buffer.from(audio));
    return;
  }
  if (method === 'POST' && sub === '/projects') {
    const body = await readBody(req);
    const result = await api.listProjects(body.referenceDirs, body.debug === true);
    return send(res, 200, Array.isArray(result) ? { projects: result } : result);
  }
  if (method === 'POST' && sub === '/interviews/export') {
    const body = await readBody(req);
    return send(res, 200, { markdown: api.exportMarkdown(body.ids) });
  }
  if (method === 'POST' && sub === '/interviews/bulk-delete') {
    const body = await readBody(req);
    return send(res, 200, api.removeMany(body.ids));
  }
  if (method === 'GET' && sub === '/leetcode') return send(res, 200, api.leetcodeCatalog());
  if (method === 'GET' && sub === '/models') return send(res, 200, await api.listModels());
  if (method === 'GET' && sub === '/settings') return send(res, 200, api.getSettings());
  if (method === 'PUT' && sub === '/settings') {
    const body = await readBody(req);
    return send(res, 200, api.saveSettings(body));
  }
  if (method === 'GET' && sub === '/interviews') return send(res, 200, { items: api.list() });
  if (method === 'POST' && sub === '/interviews') {
    const body = await readBody(req);
    return send(res, 200, await api.create(body));
  }

  const match = sub.match(/^\/interviews\/([a-z0-9-]+)(\/(\w+))?$/i);
  if (match) {
    const [, id, , action] = match;
    if (method === 'GET' && !action) return send(res, 200, api.get(id) || notFound());
    if (method === 'GET' && action === 'markdown') {
      const md = api.exportMarkdown([id]);
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(md);
      return;
    }
    if (method === 'DELETE' && !action) return send(res, 200, api.remove(id));
    if (method === 'POST' && action === 'answer') {
      const body = await readBody(req);
      return send(res, 200, await api.answer(id, body.text));
    }
    if (method === 'POST' && action === 'retry') {
      const body = await readBody(req);
      return send(res, 200, await api.retry(id, body.text));
    }
    if (method === 'POST' && action === 'next') return send(res, 200, await api.next(id));
    if (method === 'POST' && action === 'hint') return send(res, 200, await api.hint(id));
    if (method === 'POST' && action === 'pick') {
      const body = await readBody(req);
      return send(res, 200, await api.pick(id, body.slug));
    }
    if (method === 'POST' && action === 'finish') return send(res, 200, await api.finish(id));
    if (method === 'POST' && action === 'abandon') return send(res, 200, api.abandon(id));
  }
  return send(res, 404, { error: 'not found' });
}

function notFound() {
  const error = new Error('面试不存在');
  error.status = 404;
  throw error;
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}
