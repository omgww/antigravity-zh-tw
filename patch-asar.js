process.noAsar = true;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');

function resolveInstallDir() {
  const candidates = [];
  if (process.env.AGY_PATH) {
    candidates.push(process.env.AGY_PATH);
  }
  if (path.basename(process.execPath).toLowerCase() === 'antigravity.exe') {
    candidates.push(path.dirname(process.execPath));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity'));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'Antigravity'));
  }

  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'resources', 'app.asar'))) {
      return dir;
    }
  }
  return path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity');
}

const INSTALL_DIR = resolveInstallDir();
const APP_EXE_PATH = path.join(INSTALL_DIR, 'Antigravity.exe');
const RESOURCES_DIR = path.join(INSTALL_DIR, 'resources');
const DEFAULT_ASAR_PATH = path.join(RESOURCES_DIR, 'app.asar');

const BACKUP_DIR = path.join(__dirname, 'backups');
const HOOK_MAIN_PATH = path.join(__dirname, 'hook-main.js').replace(/\\/g, '/');
const LOG_FILE_PATH = path.join(__dirname, 'runtime.log');
const LOG_PATH_POSIX = LOG_FILE_PATH.replace(/\\/g, '/');
const BOOTSTRAP_PREFIX = '/*AGY_ZHTW_BOOT*/';
const BOOTSTRAP_LINE =
  `${BOOTSTRAP_PREFIX}try{require(${JSON.stringify(HOOK_MAIN_PATH)});}catch(_e){` +
  `try{require("fs").appendFileSync(${JSON.stringify(LOG_PATH_POSIX)},` +
  `"["+new Date().toISOString()+"] [FATAL] hook-main 載入失敗: "+(_e&&_e.stack||_e)+"\\n");` +
  `const _el=require("electron");if(_el&&_el.app&&_el.dialog){` +
  `_el.app.whenReady().then(()=>_el.dialog.showMessageBox({type:"warning",` +
  `title:"Antigravity 繁體中文化載入異常",message:"中文化主程序掛載失敗，已退回英文原版。",` +
  `detail:String(_e&&_e.message||_e)}));}}catch(_){}}\n`;
const ASAR_BLOCK_SIZE = 4194304;

function appendPatchLog(msg) {
  try {
    fs.appendFileSync(LOG_FILE_PATH, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch (_) {}
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function computeAsarIntegrity(buffer) {
  const hash = sha256Hex(buffer);
  const blocks = [];
  for (let offset = 0; offset < buffer.length; offset += ASAR_BLOCK_SIZE) {
    blocks.push(sha256Hex(buffer.subarray(offset, offset + ASAR_BLOCK_SIZE)));
  }
  if (blocks.length === 0) {
    blocks.push(sha256Hex(Buffer.alloc(0)));
  }
  return {
    algorithm: 'SHA256',
    hash,
    blockSize: ASAR_BLOCK_SIZE,
    blocks
  };
}

function align4(n) {
  return (n + 3) & ~3;
}

function writeFileAtomicSync(targetPath, data) {
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, data);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      err.isWritePermissionError = true;
    }
    throw err;
  }
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      try {
        fs.copyFileSync(tmpPath, targetPath);
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (_) {}
        return;
      } catch (copyErr) {
        err = copyErr;
      }
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    throw err;
  }
}

function isAsarIntegrityFuseEnabled(exePath) {
  try {
    if (!exePath || !fs.existsSync(exePath)) return false;
    const buf = fs.readFileSync(exePath);
    const idx = buf.indexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 0, 'ascii');
    if (idx === -1 || idx + 39 > buf.length) return false;
    const wireVersion = buf[idx + 32];
    const wireLength = buf[idx + 33];
    return wireVersion === 1 && wireLength >= 5 && buf[idx + 34 + 4] === 0x31;
  } catch (_) {
    return false;
  }
}

