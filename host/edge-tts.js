import crypto from 'node:crypto';
import WebSocket from 'ws';

/**
 * Edge TTS（微软大声朗读）免费在线语音合成。
 * 非官方接口：协议可能变动，失败时调用方回退到系统音色。
 * Sec-MS-GEC v2 令牌算法移植自 MsEdgeTTS（MIT），感谢 Migushthe2nd 与
 * rany2/edge-tts#492 的协议分析：
 * https://github.com/Migushthe2nd/MsEdgeTTS
 */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.96';
const GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const WIN_EPOCH = 11644473600;

export const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女声，温暖）' },
  { id: 'zh-CN-YunjianNeural', name: '云健（男声，浑厚）' },
  { id: 'zh-CN-YunxiNeural', name: '云希（男声，清亮）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女声，轻快）' },
  { id: 'zh-CN-YunyangNeural', name: '云扬（男声，新闻播报）' },
  { id: 'zh-CN-XiaochenNeural', name: '晓辰（女声，沉稳）' },
];

// ---- Sec-MS-GEC v2（移植自 MsEdgeTTS dist/SecMsGec.js，MIT）----

const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.';
const SWAP_FIRST_WORD = { swappedWord: 0xEF0569FB, swappedSum: 0x76F50F34, swappedProduct: 0xC3EFEA97 };
const SWAP_SECOND_WORD = { swappedWord: 0xC31713DB, swappedSum: 0x1881CE3C, swappedProduct: 0x35BD1EC9 };
const MIX_FIRST_WORD = [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83];
const MIX_SECOND_WORD = [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69];

function swapHalves(value) {
  return ((value << 16) | (value >>> 16)) >>> 0;
}

function swapTerm(word, key, multipliers) {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), multipliers.swappedWord);
  const product = Math.imul(swapHalves(sum), multipliers.swappedSum) >>> 0;
  return (Math.imul(swapHalves(product), multipliers.swappedProduct) + product) >>> 0;
}

function swapAndMultiply(value, multipliers) {
  for (const multiplier of multipliers) {
    value = Math.imul(swapHalves(value), multiplier) >>> 0;
  }
  return value;
}

function toUpperHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function cs64(message, digest) {
  const firstKey = (digest.readUInt32LE(0) | 1) >>> 0;
  const secondKey = (digest.readUInt32LE(4) | 1) >>> 0;
  const padded = Buffer.alloc(Math.ceil(message.length / 8) * 8);
  message.copy(padded);
  let swapSum = 0;
  let lastSwap = 0;
  let mix = 0;
  let mixSum = 0;
  for (let offset = 0; offset < padded.length; offset += 8) {
    const firstWord = padded.readUInt32LE(offset);
    const secondWord = padded.readUInt32LE(offset + 4);
    const firstSwap = swapTerm(firstWord, firstKey, SWAP_FIRST_WORD);
    lastSwap = swapTerm(secondWord, secondKey, SWAP_SECOND_WORD);
    swapSum = (swapSum + firstSwap + lastSwap) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + firstWord, firstKey), MIX_FIRST_WORD);
    mixSum = (mixSum + mix) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + secondWord, secondKey), MIX_SECOND_WORD);
    mixSum = (mixSum + mix) >>> 0;
  }
  const checksum = Buffer.alloc(8);
  checksum.writeUInt32LE((lastSwap ^ mix) >>> 0, 0);
  checksum.writeUInt32LE((swapSum ^ mixSum) >>> 0, 4);
  return checksum;
}

function secMsGecV2() {
  let ticks = Date.now() / 1000 + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const ticksAndToken = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  const message = Buffer.concat([Buffer.from(EDGE_COPYRIGHT, 'utf8'), Buffer.from(ticksAndToken, 'ascii')]);
  const digest = crypto.createHash('sha256').update(message).digest();
  return `${toUpperHex(cs64(message, digest))}-${digest.toString('hex').toUpperCase()}`;
}

// ---- 合成 ----

function connectionId() {
  return crypto.randomBytes(16).toString('hex');
}

function escapeSsml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 合成一段中文语音，返回 mp3 字节。超时或协议失败抛错。 */
export async function edgeTts({ text, voice = 'zh-CN-YunjianNeural', rate = 0, pitch = 0, timeoutMs = 20000 }) {
  if (!text || !String(text).trim()) throw new Error('缺少合成文本');
  const clipped = String(text).slice(0, 2000);
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGecV2()}&Sec-MS-GEC-Version=${encodeURIComponent(GEC_VERSION)}&ConnectionId=${connectionId()}`;

  const ws = new WebSocket(url, {
    headers: {
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0`,
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const audioChunks = [];
  let done = false;
  let failed = null;

  const finish = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch { /* noop */ } reject(new Error('Edge TTS 超时')); }, timeoutMs);
    ws.on('open', () => {
      const now = new Date().toISOString();
      ws.send(`X-Timestamp:${now}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: OUTPUT_FORMAT } } } }));
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">`
        + `<voice name="${voice}"><prosody rate="${rate >= 0 ? '+' : ''}${rate}%" pitch="${pitch >= 0 ? '+' : ''}${pitch}%">${escapeSsml(clipped)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${connectionId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${now}\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const textMsg = data.toString('utf8');
        if (textMsg.includes('Path:turn.end')) { done = true; clearTimeout(timer); ws.close(); resolve(); }
        return;
      }
      // 二进制帧：前 2 字节是头部长度
      const bytes = new Uint8Array(data);
      if (bytes.length < 2) return;
      const headerLen = (bytes[0] << 8) | bytes[1];
      const header = new TextDecoder().decode(bytes.subarray(2, 2 + headerLen));
      if (header.includes('Path:audio')) audioChunks.push(bytes.subarray(2 + headerLen));
    });
    ws.on('error', (err) => { clearTimeout(timer); failed = err instanceof Error ? err : new Error('Edge TTS 连接失败'); reject(failed); });
    ws.on('close', () => {
      clearTimeout(timer);
      if (done) resolve();
      else if (!failed) reject(new Error('Edge TTS 连接提前关闭'));
    });
  });

  await finish;
  if (!audioChunks.length) throw new Error('Edge TTS 未返回音频');
  const total = audioChunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of audioChunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
