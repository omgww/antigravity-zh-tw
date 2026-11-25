(function () {
  let electron;
  try {
    electron = require('electron');
  } catch (_) {
    return;
  }

  if (!electron || typeof electron !== 'object' || !electron.app) {
    return;
  }

  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  const DICT_PATH = path.join(__dirname, 'zh-tw.json');
  const DOM_SCRIPT_PATH = path.join(__dirname, 'dom-translator.js');
  const SCAN_SCRIPT_PATH = path.join(__dirname, 'scan-ui-strings.js');
  const PATCH_SCRIPT_PATH = path.join(__dirname, 'patch-asar.js');
  const LOG_PATH = path.join(__dirname, 'runtime.log');
  const MAX_LOG_BYTES = 128 * 1024;
  const KEEP_LOG_BYTES = 64 * 1024;

  function writeLog(msg) {
    try {
      if (fs.existsSync(LOG_PATH)) {
        const stat = fs.statSync(LOG_PATH);
        if (stat.size > MAX_LOG_BYTES) {
          const buf = fs.readFileSync(LOG_PATH);
          const sliced = buf.subarray(buf.length - KEEP_LOG_BYTES).toString('utf8');
          const firstNewline = sliced.indexOf('\n');
          fs.writeFileSync(
            LOG_PATH,
            firstNewline !== -1 ? sliced.substring(firstNewline + 1) : sliced,
            'utf8'
          );
        }
      }
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      fs.appendFileSync(LOG_PATH, line, 'utf8');
    } catch (_) {}
  }

  writeLog('hook-main.js 已於主程序啟動');

  let rawDict = {};
  let cachedDictJson = '{}';
  let cachedDomScript = '';
  let cachedDomMtimeMs = 0;
  let appMenuDict = Object.create(null);
  let contextMenuDict = Object.create(null);
  let lastDictError = null;

  function loadDomScriptCache() {
    try {
      const stat = fs.statSync(DOM_SCRIPT_PATH);
      if (!cachedDomScript || stat.mtimeMs !== cachedDomMtimeMs) {
        cachedDomScript = fs.readFileSync(DOM_SCRIPT_PATH, 'utf8');
        cachedDomMtimeMs = stat.mtimeMs;
      }
      return true;
    } catch (err) {
      writeLog('讀取 dom-translator.js 失敗: ' + err.message);
      return false;
    }
  }

  function loadDictionary() {
    try {
      const content = fs.readFileSync(DICT_PATH, 'utf8');
      const parsed = JSON.parse(content);
      rawDict = parsed;
      cachedDictJson = JSON.stringify(parsed);
      appMenuDict = Object.create(null);
      contextMenuDict = Object.create(null);
      lastDictError = null;

      for (const [sectionKey, sectionVal] of Object.entries(rawDict)) {
        if (sectionKey.startsWith('_') || sectionKey === 'menu') continue;
        if (typeof sectionVal === 'string' && sectionVal.trim()) {
          contextMenuDict[sectionKey.trim()] = sectionVal.trim();
        } else if (sectionVal && typeof sectionVal === 'object') {
          for (const [en, zh] of Object.entries(sectionVal)) {
            if (typeof zh === 'string' && zh.trim()) {
              const cleanEn = en.trim();
              if (sectionKey === 'auto' && contextMenuDict[cleanEn]) continue;
              contextMenuDict[cleanEn] = zh.trim();
            }
          }
        }
      }
      if (rawDict.menu && typeof rawDict.menu === 'object') {
        for (const [en, zh] of Object.entries(rawDict.menu)) {
          if (typeof zh === 'string' && zh.trim()) {
            const cleanEn = en.trim();
            const cleanZh = zh.trim();
            appMenuDict[cleanEn] = cleanZh;
            contextMenuDict[cleanEn] = cleanZh;
          }
        }
      }
      return true;
    } catch (err) {
      lastDictError = err.message;
      writeLog('讀取 zh-tw.json 失敗: ' + err.message);
      return false;
    }
  }

  function translateMenuLabel(label, dict = appMenuDict) {
    if (!label || typeof label !== 'string') return label;
    const trimmed = label.trim();
    if (dict[trimmed]) {
      return dict[trimmed];
    }
    if (trimmed.includes('&')) {
      const clean = trimmed.replace(/&/g, '');
      if (dict[clean]) {
        return dict[clean];
      }
    }
    if (trimmed.endsWith('…')) {
      const asDots = trimmed.slice(0, -1) + '...';
      if (dict[asDots]) {
        return dict[asDots];
      }
    }
    if (trimmed.endsWith('...')) {
      const asEllipsis = trimmed.slice(0, -3) + '…';
      if (dict[asEllipsis]) {
        return dict[asEllipsis];
      }
    }
    if (trimmed.endsWith('…') || trimmed.endsWith('...')) {
      const base = trimmed.replace(/(?:\.\.\.|…)$/, '').trim();
      if (dict[base]) {
        return dict[base] + '...';
      }
    }
    const agentMatch = trimmed.match(/^(\d+)\s+agents?\s+running$/i);
    if (agentMatch) {
      return `${agentMatch[1]} 個代理執行中`;
    }
    return label;
  }

  function isRendererContextTemplate(template) {
    if (!Array.isArray(template) || template.length === 0) return false;
    let hasItem = false;
    for (const it of template) {
      if (!it || it.type === 'separator') continue;
      hasItem = true;
      if (typeof it.id !== 'string' || !it.id || it.role) return false;
    }
    return hasItem;
  }

  function resolveItemOrigLabel(item, fallbackOrig) {
    if (!item || typeof item !== 'object') return fallbackOrig;
    if (
      item.__agyTranslatedLabel !== undefined &&
      typeof item.label === 'string' &&
      item.label !== item.__agyTranslatedLabel
    ) {
      return item.label;
    }
    return item.__agyOrigLabel || fallbackOrig || item.label;
  }

  function wrapMenuItemClick(item, origLabel) {
    if (!item || typeof item.click !== 'function' || item.click.__agyWrapped) {
      return;
    }
    const origClick = item.click;
    const wrapped = function (menuItem, browserWindow, event) {
      if (menuItem && typeof menuItem === 'object') {
        const effectiveOrig = resolveItemOrigLabel(menuItem, origLabel);
        const itemProxy = new Proxy(menuItem, {
          get(target, prop) {
            if (prop === 'label') return effectiveOrig;
            const val = target[prop];
            return typeof val === 'function' ? val.bind(target) : val;
          }
        });
        return origClick.call(this, itemProxy, browserWindow, event);
      }
      return origClick.call(this, menuItem, browserWindow, event);
    };
    wrapped.__agyWrapped = true;
    item.click = wrapped;
  }

  function translateMenuTemplate(template, dict = appMenuDict) {
    if (!Array.isArray(template)) return template;
    return template.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const cloned = { ...item };
      if (typeof cloned.label === 'string') {
        const origLabel = cloned.__agyOrigLabel || cloned.label;
        cloned.__agyOrigLabel = origLabel;
        cloned.label = translateMenuLabel(origLabel, dict);
        cloned.__agyTranslatedLabel = cloned.label;
        wrapMenuItemClick(cloned, origLabel);
      }
      if (Array.isArray(cloned.submenu)) {
        cloned.submenu = translateMenuTemplate(cloned.submenu, dict);
      }
      return cloned;
    });
  }

  function enhanceMenuInstance(menu) {
    if (!menu || typeof menu !== 'object') return menu;

    if (Array.isArray(menu.items) && !menu.items.__agyFindEnhanced) {
      const origFind = menu.items.find.bind(menu.items);
      Object.defineProperty(menu.items, 'find', {
        configurable: true,
        writable: true,
        value: function (predicate, thisArg) {
          const directHit = origFind(predicate, thisArg);
          if (directHit) return directHit;
          for (let i = 0; i < this.length; i++) {
            const item = this[i];
            if (!item || typeof item !== 'object') continue;
            const origLabel = resolveItemOrigLabel(item);
            if (!origLabel || origLabel === item.label) continue;
            const proxy = new Proxy(item, {
              get(target, prop) {
                if (prop === 'label') return origLabel;
                const val = target[prop];
                return typeof val === 'function' ? val.bind(target) : val;
              }
            });
            try {
              if (predicate.call(thisArg, proxy, i, this)) {
                return item;
              }
            } catch (_) {}
          }
          return undefined;
        }
      });
      Object.defineProperty(menu.items, '__agyFindEnhanced', {
        value: true,
        enumerable: false
      });
    }

    if (typeof menu.insert === 'function' && !menu.__agyInsertHooked) {
      menu.__agyInsertHooked = true;
      const origInsert = menu.insert.bind(menu);
      menu.insert = function (pos, item) {
        translateSingleMenuItem(item);
        const res = origInsert(pos, item);
        enhanceMenuInstance(menu);
        return res;
      };
    }

    if (typeof menu.append === 'function' && !menu.__agyAppendHooked) {
      menu.__agyAppendHooked = true;
      const origAppend = menu.append.bind(menu);
      menu.append = function (item) {
        translateSingleMenuItem(item);
        const res = origAppend(item);
        enhanceMenuInstance(menu);
        return res;
      };
    }

    return menu;
  }

  function translateSingleMenuItem(item, knownOrigLabel, sourceSubmenuTemplate, dict = appMenuDict) {
    if (!item || typeof item !== 'object') return item;
    if (typeof item.label === 'string') {
      if (typeof knownOrigLabel === 'string' && knownOrigLabel) {
        item.__agyOrigLabel = knownOrigLabel;
      } else {
        item.__agyOrigLabel = resolveItemOrigLabel(item);
      }
      wrapMenuItemClick(item, item.__agyOrigLabel);
      const nextLabel = translateMenuLabel(item.__agyOrigLabel, dict);
      if (nextLabel !== item.label) {
        try {
          item.label = nextLabel;
        } catch (_) {}
      }
      item.__agyTranslatedLabel = item.label;
    }
    if (item.submenu) {
      translateMenuInstance(item.submenu, sourceSubmenuTemplate, dict);
    }
    return item;
  }

  function translateMenuInstance(menu, sourceTemplate, dict = appMenuDict) {
    if (!menu || !Array.isArray(menu.items)) return menu;
    enhanceMenuInstance(menu);
    for (let i = 0; i < menu.items.length; i++) {
      const tplItem = Array.isArray(sourceTemplate) ? sourceTemplate[i] : undefined;
      const knownOrig =
        tplItem && typeof tplItem === 'object'
          ? tplItem.__agyOrigLabel || (typeof tplItem.label === 'string' ? tplItem.label : undefined)
          : undefined;
      translateSingleMenuItem(menu.items[i], knownOrig, tplItem && tplItem.submenu, dict);
    }
    return menu;
  }

  function hookElectronMenu() {
    const { Menu, Tray } = electron;
    if (Menu && !Menu.__agyZhTwHooked) {
      Menu.__agyZhTwHooked = true;

      const origBuildFromTemplate = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = function (template) {
        const dict = isRendererContextTemplate(template) ? contextMenuDict : appMenuDict;
        const translatedTemplate = translateMenuTemplate(template, dict);
        const menu = origBuildFromTemplate(translatedTemplate);
        return translateMenuInstance(menu, translatedTemplate, dict);
      };

      const origSetApplicationMenu = Menu.setApplicationMenu.bind(Menu);
      Menu.setApplicationMenu = function (menu) {
        if (menu) {
          translateMenuInstance(menu);
        }
        return origSetApplicationMenu(menu);
      };

      const origGetApplicationMenu = Menu.getApplicationMenu.bind(Menu);
      Menu.getApplicationMenu = function () {
        const menu = origGetApplicationMenu();
        if (menu) {
          enhanceMenuInstance(menu);
        }
        return menu;
      };
    }

    if (Tray && Tray.prototype && !Tray.prototype.__agyZhTwHooked) {
      Tray.prototype.__agyZhTwHooked = true;
      const origSetContextMenu = Tray.prototype.setContextMenu;
      if (typeof origSetContextMenu === 'function') {
        Tray.prototype.setContextMenu = function (menu) {
          if (menu) {
            translateMenuInstance(menu);
          }
          return origSetContextMenu.call(this, menu);
        };
      }
    }
  }

  let injectedHubCount = 0;
  let lastInjectError = '';
  let watchdogAlertShown = false;
  const reportedHealthUrls = new Set();

  function isHubWebContents(contents) {
    if (!contents || contents.isDestroyed()) return false;
    if (typeof contents.getType === 'function' && contents.getType() === 'webview') return false;
    if (contents.hostWebContents) return false;
    if (
      electron.session &&
      electron.session.defaultSession &&
      contents.session &&
      contents.session !== electron.session.defaultSession
    ) {
      return false;
    }
    const url = contents.getURL() || '';
    return /^https:\/\/127\.0\.0\.1:\d+(\/|$)/i.test(url);
  }

  function verifyRendererHealth(contents, url, attempt = 1) {
    if (!contents || contents.isDestroyed() || reportedHealthUrls.has(url)) return;
    contents
      .executeJavaScript(
        'window.__AGY_ZHTW__ && typeof window.__AGY_ZHTW__.getHealthReport === "function" ? window.__AGY_ZHTW__.getHealthReport() : null'
      )
      .then((report) => {
        if (!report) return;
        if (report.status === 'pending' && attempt < 3) {
          setTimeout(() => verifyRendererHealth(contents, url, attempt + 1), 3500);
          return;
        }
        if (report.status === 'zero_hits' || report.status === 'empty_dict') {
          reportedHealthUrls.add(url);
          writeLog(
            `[ALERT] 前端翻譯健檢異常 (${report.status}): url=${url}, translated=${report.translatedCount}, dictSize=${report.dictSize}`
          );
        }
      })
      .catch(() => {});
  }

  function injectIntoWebContents(contents) {
    if (!isHubWebContents(contents)) return;
    const url = contents.getURL() || '';

    try {
      if (!loadDomScriptCache()) {
        lastInjectError = '無法讀取 dom-translator.js';
        return;
      }

      const code = `
        (function() {
          var didInit = false;
          if (!window.__AGY_ZHTW__ || !window.__AGY_ZHTW__.initialized) {
            ${cachedDomScript}
            if (window.__AGY_ZHTW__ && typeof window.__AGY_ZHTW__.init === 'function') {
              window.__AGY_ZHTW__.init(${cachedDictJson});
              didInit = true;
            }
          }
          return {
            didInit: didInit,
            active: Boolean(window.__AGY_ZHTW__ && window.__AGY_ZHTW__.initialized)
          };
        })();
      `;

      contents
        .executeJavaScript(code)
        .then((res) => {
          if (res && res.active) {
            injectedHubCount++;
          }
          if (res && res.didInit) {
            writeLog(`已初始化翻譯引擎至: ${url}`);
            setTimeout(() => verifyRendererHealth(contents, url, 1), 4000);
          }
        })
        .catch((err) => {
          lastInjectError = err.message;
          writeLog(`[ERROR] executeJavaScript 錯誤 (${url}): ${err.message}`);
        });
    } catch (err) {
      lastInjectError = err.message;
      writeLog('[ERROR] 準備注入腳本失敗: ' + err.message);
    }
  }

  function notifyOrInject(contents) {
    if (!isHubWebContents(contents)) return;
    const url = contents.getURL() || '';

    contents
      .executeJavaScript(
        'Boolean(window.__AGY_ZHTW__ && window.__AGY_ZHTW__.onNavigate && (window.__AGY_ZHTW__.onNavigate(), true))'
      )
      .then((handled) => {
        if (!handled) {
          injectIntoWebContents(contents);
        }
      })
      .catch((err) => {
        writeLog(`notifyOrInject 錯誤 (${url}): ${err.message}`);
      });
  }

  function broadcastToHubContents(jsCode) {
    const allContents = electron.webContents
      ? electron.webContents.getAllWebContents()
      : electron.BrowserWindow.getAllWindows().map((w) => w.webContents);

    for (const wc of allContents) {
      if (isHubWebContents(wc)) {
        wc.executeJavaScript(jsCode).catch(() => {});
      }
    }
  }

  function broadcastDictUpdate() {
    broadcastToHubContents(`
      (function() {
        if (window.__AGY_ZHTW__ && typeof window.__AGY_ZHTW__.updateDict === 'function') {
          window.__AGY_ZHTW__.updateDict(${cachedDictJson}, false);
        }
      })();
    `);
  }

  function broadcastDictError(errMsg) {
    const safeMsg = JSON.stringify('zh-tw.json 語法錯誤，熱更新失敗：' + errMsg);
    broadcastToHubContents(`
      (function() {
        if (window.__AGY_ZHTW__ && typeof window.__AGY_ZHTW__.showToast === 'function') {
          window.__AGY_ZHTW__.showToast(${safeMsg}, 'error');
        }
      })();
    `);
  }

  function attachContentsListeners(contents) {
    if (!contents || contents.__agyZhTwAttached) return;
    contents.__agyZhTwAttached = true;

    contents.on('dom-ready', () => {
      injectIntoWebContents(contents);
    });

    contents.on('did-finish-load', () => {
      notifyOrInject(contents);
    });

    contents.on('did-navigate-in-page', () => {
      notifyOrInject(contents);
    });
  }

  function watchDictionaryFile() {
    try {
      fs.watchFile(DICT_PATH, { interval: 1000, persistent: false }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs) return;
        if (loadDictionary()) {
          writeLog('偵測到 zh-tw.json 變更，正在熱更新所有視窗');
          broadcastDictUpdate();
          const appMenu = electron.Menu.getApplicationMenu();
          if (appMenu) {
            translateMenuInstance(appMenu);
            electron.Menu.setApplicationMenu(appMenu);
          }
        } else if (lastDictError) {
          broadcastDictError(lastDictError);
        }
      });
      fs.watchFile(DOM_SCRIPT_PATH, { interval: 1000, persistent: false }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs) return;
        if (loadDomScriptCache()) {
          writeLog('偵測到 dom-translator.js 變更，正在熱更新所有視窗翻譯引擎');
          broadcastToHubContents(`
            (function() {
              window.__AGY_ZHTW_ALLOW_REINIT__ = true;
              ${cachedDomScript}
              if (window.__AGY_ZHTW__ && typeof window.__AGY_ZHTW__.init === 'function') {
                window.__AGY_ZHTW__.init(${cachedDictJson}, { healthDelayMs: 999999 });
                window.__AGY_ZHTW__.showToast('繁體中文翻譯引擎已即時熱更新');
              }
            })();
          `);
        }
      });
    } catch (_) {}
  }

  function scheduleAutoTranslateIfVersionChanged() {
    setTimeout(() => {
      try {
        if (!rawDict?._meta?.auto_translate) return;
        const appVersion =
          typeof electron.app.getVersion === 'function' ? electron.app.getVersion() : '';
        if (!appVersion || appVersion === rawDict._meta.version) return;
        if (!fs.existsSync(SCAN_SCRIPT_PATH)) return;

        writeLog(`偵測到版本升級 (${rawDict._meta.version} -> ${appVersion})，觸發背景新詞條自動翻譯`);
        const child = spawn(
          process.execPath,
          [SCAN_SCRIPT_PATH, '--auto-translate'],
          {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
          }
        );
        child.unref();
      } catch (_) {}
    }, 5000);
  }

  function setupPostUpdatePatch() {
    const cp = require('child_process');
    const mod = require('module');
    if (cp.__agyZhTwSpawnHooked) return;
    cp.__agyZhTwSpawnHooked = true;

    let postUpdateScheduled = false;
    const origSpawn = cp.spawn;

    cp.spawn = function (command, args) {
      const child = origSpawn.apply(this, arguments);
      try {
        const argList = Array.isArray(args) ? args.map(String) : [];
        const cmdStr = String(command || '');
        const baseExe = path.basename(cmdStr).toLowerCase();
        if (
          !postUpdateScheduled &&
          baseExe.endsWith('.exe') &&
          baseExe !== 'antigravity.exe' &&
          argList.includes('--updated') &&
          fs.existsSync(PATCH_SCRIPT_PATH)
        ) {
          postUpdateScheduled = true;
          const realInstPath = baseExe === 'elevate.exe' ? String(argList[0] || '') : cmdStr;
          const instName = realInstPath ? path.parse(realInstPath).name : '';
          const isSilentOnly =
            argList.some((a) => a.toUpperCase() === '/S') && !argList.includes('--force-run');
          const mode = isSilentOnly ? 'silent' : 'restart';

          const waitCmd = [
            'Wait-Process -Id $env:AGY_OLD_PID -Timeout 120 -ErrorAction SilentlyContinue',
            'Start-Sleep -Seconds 2',
            'if ($env:AGY_INST_PID) { Wait-Process -Id $env:AGY_INST_PID -Timeout 300 -ErrorAction SilentlyContinue }',
            'if ($env:AGY_INST_NAME) { Wait-Process -Name "$env:AGY_INST_NAME" -Timeout 300 -ErrorAction SilentlyContinue }',
            'Start-Sleep -Seconds 2',
            '$env:ELECTRON_RUN_AS_NODE = 1',
            '& $env:AGY_APP_EXE $env:AGY_PATCH_JS --post-update $env:AGY_UPDATE_MODE | Out-Null'
          ].join('; ');

          cp.execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $env:SystemRoot -ArgumentList '-NoProfile','-NonInteractive','-Command','${waitCmd}'`
            ],
            {
              windowsHide: true,
              cwd: process.env.SystemRoot || 'C:\\Windows',
              env: {
                ...process.env,
                AGY_OLD_PID: String(process.pid),
                AGY_INST_PID: child && child.pid ? String(child.pid) : '',
                AGY_INST_NAME: instName,
                AGY_APP_EXE: process.execPath,
                AGY_PATCH_JS: PATCH_SCRIPT_PATH,
                AGY_UPDATE_MODE: mode
              }
            }
          );
          writeLog(
            `偵測到軟體更新啟動，等待安裝完成後自動重新套用 (mode=${mode}, installer=${instName || baseExe})`
          );
        }
      } catch (err) {
        writeLog('[ERROR] 排程更新後自動套用失敗: ' + err.message);
      }
      return child;
    };

    if (typeof mod.syncBuiltinESMExports === 'function') {
      try {
        mod.syncBuiltinESMExports();
      } catch (_) {}
    }
  }

  function setupInjectionWatchdog() {
    if (process.env.ELECTRON_OZONE_PLATFORM_HINT === 'headless') return;

    const inspectWindows = (attempt) => {
      if (injectedHubCount > 0 || watchdogAlertShown) return;

      const baseWins =
        electron.BaseWindow && typeof electron.BaseWindow.getAllWindows === 'function'
          ? electron.BaseWindow.getAllWindows()
          : [];
      const browserWins =
        electron.BrowserWindow && typeof electron.BrowserWindow.getAllWindows === 'function'
          ? electron.BrowserWindow.getAllWindows()
          : [];

      const seen = new Set();
      const visibleMainWins = [];
      for (const w of [...baseWins, ...browserWins]) {
        if (!w || seen.has(w) || (typeof w.isDestroyed === 'function' && w.isDestroyed())) continue;
        seen.add(w);
        if (typeof w.isVisible === 'function' && !w.isVisible()) continue;
        if (typeof w.getBounds === 'function') {
          const b = w.getBounds();
          if (b && b.width > 0 && b.width < 500) continue;
        }
        visibleMainWins.push(w);
      }

      if (visibleMainWins.length === 0) {
        if (attempt < 2) {
          setTimeout(() => inspectWindows(attempt + 1), 10000);
        }
        return;
      }

      const allContents = electron.webContents
        ? electron.webContents.getAllWebContents()
        : browserWins.map((w) => w.webContents).filter(Boolean);
      const activeContents = allContents.filter((wc) => wc && !wc.isDestroyed());
      const anyLoading = activeContents.some(
        (wc) => typeof wc.isLoadingMainFrame === 'function' && wc.isLoadingMainFrame()
      );

      if (anyLoading && attempt < 2) {
        setTimeout(() => inspectWindows(attempt + 1), 10000);
        return;
      }

      if (injectedHubCount > 0) return;
      watchdogAlertShown = true;

      const urls = Array.from(
        new Set(activeContents.map((wc) => wc.getURL && wc.getURL()).filter(Boolean))
      ).filter((u) => !u.startsWith('data:') && !u.startsWith('devtools:'));

      const detailLines = [
        '可能因官方更新變更了主視窗網址協定、Session 隔離架構或安全策略 (CSP)。',
        '目前偵測到的視窗網址：' + (urls.length > 0 ? urls.join(', ') : '(無)'),
        lastInjectError ? '最後注入錯誤：' + lastInjectError : ''
      ].filter(Boolean);

      writeLog(`[ALERT] 主視窗注入看門狗觸發告警 | ${detailLines.join(' | ')}`);

      if (electron.dialog && typeof electron.dialog.showMessageBox === 'function') {
        electron.dialog
          .showMessageBox({
            type: 'warning',
            title: 'Antigravity 繁體中文化失效告警',
            message: '偵測到 Antigravity 主視窗已開啟，但繁體中文化引擎未能注入。',
            detail: detailLines.join('\n')
          })
          .catch(() => {});
      }
    };

    setTimeout(() => inspectWindows(1), 10000);
  }

  loadDomScriptCache();
  loadDictionary();
  hookElectronMenu();
  setupPostUpdatePatch();

  const { app } = electron;
  app.on('web-contents-created', (_event, contents) => {
    hookElectronMenu();
    attachContentsListeners(contents);
  });

  app.on('browser-window-created', (_event, win) => {
    hookElectronMenu();
    if (win && win.webContents) {
      attachContentsListeners(win.webContents);
    }
  });

  app.whenReady().then(() => {
    hookElectronMenu();
    const allContents = electron.webContents
      ? electron.webContents.getAllWebContents()
      : electron.BrowserWindow.getAllWindows().map((w) => w.webContents);
    for (const wc of allContents) {
      if (wc && !wc.isDestroyed()) {
        attachContentsListeners(wc);
        notifyOrInject(wc);
      }
    }
    const appMenu = electron.Menu.getApplicationMenu();
    if (appMenu) {
      translateMenuInstance(appMenu);
      electron.Menu.setApplicationMenu(appMenu);
    }
    watchDictionaryFile();
    scheduleAutoTranslateIfVersionChanged();
    setupInjectionWatchdog();
  });
})();