function getCleanPayloadEnd(node, excludeEntry, currentMax = 0) {
  if (!node || typeof node !== 'object' || node === excludeEntry) return currentMax;
  if (node.offset !== undefined && node.size !== undefined) {
    const end = Number(node.offset) + Number(node.size);
    if (end > currentMax) currentMax = end;
  }
  if (node.files && typeof node.files === 'object') {
    for (const child of Object.values(node.files)) {
      currentMax = getCleanPayloadEnd(child, excludeEntry, currentMax);
    }
  }
  return currentMax;
}

function parseAsar(asarBuffer) {
  if (!Buffer.isBuffer(asarBuffer) || asarBuffer.length < 16) {
    throw new Error('無效的 ASAR 檔案格式');
  }
  const b0 = asarBuffer.readUInt32LE(0);
  const b4 = asarBuffer.readUInt32LE(4);
  const jsonLen = asarBuffer.readUInt32LE(12);
  const baseOffset = 8 + b4;

  if (b0 !== 4 || baseOffset > asarBuffer.length || 16 + jsonLen > baseOffset) {
    throw new Error('無效的 ASAR 檔案格式');
  }

  const headerJsonStr = asarBuffer.subarray(16, 16 + jsonLen).toString('utf8');
  const header = JSON.parse(headerJsonStr);
  const payload = asarBuffer.subarray(baseOffset);

  let version = 'unknown';
  let mainRelPath = 'dist/main.js';
  const pkgEntry = header?.files?.['package.json'];
  if (pkgEntry) {
    try {
      const pkgOff = Number(pkgEntry.offset);
      const pkgStr = payload.subarray(pkgOff, pkgOff + Number(pkgEntry.size)).toString('utf8');
      const pkg = JSON.parse(pkgStr);
      version = pkg.version || 'unknown';
      if (typeof pkg.main === 'string' && pkg.main.trim()) {
        mainRelPath = pkg.main.trim().replace(/^\.?\//, '');
      }
    } catch (_) {}
  }

  let mainEntry = header;
  for (const part of mainRelPath.split('/')) {
    mainEntry = mainEntry?.files?.[part];
  }
  if (!mainEntry || mainEntry.offset === undefined) {
    throw new Error(`在 app.asar 中找不到入口項目 (${mainRelPath})`);
  }

  const mainOffset = Number(mainEntry.offset);
  const mainSize = Number(mainEntry.size);
  const mainContent = payload.subarray(mainOffset, mainOffset + mainSize).toString('utf8');

  const isPatched = mainContent.startsWith(BOOTSTRAP_PREFIX);
  const firstLineEnd = mainContent.indexOf('\n');
  const currentBootLine = isPatched && firstLineEnd !== -1 ? mainContent.substring(0, firstLineEnd + 1) : '';
  const isCurrentPath = currentBootLine === BOOTSTRAP_LINE;

  return {
    header,
    payload,
    mainEntry,
    mainContent,
    version,
    isPatched,
    isCurrentPath,
    currentBootLine
  };
}

function rebuildAsarWithMainBuffer(parsed, newMainBuf) {
  const cleanEnd = getCleanPayloadEnd(parsed.header, parsed.mainEntry, 0);
  const basePayload = parsed.payload.subarray(0, cleanEnd);
  const newOffset = basePayload.length;
  parsed.mainEntry.offset = String(newOffset);
  parsed.mainEntry.size = newMainBuf.length;
  parsed.mainEntry.integrity = computeAsarIntegrity(newMainBuf);

  const newHeaderJsonBuf = Buffer.from(JSON.stringify(parsed.header), 'utf8');
  const jsonLen = newHeaderJsonBuf.length;
  const alignedJsonLen = align4(jsonLen);
  const paddingLen = alignedJsonLen - jsonLen;

  const prefixBuf = Buffer.alloc(16);
  prefixBuf.writeUInt32LE(4, 0);
  prefixBuf.writeUInt32LE(alignedJsonLen + 8, 4);
  prefixBuf.writeUInt32LE(alignedJsonLen + 4, 8);
  prefixBuf.writeUInt32LE(jsonLen, 12);

  const paddingBuf = Buffer.alloc(paddingLen, 0);
  return Buffer.concat([
    prefixBuf,
    newHeaderJsonBuf,
    paddingBuf,
    basePayload,
    newMainBuf
  ]);
}

function stripBootstrapLine(mainContent) {
  if (!mainContent.startsWith(BOOTSTRAP_PREFIX)) {
    return mainContent;
  }
  const firstNewline = mainContent.indexOf('\n');
  return firstNewline !== -1 ? mainContent.substring(firstNewline + 1) : mainContent;
}

function buildPatchedAsarBuffer(asarBuffer) {
  const parsed = parseAsar(asarBuffer);
  const cleanMainStr = stripBootstrapLine(parsed.mainContent);
  const newMainBuf = Buffer.from(BOOTSTRAP_LINE + cleanMainStr, 'utf8');
  return {
    buffer: rebuildAsarWithMainBuffer(parsed, newMainBuf),
    version: parsed.version
  };
}

function buildRestoredAsarBuffer(asarBuffer) {
  const parsed = parseAsar(asarBuffer);
  if (!parsed.isPatched) {
    return { buffer: asarBuffer, version: parsed.version, changed: false };
  }
  const cleanMainStr = stripBootstrapLine(parsed.mainContent);
  const cleanMainBuf = Buffer.from(cleanMainStr, 'utf8');
  return {
    buffer: rebuildAsarWithMainBuffer(parsed, cleanMainBuf),
    version: parsed.version,
    changed: true
  };
}

function getVersionBackupPath(version) {
  return path.join(BACKUP_DIR, `app.asar.v${version}.bak`);
}

function pruneOldBackups(currentVersion) {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const keepFileName = `app.asar.v${currentVersion}.bak`;
  try {
    for (const file of fs.readdirSync(BACKUP_DIR)) {
      if (file.endsWith('.bak') && file !== keepFileName) {
        try {
          fs.unlinkSync(path.join(BACKUP_DIR, file));
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function getAutoTranslateSetting() {
  try {
    const dictPath = path.join(__dirname, 'zh-tw.json');
    if (!fs.existsSync(dictPath)) return false;
    const raw = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
    const val = raw?._meta?.auto_translate;
    if (val === 'gemini') return 'gemini';
    if (val === 'mymemory' || val === true) return 'mymemory';
    return false;
  } catch (_) {
    return false;
  }
}

function formatAutoTranslateStatus(mode, detailed = false) {
  if (mode === 'gemini') {
    return detailed
      ? '[開啟: Gemini API (Gemini Flash)] 新版未譯詞條將自動翻譯寫入 "auto" 區'
      : '[開啟: Gemini API]';
  }
  if (mode === 'mymemory') {
    return detailed
      ? '[開啟: MyMemory 免費翻譯服務] 新版未譯詞條將自動翻譯寫入 "auto" 區'
      : '[開啟: MyMemory 免費服務]';
  }
  return detailed ? '[關閉] 僅掃描列出未譯英文，不呼叫外部翻譯' : '[關閉]';
}

function findValidBackup(expectedVersion = null) {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  if (expectedVersion) {
    const exactPath = getVersionBackupPath(expectedVersion);
    if (fs.existsSync(exactPath)) {
      try {
        const buf = fs.readFileSync(exactPath);
        const parsed = parseAsar(buf);
        if (parsed.version === expectedVersion && !parsed.isPatched) {
          return { path: exactPath, buffer: buf, parsed };
        }
      } catch (_) {}
    }
    return null;
  }

  try {
    const candidates = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('app.asar.v') && f.endsWith('.bak'))
      .sort()
      .reverse();
    for (const file of candidates) {
      const fullPath = path.join(BACKUP_DIR, file);
      try {
        const buf = fs.readFileSync(fullPath);
        const parsed = parseAsar(buf);
        if (!parsed.isPatched) {
          return { path: fullPath, buffer: buf, parsed };
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function checkStatus(asarPath = DEFAULT_ASAR_PATH) {
  console.log('==================================================');
  console.log(' Antigravity 繁體中文化狀態檢查');
  console.log('==================================================');
  if (!fs.existsSync(asarPath)) {
    console.log('狀態: [錯誤] 找不到 app.asar：' + asarPath);
    return { isPatched: false, isCurrentPath: false };
  }
  const autoTrans = getAutoTranslateSetting();
  let parsed;
  try {
    const buf = fs.readFileSync(asarPath);
    parsed = parseAsar(buf);
  } catch (err) {
    const fallbackBak = findValidBackup(null);
    console.log('安裝目錄位置:   ' + INSTALL_DIR);
    console.log('繁中掛載狀態:   [損毀或結構變更] ' + err.message + ' (請選 [2] 嘗試從備份還原)');
    console.log(
      '可用備份狀態:   ' +
        (fallbackBak
          ? `[已就緒] backups/${path.basename(fallbackBak.path)} (v${fallbackBak.parsed.version})`
          : '[無可用備份]')
    );
    console.log('==================================================');
    return { isPatched: false, isCurrentPath: false, corrupted: true };
  }
  const verBackupPath = getVersionBackupPath(parsed.version);

  console.log('安裝目錄位置:   ' + INSTALL_DIR);
  console.log('目前軟體版本:   v' + parsed.version);
  if (parsed.isPatched && parsed.isCurrentPath) {
    console.log('繁中掛載狀態:   [已掛載] 路徑一致且正常生效');
  } else if (parsed.isPatched && !parsed.isCurrentPath) {
    console.log('繁中掛載狀態:   [需更新] 偵測到目錄搬移，引導仍指向舊路徑 (請選 [1] 更新)');
  } else {
    console.log('繁中掛載狀態:   [未掛載] 官方英文原版狀態 (請選 [1] 套用掛載)');
  }
  console.log(
    '同版備份狀態:   ' +
      (fs.existsSync(verBackupPath) ? `[已就緒] backups/app.asar.v${parsed.version}.bak` : '[無備份] 套用時將自動建立')
  );
  const dictPath = path.join(__dirname, 'zh-tw.json');
  console.log('外部字典狀態:   ' + (fs.existsSync(dictPath) ? '[正常] ' + dictPath : '[遺失] 找不到 zh-tw.json'));
  console.log('自動翻譯模式:   ' + formatAutoTranslateStatus(autoTrans, true));
  console.log('==================================================');
  return { isPatched: parsed.isPatched, isCurrentPath: parsed.isCurrentPath, version: parsed.version };
}

function applyPatch(asarPath = DEFAULT_ASAR_PATH, options = {}) {
  const silent = Boolean(options.silent);
  const reportErr = (msg) => {
    if (options.errorRef && typeof options.errorRef === 'object') {
      options.errorRef.message = msg;
    }
    if (!silent) console.error(msg);
  };

  if (!fs.existsSync(asarPath)) {
    reportErr('找不到 app.asar：' + asarPath);
    return false;
  }

  let origBuf;
  let parsed;
  try {
    origBuf = fs.readFileSync(asarPath);
    parsed = parseAsar(origBuf);
  } catch (err) {
    reportErr('解析 app.asar 失敗（可能因官方改版變更封包結構）：' + err.message);
    return false;
  }

  if (parsed.isPatched && parsed.isCurrentPath) {
    pruneOldBackups(parsed.version);
    if (!silent) {
      console.log('app.asar 已包含當前路徑之繁體中文化引導，無需重複套用。');
    }
    return true;
  }

  const candidateExe =
    asarPath === DEFAULT_ASAR_PATH
      ? APP_EXE_PATH
      : path.resolve(path.dirname(asarPath), '..', 'Antigravity.exe');
  if (isAsarIntegrityFuseEnabled(candidateExe)) {
    reportErr(
      '官方新版已啟用 Electron ASAR 完整性校驗 (Fuse)，無法修改 app.asar，已保留英文原版以確保正常啟動。'
    );
    return false;
  }

  const { buffer: newBuf } = buildPatchedAsarBuffer(origBuf);

  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const versionBackupPath = getVersionBackupPath(parsed.version);
    if (!fs.existsSync(versionBackupPath) && !parsed.isPatched) {
      writeFileAtomicSync(versionBackupPath, origBuf);
      if (!silent) {
        console.log(`已建立 v${parsed.version} 原版備份：${versionBackupPath}`);
      }
    }
    pruneOldBackups(parsed.version);

    writeFileAtomicSync(asarPath, newBuf);
    if (!silent) {
      console.log('成功套用繁體中文化引導 (v' + parsed.version + ')。');
    }
    return true;
  } catch (err) {
    if (err.isWritePermissionError || err.code === 'EACCES') {
      reportErr(
        '無法寫入檔案：目錄權限不足，請右鍵以系統管理員身分執行 Antigravity-zhTW.cmd。'
      );
    } else if (err.code === 'EBUSY' || err.code === 'EPERM') {
      reportErr('無法寫入 app.asar：檔案目前被執行中的 Antigravity 程序鎖定。');
    } else {
      reportErr('寫入 app.asar 失敗：' + err.message);
    }
    return false;
  }
}

function restorePatch(asarPath = DEFAULT_ASAR_PATH) {
  if (!fs.existsSync(asarPath)) {
    console.error('[錯誤] 找不到 app.asar：', asarPath);
    return false;
  }

  let currentBuf = null;
  let parsed = null;
  try {
    currentBuf = fs.readFileSync(asarPath);
    parsed = parseAsar(currentBuf);
  } catch (_) {}

  try {
    const targetVersion = parsed ? parsed.version : null;
    const validBak = findValidBackup(targetVersion);
    if (validBak) {
      writeFileAtomicSync(asarPath, validBak.buffer);
      pruneOldBackups(validBak.parsed.version);
      console.log(`已從同版本備份 (v${validBak.parsed.version}) 完整還原官方原版 app.asar。`);
      return true;
    }

    if (!parsed) {
      console.error('還原失敗：app.asar 已損毀且找不到可用的備份檔。');
      return false;
    }

    const restored = buildRestoredAsarBuffer(currentBuf);
    if (!restored.changed) {
      console.log('目前 app.asar 已是官方原版狀態，無需還原。');
      return true;
    }
    writeFileAtomicSync(asarPath, restored.buffer);
    pruneOldBackups(parsed.version);
    console.log(`已原位無損移除引導行，恢復 v${parsed.version} 官方英文原版狀態。`);
    return true;
  } catch (err) {
    if (err.isWritePermissionError || err.code === 'EACCES') {
      console.error(
        '還原失敗：目錄權限不足，請右鍵以系統管理員身分執行 Antigravity-zhTW.cmd。'
      );
    } else if (err.code === 'EBUSY' || err.code === 'EPERM') {
      console.error('還原失敗：app.asar 目前被執行中的 Antigravity 鎖定，請先關閉視窗。');
    } else {
      console.error('還原失敗：', err.message);
    }
    return false;
  }
}

function getDefaultShortcutTargets() {
  const targets = [];
  if (process.env.USERPROFILE) {
    targets.push(path.join(process.env.USERPROFILE, 'Desktop', 'Antigravity.lnk'));
  }
  for (const od of [process.env.OneDriveConsumer, process.env.OneDrive]) {
    if (od) {
      targets.push(path.join(od, 'Desktop', 'Antigravity.lnk'));
    }
  }
  if (process.env.APPDATA) {
    targets.push(
      path.join(
        process.env.APPDATA,
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Antigravity.lnk'
      )
    );
  }
  return Array.from(new Set(targets));
}

function isPossiblyHijackedLnk(lnkPath) {
  try {
    if (!fs.existsSync(lnkPath)) return false;
    const buf = fs.readFileSync(lnkPath);
    return (
      buf.includes('patch-asar.js') || buf.includes(Buffer.from('patch-asar.js', 'utf16le'))
    );
  } catch (_) {
    return false;
  }
}

function restoreLegacyShortcuts(options = {}) {
  const silent = Boolean(options.silent);
  const candidates = Array.isArray(options.targets)
    ? options.targets
    : getDefaultShortcutTargets();
  const matched = candidates.filter(isPossiblyHijackedLnk);
  if (matched.length === 0) return true;

  const psScript = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$targets = $env:AGY_RESTORE_TARGETS -split '\\|'",
    '$sh = New-Object -ComObject WScript.Shell',
    'foreach ($lnkPath in $targets) {',
    '  if ($lnkPath -and (Test-Path -LiteralPath $lnkPath)) {',
    '    $lnk = $sh.CreateShortcut($lnkPath)',
    "    if ($lnk.TargetPath -match 'powershell' -and $lnk.Arguments -match 'patch-asar\\.js') {",
    '      $lnk.TargetPath = $env:AGY_RESTORE_EXE',
    "      $lnk.Arguments = ''",
    '      $lnk.WindowStyle = 1',
    '      $lnk.WorkingDirectory = $env:AGY_RESTORE_DIR',
    '      if (Test-Path -LiteralPath $env:AGY_RESTORE_EXE) {',
    '        $lnk.IconLocation = "$env:AGY_RESTORE_EXE,0"',
    '      }',
    "      $lnk.Description = 'Antigravity'",
    '      $lnk.Save()',
    '      Write-Output $lnkPath',
    '    }',
    '  }',
    '}'
  ].join('\n');

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          AGY_RESTORE_TARGETS: matched.join('|'),
          AGY_RESTORE_EXE: options.exePath || APP_EXE_PATH,
          AGY_RESTORE_DIR: options.installDir || INSTALL_DIR
        }
      }
    ).trim();
    if (out && !silent) {
      console.log('已將舊版捷徑還原為官方預設：\n  ' + out.split(/\r?\n/).join('\n  '));
    }
    return true;
  } catch (err) {
    if (!silent) {
      console.error('還原舊版捷徑失敗：', err.message);
    }
    return false;
  }
}

function isAntigravityRunning() {
  try {
    const out = execFileSync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq Antigravity.exe', '/FI', `PID ne ${process.pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true }
    );
    return out
      .split(/\r?\n/)
      .some((l) => l.trim().toLowerCase().startsWith('"antigravity.exe",'));
  } catch (_) {
    return false;
  }
}

function requestGracefulCloseAntigravity() {
  try {
    execFileSync(
      'taskkill.exe',
      ['/IM', 'Antigravity.exe', '/FI', `PID ne ${process.pid}`],
      { stdio: 'ignore', windowsHide: true }
    );
  } catch (_) {}
}

function killBackgroundAntigravity() {
  try {
    execFileSync(
      'taskkill.exe',
      ['/IM', 'Antigravity.exe', '/FI', `PID ne ${process.pid}`, '/F'],
      { stdio: 'ignore', windowsHide: true }
    );
  } catch (_) {}
}

function launchAppDetached(exePath = APP_EXE_PATH) {
  if (!fs.existsSync(exePath)) return false;
  const cleanEnv = { ...process.env };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'AGY_OLD_PID',
    'AGY_INST_PID',
    'AGY_INST_NAME',
    'AGY_APP_EXE',
    'AGY_PATCH_JS',
    'AGY_UPDATE_MODE'
  ]) {
    delete cleanEnv[key];
  }
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(exePath),
    env: cleanEnv
  });
  child.unref();
  return true;
}

