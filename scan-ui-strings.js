process.noAsar = true;

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { isCoveredByDictOrDynamic } = require('./dom-translator.js');

const DICT_PATH = path.join(__dirname, 'zh-tw.json');
const API_KEY_PATH = path.join(__dirname, '.api-key');
const SKILLS_DIR = path.join(
  process.env.USERPROFILE || '',
  '.gemini',
  'antigravity',
  'builtin',
  'skills'
);

const PROTECTED_TERMS = [
  'Antigravity',
  'Gemini',
  'Claude',
  'GPT',
  'Worktree',
  'Workspace',
  'Swarm',
  'Subagent',
  'MCP',
  'Sidecar',
  'Token',
  'WSL',
  'Git',
  'DevTools',
  'CLI',
  'IDE',
  'JSON',
  'YAML',
  'PDF',
  'URI',
  'URL',
  'Cider'
];

const ZHTW_TERM_FIXES = [
  [/默認/g, '預設'],
  [/刷新/g, '重新整理'],
  [/設置/g, '設定'],
  [/插件/g, '外掛'],
  [/剪貼板/g, '剪貼簿'],
  [/標籤頁/g, '分頁'],
  [/對話框/g, '對話方塊'],
  [/文件夾/g, '資料夾'],
  [/代碼/g, '程式碼'],
  [/運行/g, '執行'],
  [/鏈接/g, '連結'],
  [/網絡/g, '網路'],
  [/搜索/g, '搜尋'],
  [/客服人員|代理商/g, '代理'],
  [/旗幟/g, '旗標']
];

function resolveResourcesDir() {
  const candidates = [
    process.env.AGY_PATH ? path.join(process.env.AGY_PATH, 'resources') : '',
    path.basename(process.execPath).toLowerCase() === 'antigravity.exe'
      ? path.join(path.dirname(process.execPath), 'resources')
      : '',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'resources'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity', 'resources')
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'app.asar'))) {
      return dir;
    }
  }
  return candidates[0] || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'resources');
}

function scanAsarMenuStrings(resourcesDir) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  const result = { version: 'unknown', labels: [] };
  if (!fs.existsSync(asarPath)) return result;

  try {
    const buf = fs.readFileSync(asarPath);
    const b4 = buf.readUInt32LE(4);
    const jsonLen = buf.readUInt32LE(12);
    const baseOffset = 8 + b4;
    const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));

    const readEntry = (relPath) => {
      const parts = relPath.split('/');
      let cur = header;
      for (const p of parts) {
        cur = cur?.files?.[p];
      }
      if (!cur || cur.offset === undefined) return '';
      const off = baseOffset + Number(cur.offset);
      return buf.subarray(off, off + Number(cur.size)).toString('utf8');
    };

    const pkgStr = readEntry('package.json');
    if (pkgStr) {
      result.version = JSON.parse(pkgStr).version || 'unknown';
    }

    const labelSet = new Set();
    for (const file of [
      'dist/main.js',
      'dist/menu.js',
      'dist/tray.js',
      'dist/updater.js',
      'dist/loadingOverlay.js',
      'dist/webviewPopupSecurity.js'
    ]) {
      const code = readEntry(file);
      if (!code) continue;
      const labelRe = /\blabel:\s*['"]([^'"]{2,50})['"]/g;
      let m;
      while ((m = labelRe.exec(code)) !== null) {
        const val = m[1].trim();
        if (/^[A-Z][a-zA-Z0-9\s.&…-]+$/.test(val)) {
          labelSet.add(val);
        }
      }
      const stepRe = /MenuUpdateStep\["[^"]+"\]\s*=\s*"([^"]+)"/g;
      while ((m = stepRe.exec(code)) !== null) {
        labelSet.add(m[1].trim());
      }
      const overlayRe = /<div class="text">([^<]{2,60})<\/div>/g;
      while ((m = overlayRe.exec(code)) !== null) {
        const val = m[1].trim();
        if (/^[A-Z]/.test(val)) labelSet.add(val);
      }
    }
    result.labels = Array.from(labelSet);
  } catch (_) {}
  return result;
}

function extractEmbeddedFrontendMainJs(exeBuf) {
  const targetName = Buffer.from('index.html', 'utf8');
  let searchPos = 0;
  let zipStartOffset = -1;

  while ((searchPos = exeBuf.indexOf(targetName, searchPos)) !== -1) {
    const headerStart = searchPos - 30;
    if (
      headerStart >= 0 &&
      exeBuf[headerStart] === 0x50 &&
      exeBuf[headerStart + 1] === 0x4b &&
      exeBuf[headerStart + 2] === 0x03 &&
      exeBuf[headerStart + 3] === 0x04
    ) {
      let cdPos = searchPos;
      while ((cdPos = exeBuf.indexOf(targetName, cdPos + 10)) !== -1) {
        const cdStart = cdPos - 46;
        if (
          cdStart >= 0 &&
          exeBuf[cdStart] === 0x50 &&
          exeBuf[cdStart + 1] === 0x4b &&
          exeBuf[cdStart + 2] === 0x01 &&
          exeBuf[cdStart + 3] === 0x02
        ) {
          const indexLocalRelOffset = exeBuf.readUInt32LE(cdStart + 42);
          zipStartOffset = headerStart - indexLocalRelOffset;
          break;
        }
      }
      if (zipStartOffset !== -1) break;
    }
    searchPos += 10;
  }

  if (zipStartOffset === -1) {
    throw new Error('在 language_server.exe 中找不到內嵌的前端 ZIP 資源包');
  }

  const mainName = Buffer.from('main.js', 'utf8');
  let pos = zipStartOffset;
  while ((pos = exeBuf.indexOf(mainName, pos)) !== -1) {
    const cdStart = pos - 46;
    if (
      cdStart >= 0 &&
      exeBuf[cdStart] === 0x50 &&
      exeBuf[cdStart + 1] === 0x4b &&
      exeBuf[cdStart + 2] === 0x01 &&
      exeBuf[cdStart + 3] === 0x02 &&
      exeBuf.readUInt16LE(cdStart + 28) === 7
    ) {
      const method = exeBuf.readUInt16LE(cdStart + 10);
      const compSize = exeBuf.readUInt32LE(cdStart + 20);
      const localRelOffset = exeBuf.readUInt32LE(cdStart + 42);
      const localOff = zipStartOffset + localRelOffset;
      const nameLen = exeBuf.readUInt16LE(localOff + 26);
      const extraLen = exeBuf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + nameLen + extraLen;
      const slice = exeBuf.subarray(dataStart, dataStart + compSize);
      return method === 0
        ? slice.toString('utf8')
        : zlib.inflateRawSync(slice).toString('utf8');
    }
    pos += 7;
  }

  throw new Error('在內嵌 ZIP 中找不到 main.js');
}