function stopAndRunWithRestart(actionFn, doneCallback, options = {}) {
  const silent = Boolean(options.silent);
  if (!silent) console.log('正在關閉執行中的 Antigravity...');
  requestGracefulCloseAntigravity();

  let attempts = 0;
  const tryAction = () => {
    attempts++;
    if (isAntigravityRunning() && attempts < 12) {
      if (attempts === 3) {
        requestGracefulCloseAntigravity();
      } else if (attempts >= 6) {
        killBackgroundAntigravity();
      }
      return setTimeout(tryAction, 300);
    }
    const ok = actionFn();
    if (!ok && attempts < 12 && isAntigravityRunning()) {
      killBackgroundAntigravity();
      return setTimeout(tryAction, 300);
    }
    if (ok && fs.existsSync(APP_EXE_PATH)) {
      if (!silent) console.log('正在重新啟動 Antigravity...');
      launchAppDetached();
    }
    doneCallback(ok);
  };
  setTimeout(tryAction, 300);
}

function runPostUpdate(mode = 'restart', asarPath = DEFAULT_ASAR_PATH, deps = {}) {
  const checkRunning = deps.isRunning || isAntigravityRunning;
  const launchApp = deps.launchApp || launchAppDetached;
  const stopAndRestart =
    deps.stopAndRestart ||
    ((fn, cb) => stopAndRunWithRestart(fn, cb, { silent: true }));

  if (!fs.existsSync(asarPath)) {
    appendPatchLog('[ERROR] 更新後自動套用失敗，找不到 app.asar：' + asarPath);
    return Promise.resolve(false);
  }

  let parsed;
  try {
    parsed = parseAsar(fs.readFileSync(asarPath));
  } catch (err) {
    appendPatchLog('[ERROR] 更新後解析 app.asar 失敗：' + err.message);
    return Promise.resolve(false);
  }

  if (parsed.isPatched && parsed.isCurrentPath) {
    pruneOldBackups(parsed.version);
    return Promise.resolve(true);
  }

  if (checkRunning()) {
    if (mode !== 'restart') {
      appendPatchLog('略過背景自動套用：偵測到已有執行中之 Antigravity 視窗');
      return Promise.resolve(false);
    }
    appendPatchLog(`偵測到新版 v${parsed.version} 視窗已開啟，正在重新套用繁體中文並重啟`);
    return new Promise((resolve) => {
      const errorRef = { message: '' };
      stopAndRestart(
        () => applyPatch(asarPath, { silent: true, errorRef }),
        (ok) => {
          if (ok) {
            appendPatchLog(`已完成 v${parsed.version} 更新後繁體中文套用並重啟`);
          } else {
            appendPatchLog('[ERROR] ' + (errorRef.message || '更新後重啟套用繁體中文失敗'));
          }
          resolve(ok);
        }
      );
    });
  }

  const errorRef = { message: '' };
  const ok = applyPatch(asarPath, { silent: true, errorRef });
  if (ok) {
    appendPatchLog(`已於背景完成 v${parsed.version} 更新後繁體中文套用 (mode=${mode})`);
    if (mode === 'restart') {
      launchApp();
    }
  } else {
    appendPatchLog('[ERROR] ' + (errorRef.message || '更新後背景套用繁體中文失敗'));
  }
  return Promise.resolve(ok);
}

function handleLegacyLaunch() {
  restoreLegacyShortcuts({ silent: true });
  try {
    if (fs.existsSync(DEFAULT_ASAR_PATH) && !isAntigravityRunning()) {
      const parsed = parseAsar(fs.readFileSync(DEFAULT_ASAR_PATH));
      if (!parsed.isPatched || !parsed.isCurrentPath) {
        if (applyPatch(DEFAULT_ASAR_PATH, { silent: true })) {
          appendPatchLog(`由舊版捷徑補回 v${parsed.version} 繁體中文化並還原為官方預設捷徑`);
        }
      }
    }
  } catch (_) {}
  return launchAppDetached();
}

function applyAndCleanShortcuts() {
  const ok = applyPatch();
  if (ok) restoreLegacyShortcuts();
  return ok;
}

function restoreAndCleanShortcuts() {
  const ok = restorePatch();
  if (ok) restoreLegacyShortcuts();
  return ok;
}

function closeAndPatch(actionFn, rl, callback) {
  if (!isAntigravityRunning()) {
    actionFn();
    return callback();
  }
  rl.question('\n偵測到 Antigravity 正在執行中，是否自動關閉、套用變更並重新啟動？ (Y/n): ', (ans) => {
    const yes = !ans.trim() || ans.trim().toLowerCase() === 'y';
    if (!yes) {
      console.log('已取消操作，請先手動關閉 Antigravity 視窗後再試。');
      return callback();
    }
    stopAndRunWithRestart(actionFn, () => callback());
  });
}