function inspectDictionary() {
  const existingKeys = new Set();
  const duplicateSame = [];
  const duplicateConflict = [];
  const emptyEntries = [];
  let totalEntries = 0;
  let raw = {};

  if (!fs.existsSync(DICT_PATH)) {
    return { raw, existingKeys, totalEntries, duplicateSame, duplicateConflict, emptyEntries };
  }

  const rawText = fs.readFileSync(DICT_PATH, 'utf8');
  raw = JSON.parse(rawText);
  const seenMap = new Map();

  const recordEntry = (sec, rawKey, rawVal) => {
    totalEntries++;
    const k = rawKey.trim();
    const v = typeof rawVal === 'string' ? rawVal.trim() : '';
    if (!v) {
      emptyEntries.push(sec === 'root' ? k : `${sec}.${k}`);
    } else {
      existingKeys.add(k);
    }
    if (seenMap.has(k)) {
      const prev = seenMap.get(k);
      if (prev.val === v) {
        duplicateSame.push(`"${k}" (${prev.sec} 與 ${sec})`);
      } else {
        duplicateConflict.push(`"${k}" ([${prev.sec}]="${prev.val}" vs [${sec}]="${v}")`);
      }
    } else {
      seenMap.set(k, { sec, val: v });
    }
  };

  for (const [secKey, secVal] of Object.entries(raw)) {
    if (secKey.startsWith('_')) continue;
    if (typeof secVal === 'string') {
      recordEntry('root', secKey, secVal);
    } else if (secVal && typeof secVal === 'object') {
      for (const [en, zh] of Object.entries(secVal)) {
        recordEntry(secKey, en, zh);
      }
    }
  }

  return { raw, existingKeys, totalEntries, duplicateSame, duplicateConflict, emptyEntries };
}

function maskProtectedTerms(text) {
  const tokens = [];
  let masked = text.replace(/(?<=^|\s)\/[a-z][a-z0-9-_]+/gi, (match) => {
    const idx = tokens.length;
    tokens.push(match);
    return `__AGYTERM${idx}__`;
  });

  for (const term of PROTECTED_TERMS) {
    const re = new RegExp(`\\b${term}\\b`, 'g');
    masked = masked.replace(re, (match) => {
      const idx = tokens.length;
      tokens.push(match);
      return `__AGYTERM${idx}__`;
    });
  }
  return { masked, tokens };
}

function unmaskAndNormalizeZhTw(translated, tokens) {
  if (!translated || typeof translated !== 'string') return '';
  let out = translated;
  for (let i = 0; i < tokens.length; i++) {
    const re = new RegExp(`__\\s*AGYTERM${i}\\s*__`, 'gi');
    out = out.replace(re, tokens[i]);
  }
  for (const [pattern, replacement] of ZHTW_TERM_FIXES) {
    out = out.replace(pattern, replacement);
  }
  return out.trim();
}

function httpsJsonRequest(url, options = {}, postBody = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { timeout: 7000, ...options }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('連線逾時'));
    });
    req.on('error', reject);
    if (postBody) {
      req.write(postBody);
    }
    req.end();
  });
}