function printMenuOptions() {
  const autoState = formatAutoTranslateStatus(getAutoTranslateSetting(), false);
  console.log('\n請選擇操作項目：');
  console.log('  [1] 套用 / 修復繁體中文化');
  console.log('  [2] 還原為官方英文原版');
  console.log('  [3] 掃描新版未翻譯詞條與檢查字典');
  console.log(`  [4] 設定「新詞條自動翻譯」模式 (目前狀態: ${autoState})`);
  console.log('  [0] 離開');
}

function runInteractiveMenu() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const waitAndReturn = () => {
    rl.question('\n請按 Enter 鍵返回選單...', () => promptMenu());
  };

  const promptMenu = () => {
    console.log('');
    checkStatus();
    printMenuOptions();

    rl.question('\n請輸入選項數字 (0-4): ', async (answer) => {
      const choice = answer.trim();
      console.log('');
      if (choice === '1') {
        closeAndPatch(applyAndCleanShortcuts, rl, waitAndReturn);
      } else if (choice === '2') {
        closeAndPatch(restoreAndCleanShortcuts, rl, waitAndReturn);
      } else if (choice === '3') {
        try {
          const { runScan } = require('./scan-ui-strings.js');
          await runScan({ sync: true });
        } catch (e) {
          console.error('執行掃描失敗:', e.message);
        }
        waitAndReturn();
      } else if (choice === '4') {
        try {
          const { promptAutoTranslateMenu } = require('./scan-ui-strings.js');
          await promptAutoTranslateMenu(rl);
        } catch (e) {
          console.error('設定自動翻譯模式失敗:', e.message);
        }
        waitAndReturn();
      } else {
        rl.close();
        console.log('已結束管理工具。');
      }
    });
  };

  promptMenu();
}

if (require.main === module) {
  const arg = process.argv[2];
  const forceRestart = process.argv.includes('--force-restart');
  if (arg === '--apply') {
    if (forceRestart && isAntigravityRunning()) {
      stopAndRunWithRestart(applyAndCleanShortcuts, (ok) => process.exit(ok ? 0 : 1));
    } else {
      process.exit(applyAndCleanShortcuts() ? 0 : 1);
    }
  } else if (arg === '--post-update') {
    const mode = process.argv[3] === 'silent' ? 'silent' : 'restart';
    runPostUpdate(mode)
      .then((ok) => process.exit(ok ? 0 : 1))
      .catch((err) => {
        appendPatchLog(
          '[ERROR] 更新後自動套用發生錯誤：' + (err && err.message ? err.message : String(err))
        );
        process.exit(1);
      });
  } else if (arg === '--launch') {
    process.exit(handleLegacyLaunch() ? 0 : 1);
  } else if (arg === '--restore') {
    if (forceRestart && isAntigravityRunning()) {
      stopAndRunWithRestart(restoreAndCleanShortcuts, (ok) => process.exit(ok ? 0 : 1));
    } else {
      process.exit(restoreAndCleanShortcuts() ? 0 : 1);
    }
  } else if (arg === '--status') {
    checkStatus();
  } else if (arg === '--menu-prompt') {
    checkStatus();
    printMenuOptions();
  } else if (arg === '--scan') {
    const { runScan } = require('./scan-ui-strings.js');
    const showDynamic = process.argv.includes('--dynamic');
    runScan({ sync: true, showDynamic }).catch((err) => {
      console.error('[錯誤]', err.message);
      process.exit(1);
    });
  } else if (arg === '--auto-translate') {
    const { runScan } = require('./scan-ui-strings.js');
    runScan({ sync: true, autoTranslate: true }).catch((err) => {
      console.error('[錯誤]', err.message);
      process.exit(1);
    });
  } else if (arg === '--set-auto-translate') {
    const { setAutoTranslateMode } = require('./scan-ui-strings.js');
    setAutoTranslateMode(process.argv[3], process.argv[4])
      .then((ok) => process.exit(ok ? 0 : 1))
      .catch((err) => {
        console.error('[錯誤]', err.message);
        process.exit(1);
      });
  } else {
    runInteractiveMenu();
  }
}

module.exports = {
  BOOTSTRAP_LINE,
  parseAsar,
  buildPatchedAsarBuffer,
  buildRestoredAsarBuffer,
  computeAsarIntegrity,
  isAsarIntegrityFuseEnabled,
  applyPatch,
  restorePatch,
  restoreLegacyShortcuts,
  runPostUpdate
};