async function translateSingleViaMyMemory(enText) {
  const { masked, tokens } = maskProtectedTerms(enText);
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(masked)}&langpair=en|zh-TW`;
  const data = await httpsJsonRequest(url, { method: 'GET' });
  const rawTranslated = data?.responseData?.translatedText;
  if (!rawTranslated || typeof rawTranslated !== 'string') {
    throw new Error('無有效翻譯結果');
  }
  if (rawTranslated.includes('MYMEMORY WARNING')) {
    throw new Error('免費翻譯額度已達當日上限');
  }
  return unmaskAndNormalizeZhTw(rawTranslated, tokens);
}

async function translateBatchViaGemini(strings, apiKey) {
  const prompt = [
    '將以下軟體介面英文字串陣列翻譯為繁體中文，回傳純 JSON 物件（鍵為原文，值為譯文）。',
    '保留 Antigravity、Gemini、Claude、GPT、MCP、Worktree、Swarm、Token、WSL、Git、Hook、Sidecar 等技術名詞不翻譯：',
    JSON.stringify(strings)
  ].join('\n');

  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' }
  });

  const models = ['gemini-flash-latest', 'gemini-2.5-flash'];
  let lastErr = null;
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const data = await httpsJsonRequest(
        url,
        {
          method: 'POST',
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        payload
      );
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return text ? JSON.parse(text) : {};
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Gemini API 呼叫失敗');
}

function normalizeAutoTranslateMode(val) {
  if (val === 'gemini') return 'gemini';
  if (val === 'mymemory' || val === true) return 'mymemory';
  return false;
}

function readStoredApiKey() {
  try {
    if (fs.existsSync(API_KEY_PATH)) {
      const fileKey = fs.readFileSync(API_KEY_PATH, 'utf8').trim();
      if (fileKey) {
        return { key: fileKey, source: '.api-key 設定檔' };
      }
    }
  } catch (_) {}
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return { key: process.env.GEMINI_API_KEY.trim(), source: '環境變數 GEMINI_API_KEY' };
  }
  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY.trim()) {
    return { key: process.env.GOOGLE_API_KEY.trim(), source: '環境變數 GOOGLE_API_KEY' };
  }
  return { key: '', source: '' };
}

function maskApiKey(key) {
  if (!key || key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

async function validateGeminiApiKey(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=5&key=${encodeURIComponent(apiKey)}`;
  try {
    await httpsJsonRequest(url, { method: 'GET', timeout: 8000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function resolveTranslationProvider(mode) {
  const normalized = normalizeAutoTranslateMode(mode);
  if (normalized === 'gemini') {
    const stored = readStoredApiKey();
    if (stored.key) {
      return {
        type: 'gemini',
        key: stored.key,
        label: `Gemini API (Gemini Flash，金鑰來源：${stored.source})`
      };
    }
    return {
      type: 'none',
      key: '',
      label: 'Gemini API (未設定金鑰)'
    };
  }
  return {
    type: 'mymemory',
    key: '',
    label: 'MyMemory 免費翻譯服務'
  };
}

async function translateMissingStrings(missingItems, mode = 'mymemory') {
  const results = Object.create(null);
  if (!Array.isArray(missingItems) || missingItems.length === 0) {
    return results;
  }

  const provider = resolveTranslationProvider(mode);
  if (provider.type === 'none') {
    return results;
  }
  if (provider.type === 'gemini') {
    const batchSize = 40;
    for (let i = 0; i < missingItems.length; i += batchSize) {
      const chunk = missingItems.slice(i, i + batchSize);
      try {
        const batchMap = await translateBatchViaGemini(chunk, provider.key);
        for (const item of chunk) {
          if (batchMap[item] && typeof batchMap[item] === 'string') {
            results[item] = unmaskAndNormalizeZhTw(batchMap[item], []);
          }
        }
      } catch (err) {
        console.error(`[警告] Gemini 批次翻譯失敗 (${i + 1}-${i + chunk.length}):`, err.message);
      }
    }
    return results;
  }

  for (const item of missingItems) {
    try {
      const zh = await translateSingleViaMyMemory(item);
      if (zh && zh.toLowerCase() !== item.toLowerCase()) {
        results[item] = zh;
      }
    } catch (err) {
      if (err.message.includes('上限')) break;
    }
  }
  return results;
}

function writeDictAtomicSync(targetPath, dataObj) {
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  const content = JSON.stringify(dataObj, null, 2) + '\n';
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    throw err;
  }
}

async function setAutoTranslateMode(modeInput, apiKeyInput = '') {
  if (!fs.existsSync(DICT_PATH)) return false;
  const rawMode = String(modeInput ?? '').trim().toLowerCase();
  let targetMode = false;
  if (rawMode === '1' || rawMode === 'mymemory' || rawMode === 'true') {
    targetMode = 'mymemory';
  } else if (rawMode === '2' || rawMode === 'gemini') {
    targetMode = 'gemini';
  } else if (rawMode === '0' || rawMode === 'off' || rawMode === 'false') {
    targetMode = false;
  } else {
    console.log('已取消變更。');
    return false;
  }

  if (targetMode === 'gemini') {
    const trimmedInput = String(apiKeyInput || '').trim();
    const stored = readStoredApiKey();
    const candidateKey = trimmedInput || stored.key;
    if (!candidateKey) {
      console.log('[取消] 未提供 Gemini API Key，維持原設定不變。');
      return false;
    }
    console.log('正在驗證 Gemini API Key 連線與權限...');
    const check = await validateGeminiApiKey(candidateKey);
    if (!check.ok) {
      console.error(
        `[錯誤] Gemini API Key 驗證失敗 (${check.error})，請確認金鑰是否正確或網路連線正常。維持原設定不變。`
      );
      return false;
    }
    if (trimmedInput) {
      fs.writeFileSync(API_KEY_PATH, trimmedInput + '\n', 'utf8');
    }
  }

  const raw = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
  raw._meta = raw._meta || {};
  raw._meta.auto_translate = targetMode;
  writeDictAtomicSync(DICT_PATH, raw);

  if (targetMode === 'gemini') {
    const stored = readStoredApiKey();
    console.log(
      `新詞條自動翻譯已設定為：[開啟 — Gemini API (Gemini Flash)]（金鑰驗證通過：${maskApiKey(stored.key)}）`
    );
  } else if (targetMode === 'mymemory') {
    console.log('新詞條自動翻譯已設定為：[開啟 — MyMemory 免費翻譯服務]');
  } else {
    console.log('新詞條自動翻譯已設定為：[關閉] 僅掃描列出未翻譯英文，不呼叫外部翻譯');
  }
  return true;
}

function promptAutoTranslateMenu(rl) {
  return new Promise((resolve) => {
    console.log('請選擇新詞條自動翻譯模式：');
    console.log('  [1] 開啟 — MyMemory 免費翻譯服務');
    console.log('  [2] 開啟 — Gemini API (Gemini Flash)');
    console.log('  [0] 關閉自動翻譯');
    console.log('  [Enter] 取消並返回主選單');

    rl.question('\n請輸入模式數字 (0-2): ', async (ans) => {
      const sub = ans.trim();
      if (sub === '0' || sub === '1') {
        await setAutoTranslateMode(sub);
        return resolve();
      }
      if (sub === '2') {
        const stored = readStoredApiKey();
        if (stored.key) {
          console.log(`\n目前已設定金鑰：${maskApiKey(stored.key)}（來源：${stored.source}）`);
          rl.question('直接按 Enter 沿用現有金鑰，或貼上新金鑰覆蓋： ', async (keyAns) => {
            await setAutoTranslateMode('gemini', keyAns.trim());
            resolve();
          });
        } else {
          console.log('\n尚未設定 Gemini API Key（可於 https://aistudio.google.com/apikey 免費申請）');
          rl.question('請貼上 Gemini API Key（直接按 Enter 取消）： ', async (keyAns) => {
            if (!keyAns.trim()) {
              console.log('已取消變更。');
              return resolve();
            }
            await setAutoTranslateMode('gemini', keyAns.trim());
            resolve();
          });
        }
        return;
      }
      console.log('已取消變更。');
      resolve();
    });
  });
}

async function runScan(options = {}) {
  const syncMeta = Boolean(options.sync || options.autoTranslate);
  const dictInfo = inspectDictionary();
  const { existingKeys, totalEntries, duplicateSame, duplicateConflict, emptyEntries } = dictInfo;
  const metaMode = normalizeAutoTranslateMode(dictInfo.raw?._meta?.auto_translate);
  const activeMode =
    options.autoTranslate !== undefined
      ? options.autoTranslate
        ? metaMode || 'mymemory'
        : false
      : metaMode;

  const resourcesDir = resolveResourcesDir();
  const binPath = path.join(resourcesDir, 'bin', 'language_server.exe');

  console.log('==================================================');
  console.log(' Antigravity 未翻譯詞條與字典檢查報告');
  console.log('==================================================');

  const asarInfo = scanAsarMenuStrings(resourcesDir);
  if (!fs.existsSync(binPath)) {
    console.error('[錯誤] 找不到 language_server.exe：', binPath);
    return false;
  }

  const exeBuf = fs.readFileSync(binPath);
  const mainJs = extractEmbeddedFrontendMainJs(exeBuf);

  const hasTranslationOrBase = (rawLabel) => isCoveredByDictOrDynamic(existingKeys, rawLabel);

  const SKIP_TECH_SETTINGS = new Set([
    'MacOS', 'macOS', 'Windows', 'Linux', 'Ubuntu', 'Debian', 'GitHub', 'GitLab', 'Bitbucket',
    'Google', 'Google Cloud', 'Google Drive', 'Google Docs', 'Google Sheets', 'Google Slides',
    'Google Chat', 'Google Chrome', 'Google Workspace', 'Windows Subsystem for Linux',
    'Antigravity', 'Antigravity Interactive HTML', 'Jetski', 'Cascade', 'Mendel', 'Cider', 'Piper',
    'Fig', 'CitC', 'Google3', 'Buganizer', 'Critique', 'ADEX', 'ADE', 'Sample GDoc',
    'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown',
    'Piper (g4)', 'Cog (GoB)', 'Default (Mendel)',
    'Electron (Desktop)', 'Electron (Gemini App)', 'Electron (Android Desktop)',
    'Web (desktop)', 'Web (desktop, PWA)', 'Web (desktop, remote control)', 'Web (desktop, remote control, PWA)',
    'Web (mobile)', 'Web (mobile, PWA)', 'Web (mobile, remote control)', 'Web (mobile, remote control, PWA)',
    'Extension (Cider)', 'Extension (VS Code)', 'Extension (Antigravity IDE)', 'Extension (Visual Studio)', 'Extension (Eclipse)',
    'Google (internal)', 'All tools (*)', 'run_command or view_file', 'Browser tools (browser_.*)',
    'Best of N', 'File Explorer', 'Finder', 'Chrome', 'Safari', 'Firefox', 'Edge',
    'File Viewer', 'Virtual File Viewer', 'Command Shift A',
    'VS Code', 'Visual Studio', 'Eclipse', 'Gemini', 'Claude', 'GPT',
    'MCP', 'WSL', 'SSH', 'HTTP', 'HTTPS', 'JSON', 'YAML', 'CSV', 'PDF', 'HTML', 'CSS', 'SVG',
    'PNG', 'JPG', 'GIF', 'MP3', 'MP4', 'UTF-8', 'ASCII', 'OAuth', 'SSO', 'SAML',
    'API', 'CLI', 'IDE', 'SDK', 'URL', 'URI', 'DOM', 'SQL', 'Git', 'CEL', 'WIF'
  ]);

  const SINGLE_WORD_COLLISION_SKIP = new Set([
    'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'String', 'Number', 'Boolean', 'Object', 'Array',
    'Error', 'Function', 'Symbol', 'Proxy', 'Reflect', 'Date', 'RegExp', 'Blob', 'Node', 'Element',
    'Document', 'Event', 'Screen', 'Navigator', 'Location', 'Storage', 'Worker', 'Audio', 'Video',
    'Image', 'Canvas', 'Option', 'Input', 'Button', 'Label', 'Table', 'Form', 'Meta', 'Style',
    'Script', 'Span', 'True', 'False', 'Null', 'Auto', 'Normal', 'Medium', 'Bold', 'Italic',
    'Code', 'Data', 'Text', 'Key', 'Value', 'Type', 'State', 'Mode', 'Item', 'Left', 'Right',
    'Center', 'Top', 'Bottom', 'Enter', 'Escape', 'Space', 'Shift', 'Control', 'Alt', 'Tab',
    'Backspace', 'Home', 'End', 'PageUp', 'PageDown', 'Main', 'Master', 'Origin', 'Head', 'Local',
    'Host', 'Port', 'Root', 'User', 'Admin', 'Guest', 'Token', 'Secret', 'Hash', 'Diff', 'Patch',
    'Line', 'Column', 'For', 'From', 'When', 'In', 'To', 'By', 'With', 'At', 'Of', 'On', 'Or',
    'And', 'See', 'Visit', 'Press', 'Use', 'You', 'This', 'Drive', 'Card', 'Skill', 'Agent', 'Readme'
  ]);

  const decodeJsEscapesRaw = (raw) => {
    if (!raw || typeof raw !== 'string') return '';
    return raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
  };

  const isValidReactUiCandidate = (rawDecoded, isJsxChild = false) => {
    if (!rawDecoded) return false;
    if (isJsxChild && /\s$/.test(rawDecoded) && !/:\s+$/.test(rawDecoded)) return false;
    if (isJsxChild && /^\s/.test(rawDecoded) && !/^\s*(?:\(|[A-Z].*[.!?]$)/.test(rawDecoded)) return false;

    const s = rawDecoded.trim();
    if (!s || s.length < 2 || s.length > 350) return false;
    if (s.includes('\n') || s.includes('${') || s.includes('`') || s.includes('\\')) return false;
    if (SKIP_TECH_SETTINGS.has(s)) return false;

    const openParens = (s.match(/\(/g) || []).length;
    const closeParens = (s.match(/\)/g) || []).length;
    if (openParens !== closeParens) return false;
    if (/[=,\-#]$/.test(s)) return false;
    if (/\s(?:in|to|for|from|with|by|of|on|at|via|or|and|the|a|an|our|its|your|what|about|Requires|includes|can|positive|help the Agent)$/.test(s)) {
      return false;
    }

    if (!/^(?:[A-Z][a-zA-Z0-9]|[(][A-Za-z]|\d+x\s+[a-z])/.test(s)) return false;
    if (!/[a-z]{2,}/.test(s)) return false;
    if (/(?:https?:\/\/|file:\/\/|\/\/|\/[a-z0-9_.-]+\/|[a-z0-9_]+\.[a-z0-9_]+\(|=>|===|!==|&&|\|\||[{};<>[\]]|--[a-z]|@[a-z]+:|%[sd])/i.test(s)) {
      return false;
    }
    if (/^(?:e\.g\.|i\.e\.|example:|http|localhost|127\.0\.0\.1)/i.test(s)) return false;

    if (!s.includes(' ')) {
      const cleanWord = s.replace(/(?:\.\.\.|…|[:.?!])$/, '');
      if (SKIP_TECH_SETTINGS.has(cleanWord) || SINGLE_WORD_COLLISION_SKIP.has(cleanWord)) return false;
      if (!/^[A-Z][a-z]{2,18}$/.test(cleanWord)) return false;
    } else {
      if (/^(?:Ctrl|Cmd|Alt|Shift)\s*\+/i.test(s)) return false;
      if (/\b(?:v\d+\.\d+|0x[0-9a-f]+|px|rem|ms|rgba?\()\b/i.test(s)) return false;
      if (/^(?:Gemini|Claude|GPT|Llama|Mistral)\s+[0-9A-Za-z.-]+$/i.test(s)) return false;
    }
    return true;
  };

  const allSettings = [];
  const untranslatedSettings = [];
  const seenSettings = new Set();
  const addSettingString = (rawStr, screen = 'Settings') => {
    if (!rawStr) return;
    const s = rawStr
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\$\{c\}\s+app settings\./g, 'Antigravity app settings.')
      .trim();
    if (s.includes('${') || s.includes('\n')) return;
    if (s.length < 2 || s.length > 350) return;
    if (!/[A-Za-z]{2,}/.test(s)) return;
    if (SKIP_TECH_SETTINGS.has(s)) return;
    if (/^(https?:|file:|example:|e\.g\.,|[a-z0-9_./-]+)$/i.test(s) && !/^[A-Z][a-z]+/.test(s)) return;
    if (/^(Map|Set|Promise|String|Number|Boolean|Object|Array|Error|Function)$/.test(s)) return;
    if (s.includes('`<Toggle') || s.includes('os=') || s.includes('feature (')) return;
    if (seenSettings.has(s)) return;
    seenSettings.add(s);
    allSettings.push({ screen, label: s });
    if (!hasTranslationOrBase(s)) {
      untranslatedSettings.push({ screen, label: s });
    }
  };

  const settingsRegex = /isProviderSetting:![01],screen:"([^"]+)",label:"([^"]+)"/g;
  let m;
  let firstProviderIdx = -1;
  let lastProviderIdx = -1;
  while ((m = settingsRegex.exec(mainJs)) !== null) {
    if (firstProviderIdx === -1) firstProviderIdx = m.index;
    lastProviderIdx = m.index;
    addSettingString(m[2], m[1]);
  }

  if (firstProviderIdx === -1) {
    const fallbackProv = /isProviderSetting:![01]/g.exec(mainJs);
    if (fallbackProv) {
      firstProviderIdx = fallbackProv.index;
      lastProviderIdx = fallbackProv.index;
    }
  }

  const legacyStartIdx = mainJs.indexOf('["useAICredits",{isProviderSetting:');
  const startSettingsIdx =
    firstProviderIdx !== -1
      ? Math.max(0, firstProviderIdx - 2000)
      : legacyStartIdx;
  const modalAnchorIdx = mainJs.indexOf('settings-modal-container');
  const descAnchorIdx = mainJs.indexOf('description:"Configure agent execution');
  const endSettingsIdx = Math.max(
    modalAnchorIdx !== -1 ? modalAnchorIdx + 5000 : -1,
    lastProviderIdx !== -1 ? lastProviderIdx + 700000 : -1,
    descAnchorIdx !== -1 ? descAnchorIdx + 15000 : -1
  );
  if (startSettingsIdx !== -1 && endSettingsIdx > startSettingsIdx) {
    const settingsBlock = mainJs.slice(startSettingsIdx, Math.min(mainJs.length, endSettingsIdx));

    const propRe = /\b(label|description|title|subtitle|sectionTitle|emptyText|confirmLabel|cancelLabel):\s*(?:"([^"]{2,350})"|`([^`]{2,350})`)/g;
    while ((m = propRe.exec(settingsBlock)) !== null) {
      addSettingString(m[2] || m[3], m[1]);
    }

    const ternRe = /\?\s*"([A-Z][^"\\\n]{1,350})"\s*:\s*(?:"([A-Z][^"\\\n]{1,350})"|[A-Za-z0-9_$]+\.createElement)/g;
    while ((m = ternRe.exec(settingsBlock)) !== null) {
      addSettingString(m[1], 'Ternary');
      if (m[2]) addSettingString(m[2], 'Ternary');
    }

    const optRe = /resolveOptionTo(?:String|Description):[^{]+\{[^}]+\}/g;
    while ((m = optRe.exec(settingsBlock)) !== null) {
      const retRe = /return"([^"]+)"/g;
      let rm;
      while ((rm = retRe.exec(m[0])) !== null) {
        addSettingString(rm[1], 'Option');
      }
    }

    const jsxRe = /createElement\((?:"(?:div|span|p|h[1-6]|button|label|option)"|[A-Za-z0-9_$]+),\s*(?:null|\{[^{}]*\}),\s*"([A-Z][^"\n]{2,350})"\)/g;
    while ((m = jsxRe.exec(settingsBlock)) !== null) {
      addSettingString(m[1], 'UI');
    }

    const jsxBtnRe = /createElement\((?:"button"|[A-Za-z0-9_$]{1,4}),\s*\{[^{}]*onClick:[\s\S]{1,260}?\},\s*"([A-Z][^"\n]{2,100})"\)/g;
    while ((m = jsxBtnRe.exec(settingsBlock)) !== null) {
      addSettingString(m[1], 'Button');
    }
  }

  const allCommands = [];
  const untranslatedCommands = [];
  const seenCommands = new Set();

  const anchorIdx = mainJs.indexOf('"New Conversation"');
  if (anchorIdx !== -1) {
    const cmdBlock = mainJs.slice(Math.max(0, anchorIdx - 2500), anchorIdx + 5500);
    const registryCmdRegex = /([a-zA-Z0-9_]+):\s*\{\s*label:\s*"([^"]{2,60})"/g;
    while ((m = registryCmdRegex.exec(cmdBlock)) !== null) {
      const id = m[1];
      const label = m[2].trim();
      if (!seenCommands.has(label) && /^[A-Z]/.test(label)) {
        seenCommands.add(label);
        allCommands.push({ id, label });
        if (!hasTranslationOrBase(label)) {
          untranslatedCommands.push({ id, label });
        }
      }
    }
  }

  const arrayCmdRegex = /\{id:"([^"]+)",label:"([^"]+)",icon:"([^"]+)"/g;
  while ((m = arrayCmdRegex.exec(mainJs)) !== null) {
    const id = m[1];
    const label = m[2].trim();
    if (!seenCommands.has(label)) {
      seenCommands.add(label);
      allCommands.push({ id, label });
      if (!hasTranslationOrBase(label)) {
        untranslatedCommands.push({ id, label });
      }
    }
  }

  const placeholderRegex =
    /\bplaceholder:\s*(?:[A-Za-z0-9_$]+\s*=\s*)?"((?:[A-Z]|\([A-Za-z])[^"\\\n]{3,160})"/g;
  const placeholderTernRegex =
    /\bplaceholder:\s*[^{};"']{1,80}\?\s*"((?:[^"\\\n]|\\.)*)"\s*:\s*"((?:[^"\\\n]|\\.)*)"/g;
  const allPlaceholders = [];
  const untranslatedPlaceholders = [];
  const seenPlaceholders = new Set();
  const addPlaceholder = (rawPh) => {
    const ph = decodeJsEscapesRaw(rawPh).trim();
    if (
      ph &&
      ph.length >= 3 &&
      ph.length <= 160 &&
      /^(?:[A-Z]|\([A-Za-z])/.test(ph) &&
      !seenPlaceholders.has(ph) &&
      !SKIP_TECH_SETTINGS.has(ph) &&
      /[a-z]{2,}/.test(ph) &&
      !/^(?:https?|file):\/\//i.test(ph) &&
      !ph.includes('{') &&
      !/^\/[a-z0-9_.-]+\//i.test(ph)
    ) {
      seenPlaceholders.add(ph);
      allPlaceholders.push(ph);
      if (!hasTranslationOrBase(ph)) {
        untranslatedPlaceholders.push(ph);
      }
    }
  };
  while ((m = placeholderRegex.exec(mainJs)) !== null) {
    addPlaceholder(m[1]);
  }
  while ((m = placeholderTernRegex.exec(mainJs)) !== null) {
    addPlaceholder(m[1]);
    addPlaceholder(m[2]);
  }

  const untranslatedMenu = asarInfo.labels.filter((l) => !hasTranslationOrBase(l));

  const skillDescriptions = [];
  if (fs.existsSync(SKILLS_DIR)) {
    for (const d of fs.readdirSync(SKILLS_DIR)) {
      const skillFile = path.join(SKILLS_DIR, d, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, 'utf8');
        const match = content.match(
          /description:\s*(?:>-\s*)?([\s\S]+?)(?:\r?\n[a-z_0-9-]+:\s*|\r?\n---|\r?\n#)/i
        );
        if (match) {
          const desc = match[1].replace(/\r?\n\s*/g, ' ').trim();
          skillDescriptions.push({ name: d, description: desc });
        }
      }
    }
  }
  const untranslatedSkills = skillDescriptions.filter((s) => !hasTranslationOrBase(s.description));

  const asarLabelSet = new Set(asarInfo.labels);
  const skillDescSet = new Set(skillDescriptions.map((s) => s.description));
  const allReactUi = [];
  const seenReactUi = new Set();

  const addReactCandidate = (rawDecoded, isJsxChild) => {
    if (!isValidReactUiCandidate(rawDecoded, isJsxChild)) return;
    const s = rawDecoded.trim();
    if (
      seenReactUi.has(s) ||
      seenSettings.has(s) ||
      seenCommands.has(s) ||
      seenPlaceholders.has(s) ||
      asarLabelSet.has(s) ||
      skillDescSet.has(s)
    ) {
      return;
    }
    seenReactUi.add(s);
    allReactUi.push(s);
  };

  const reactPropRe =
    /(?:"aria-label"|\b(?:title|label|description|subtitle|sectionTitle|emptyText|confirmLabel|cancelLabel|tooltip|headerTitle|buttonText|actionLabel|statusText|placeholder)):\s*"((?:[^"\\\n]|\\.)*)"/g;
  const reactPropTernaryRe =
    /(?:"aria-label"|\b(?:title|label|description|subtitle|sectionTitle|emptyText|confirmLabel|cancelLabel|tooltip|headerTitle|buttonText|actionLabel|statusText|placeholder)):\s*[^{},;?"']{1,120}\?\s*"((?:[^"\\\n]|\\.)*)"\s*:\s*"((?:[^"\\\n]|\\.)*)"/g;
  const reactTernaryStrRe = /[?:]\s*"((?:[^"\\\n]|\\.)*)"/g;

  let ceSearchPos = 0;
  while (true) {
    const ceIdx = mainJs.indexOf('.createElement(', ceSearchPos);
    if (ceIdx === -1) break;
    const argsStart = ceIdx + 15;
    ceSearchPos = argsStart;

    let parenDepth = 1;
    let braceDepth = 0;
    let bracketDepth = 0;
    let quoteChar = '';
    const topArgs = [];
    let curArgStart = argsStart;
    const maxEnd = Math.min(mainJs.length, argsStart + 4500);
    let i = argsStart;

    for (; i < maxEnd; i++) {
      const ch = mainJs[i];
      if (quoteChar) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === quoteChar) quoteChar = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quoteChar = ch;
        continue;
      }
      if (ch === '(') parenDepth++;
      else if (ch === ')') {
        parenDepth--;
        if (parenDepth === 0) {
          topArgs.push(mainJs.slice(curArgStart, i).trim());
          break;
        }
      } else if (ch === '{') braceDepth++;
      else if (ch === '}') {
        if (braceDepth > 0) braceDepth--;
      } else if (ch === '[') bracketDepth++;
      else if (ch === ']') {
        if (bracketDepth > 0) bracketDepth--;
      } else if (ch === ',' && parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
        topArgs.push(mainJs.slice(curArgStart, i).trim());
        curArgStart = i + 1;
      }
    }

    if (parenDepth !== 0 || topArgs.length < 2) continue;
    const elemType = topArgs[0];
    const propsArg = topArgs[1];

    if (/^"(?:code|pre|style|script|svg|path|circle|rect|polygon|line|g)"$/.test(elemType)) continue;
    const isValuelessOption =
      elemType === '"option"' && (!propsArg || propsArg === 'null' || !/\bvalue\s*:/.test(propsArg));

    if (propsArg && propsArg !== 'null' && propsArg.includes('"')) {
      const stripNestedCe = (src) => {
        let out = '';
        let p = 0;
        while (p < src.length) {
          const idx = src.indexOf('.createElement(', p);
          if (idx === -1) {
            out += src.slice(p);
            break;
          }
          out += src.slice(p, idx) + '.ce(null)';
          let d = 1;
          let q = '';
          let k = idx + 15;
          for (; k < src.length; k++) {
            const c = src[k];
            if (q) {
              if (c === '\\') k++;
              else if (c === q) q = '';
              continue;
            }
            if (c === '"' || c === "'" || c === '`') {
              q = c;
              continue;
            }
            if (c === '(') d++;
            else if (c === ')') {
              d--;
              if (d === 0) {
                k++;
                break;
              }
            }
          }
          p = k;
        }
        return out;
      };
      const propsWithoutNestedCe = propsArg.includes('.createElement(')
        ? stripNestedCe(propsArg)
        : propsArg;
      reactPropRe.lastIndex = 0;
      let pm;
      while ((pm = reactPropRe.exec(propsWithoutNestedCe)) !== null) {
        addReactCandidate(decodeJsEscapesRaw(pm[1]), false);
      }
      if (propsWithoutNestedCe.includes('?')) {
        reactPropTernaryRe.lastIndex = 0;
        while ((pm = reactPropTernaryRe.exec(propsWithoutNestedCe)) !== null) {
          addReactCandidate(decodeJsEscapesRaw(pm[1]), false);
          addReactCandidate(decodeJsEscapesRaw(pm[2]), false);
        }
      }
    }

    if (isValuelessOption || topArgs.length < 3) continue;

    for (let ai = 2; ai < topArgs.length; ai++) {
      const childArg = topArgs[ai];
      if (!childArg || !childArg.includes('"')) continue;
      const prevIsSpace = ai > 2 && /^"\s+"$/.test(topArgs[ai - 1]);
      const nextIsSpace = ai + 1 < topArgs.length && /^"\s+"$/.test(topArgs[ai + 1]);
      if (prevIsSpace || nextIsSpace) continue;

      if (childArg[0] === '"' && childArg[childArg.length - 1] === '"') {
        const inner = childArg.slice(1, -1);
        if (!/(?<!\\)"/.test(inner)) {
          addReactCandidate(decodeJsEscapesRaw(inner), true);
          continue;
        }
      }

      if (childArg.includes('?') && !childArg.includes('.createElement(')) {
        reactTernaryStrRe.lastIndex = 0;
        let tm;
        while ((tm = reactTernaryStrRe.exec(childArg)) !== null) {
          addReactCandidate(decodeJsEscapesRaw(tm[1]), true);
        }
      }
    }
  }

  const untranslatedReactUi = allReactUi.filter((s) => !hasTranslationOrBase(s));

  console.log(`目標軟體版本:          v${asarInfo.version} (前端套件 ${(mainJs.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`字典有效唯一詞條數:    ${existingKeys.size} 條 (總定義數: ${totalEntries})`);
  console.log(
    `自動翻譯模式狀態:      ${
      metaMode === 'gemini'
        ? '[開啟: Gemini API]'
        : metaMode === 'mymemory'
          ? '[開啟: MyMemory 免費服務]'
          : '[關閉]'
    }`
  );
  console.log(`主程序選單詞條覆蓋率:  ${asarInfo.labels.length - untranslatedMenu.length} / ${asarInfo.labels.length}`);
  console.log(`設定面板項目覆蓋率:    ${allSettings.length - untranslatedSettings.length} / ${allSettings.length}`);
  console.log(`快捷指令註冊表覆蓋率:  ${allCommands.length - untranslatedCommands.length} / ${allCommands.length}`);
  console.log(`輸入框提示詞覆蓋率:    ${allPlaceholders.length - untranslatedPlaceholders.length} / ${allPlaceholders.length}`);
  console.log(`前端元件介面覆蓋率:    ${allReactUi.length - untranslatedReactUi.length} / ${allReactUi.length}`);
  console.log(`內建技能描述覆蓋率:    ${skillDescriptions.length - untranslatedSkills.length} / ${skillDescriptions.length}`);
  console.log('--------------------------------------------------');

  if (duplicateConflict.length > 0) {
    console.log('[警告] 發現跨區翻譯不一致的衝突鍵：');
    for (const item of duplicateConflict) console.log('  - ' + item);
  }
  if (duplicateSame.length > 0) {
    console.log('[提示] 發現重複定義的相同詞條：');
    for (const item of duplicateSame) console.log('  - ' + item);
  }
  if (emptyEntries.length > 0) {
    console.log('[提示] 尚有空白待填詞條：');
    for (const item of emptyEntries) console.log('  - ' + item);
  }

  const allMissingStrings = [
    ...untranslatedMenu,
    ...untranslatedSettings.map((s) => s.label),
    ...untranslatedCommands.map((c) => c.label),
    ...untranslatedPlaceholders,
    ...untranslatedReactUi,
    ...untranslatedSkills.map((s) => s.description)
  ];

  let autoTranslatedCount = 0;
  if (allMissingStrings.length > 0 && activeMode) {
    const provider = resolveTranslationProvider(activeMode);
    if (provider.type === 'none') {
      console.log('\n[警告] 已設定為 Gemini API 模式但找不到金鑰（請至選單 [4] 設定），本次略過自動翻譯。');
    } else {
      console.log(
        `\n正在透過 ${provider.label} 自動翻譯 ${allMissingStrings.length} 筆新增英文詞條並寫入 "auto" 分區...`
      );
      const translatedMap = await translateMissingStrings(allMissingStrings, activeMode);
      dictInfo.raw.auto = dictInfo.raw.auto || {};
      for (const [en, zh] of Object.entries(translatedMap)) {
        dictInfo.raw.auto[en] = zh;
        existingKeys.add(en);
        autoTranslatedCount++;
        console.log(`  + "${en}" => "${zh}"`);
      }
    }
  } else if (allMissingStrings.length > 0) {
    if (untranslatedMenu.length > 0) {
      console.log('\n[未翻譯主程序選單]：');
      for (const l of untranslatedMenu) console.log(`    "${l}": "",`);
    }
    if (untranslatedSettings.length > 0) {
      console.log('\n[未翻譯設定項目]：');
      for (const s of untranslatedSettings) console.log(`    ${JSON.stringify(s.label)}: "",`);
    }
    if (untranslatedCommands.length > 0) {
      console.log('\n[未翻譯快捷指令]：');
      for (const c of untranslatedCommands) console.log(`    "${c.label}": "",`);
    }
    if (untranslatedPlaceholders.length > 0) {
      console.log('\n[未翻譯輸入框提示詞]：');
      for (const p of untranslatedPlaceholders) console.log(`    ${JSON.stringify(p)}: "",`);
    }
    if (untranslatedReactUi.length > 0) {
      console.log('\n[未翻譯前端元件介面]：');
      for (const r of untranslatedReactUi) console.log(`    ${JSON.stringify(r)}: "",`);
    }
    if (untranslatedSkills.length > 0) {
      console.log('\n[未翻譯內建技能描述]：');
      for (const s of untranslatedSkills) console.log(`    ${JSON.stringify(s.description)}: "",`);
    }
  }

  const remainingMissing = allMissingStrings.length - autoTranslatedCount;
  const anchorBroken =
    asarInfo.labels.length === 0 ||
    allSettings.length === 0 ||
    allCommands.length === 0 ||
    allReactUi.length === 0;
  if (anchorBroken) {
    console.log('[警告] 掃描錨點失效（部分核心分類擷取總數為 0），目標版本前端打包結構可能已變更。');
  } else if (
    remainingMissing === 0 &&
    duplicateConflict.length === 0 &&
    duplicateSame.length === 0 &&
    emptyEntries.length === 0
  ) {
    console.log('檢驗通過：所有核心選單、設定項目、快捷指令、提示詞、前端元件介面與內建技能均 100% 完整覆蓋且無衝突鍵。');
  }

  if ((syncMeta || autoTranslatedCount > 0) && dictInfo.raw && dictInfo.raw._meta) {
    let fileChanged = autoTranslatedCount > 0;
    if (
      !anchorBroken &&
      remainingMissing === 0 &&
      asarInfo.version !== 'unknown' &&
      dictInfo.raw._meta.version !== asarInfo.version
    ) {
      dictInfo.raw._meta.version = asarInfo.version;
      fileChanged = true;
    }
    if (dictInfo.raw._meta.total_entries !== existingKeys.size) {
      dictInfo.raw._meta.total_entries = existingKeys.size;
      fileChanged = true;
    }
    if (fileChanged) {
      writeDictAtomicSync(DICT_PATH, dictInfo.raw);
      console.log(
        `已儲存 zh-tw.json (version: ${dictInfo.raw._meta.version}, total_entries: ${dictInfo.raw._meta.total_entries}, 本次自動新增: ${autoTranslatedCount} 筆)。`
      );
    }
  }
  console.log('==================================================');
  return !anchorBroken && remainingMissing === 0;
}

if (require.main === module) {
  const setIdx = process.argv.indexOf('--set-auto-translate');
  if (setIdx !== -1) {
    setAutoTranslateMode(process.argv[setIdx + 1], process.argv[setIdx + 2])
      .then((ok) => process.exit(ok ? 0 : 1))
      .catch((err) => {
        console.error('[錯誤]', err.message);
        process.exit(1);
      });
  } else {
    const sync = process.argv.includes('--sync');
    const forceAuto = process.argv.includes('--auto-translate') ? true : undefined;
    runScan({ sync, autoTranslate: forceAuto }).catch((err) => {
      console.error('[錯誤]', err.message);
      process.exit(1);
    });
  }
}

module.exports = {
  inspectDictionary,
  runScan,
  setAutoTranslateMode,
  promptAutoTranslateMenu,
  translateSingleViaMyMemory,
  translateBatchViaGemini,
  validateGeminiApiKey
};
