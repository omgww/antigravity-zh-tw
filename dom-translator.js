(function () {
  const SHORTCUT_SUFFIX_RE =
    /^(.+?)\s*(\((?:(?:Ctrl|Cmd|Alt|Shift|Meta|Win|⌘|⌥|⇧|⌃)\s*\+?\s*[^)]+|Enter|Esc|Escape|Tab|Space|Backspace|Delete|Up|Down|Left|Right|F\d{1,2}|⏎|↵|↑|↓|←|→|Aa|ab|\.\*|↗|[A-Za-z0-9])\))$/i;

  function translateTimeUnits(text) {
    if (!text) return text;
    return text
      .replace(/(\d+)\s*days?/gi, '$1 天')
      .replace(/(\d+)\s*hours?/gi, '$1 小時')
      .replace(/(\d+)\s*minutes?/gi, '$1 分鐘')
      .replace(/(\d+)\s*seconds?/gi, '$1 秒')
      .replace(/(\d+)d\b/gi, '$1 天')
      .replace(/(\d+)h\b/gi, '$1 小時')
      .replace(/(\d+)m\b/gi, '$1 分鐘')
      .replace(/(\d+)s\b/gi, '$1 秒')
      .replace(/<\s*1m/gi, '小於 1 分鐘');
  }

  const DYNAMIC_RULES = [
    {
      regex: /^Your Plan:\s*(.*)$/i,
      render: (m) => `您的方案：${m[1]}`
    },
    {
      regex: /^Available AI Credits:\s*(.*)$/i,
      render: (m) => `可用 AI 額度：${m[1]}`
    },
    {
      regex: /^Shared with:\s*(.*)$/i,
      render: (m) => `共用對象：${m[1]}`
    },
    {
      regex: /^Inherits your Global Permissions when working\s+(.*)\.?$/i,
      render: (m) => `在 ${m[1]} 工作時繼承您的全域權限設定。`
    },
    {
      regex: /^You have used some of your weekly limit,?\s*it will fully refresh in\s*(.+?)\.?$/i,
      render: (m) => `您已使用部分每週配額，將於 ${translateTimeUnits(m[1])} 後完全重設。`
    },
    {
      regex: /^You have used some of your 5-hour limit,?\s*it will fully refresh in\s*(.+?)\.?$/i,
      render: (m) => `您已使用部分 5 小時配額，將於 ${translateTimeUnits(m[1])} 後完全重設。`
    },
    {
      regex: /^it will fully refresh in\s*(.+?)\.?$/i,
      render: (m) => `將於 ${translateTimeUnits(m[1])} 後完全重設`
    },
    {
      regex: /^Resets in\s*(.+?)$/i,
      render: (m) => `${translateTimeUnits(m[1])} 後重設`
    },
    {
      regex: /^Updated\s+(.+?)\s+ago$/i,
      render: (m) => `${translateTimeUnits(m[1])} 前更新`
    },
    {
      regex: /^Created\s+(.+?)\s+ago$/i,
      render: (m) => `${translateTimeUnits(m[1])} 前建立`
    },
    {
      regex: /^Search for "([^"]+)" in the Marketplace$/i,
      render: (m) => `在擴充市集中搜尋「${m[1]}」`
    },
    {
      regex: /^No plugins found for "([^"]+)"\.?$/i,
      render: (m) => `找不到符合「${m[1]}」的外掛。`
    },
    {
      regex: /^Conversation\s+([a-f0-9-]{6,})$/i,
      render: (m) => `對話 ${m[1]}`
    },
    {
      regex: /^Agent permissions preset selector,\s*current:\s*(.*)$/i,
      render: (m) => `代理權限預設組合選擇器（目前：${m[1]}）`
    },
    {
      regex: /^Select model,\s*current:\s*(.*)$/i,
      render: (m) => `選擇模型（目前：${m[1]}）`
    },
    {
      regex: /^Select modes,\s*current:\s*(.*)$/i,
      render: (m) => `選擇模式（目前：${m[1]}）`
    },
    {
      regex: /^Add\s+(\d+)\s+plugins?\s+from\s+(.*)$/i,
      render: (m) => `加入來自 ${m[2]} 的 ${m[1]} 個外掛`
    },
    {
      regex: /^See all \((\d+)\)$/i,
      render: (m) => `查看全部 (${m[1]})`
    },
    {
      regex: /^(\d+)\s+agents?\s+working,\s*live preview unavailable$/i,
      render: (m) => `${m[1]} 個代理執行中，無法顯示即時預覽`
    },
    {
      regex: /^(\d+)\s+models selected$/i,
      render: (m) => `已選擇 ${m[1]} 個模型`
    },
    {
      regex: /^Reset\s+(\d+)\s+overrides?$/i,
      render: (m) => `重設 ${m[1]} 項覆寫設定`
    },
    {
      regex: /^Yes, allow downloads from (.+) for this run$/i,
      render: (m) => `是，於此次執行允許從 ${m[1]} 下載`
    },
    {
      regex: /^Yes, allow downloads from (.+) in this conversation$/i,
      render: (m) => `是，在此對話中允許從 ${m[1]} 下載`
    },
    {
      regex: /^Yes, always allow downloads from (.+)$/i,
      render: (m) => `是，總是允許從 ${m[1]} 下載`
    },
    {
      regex: /^Yes, save rule for '(.+)' in this conversation$/i,
      render: (m) => `是，在此對話中儲存「${m[1]}」的規則`
    },
    {
      regex: /^Yes, save rule for '(.+)' globally$/i,
      render: (m) => `是，將「${m[1]}」儲存為全域規則`
    },
    {
      regex: /^Yes, and always allow '(.+)' in this conversation$/i,
      render: (m) => `是，並在此對話中總是允許「${m[1]}」`
    },
    {
      regex: /^Yes, and always allow '(.+)'$/i,
      render: (m) => `是，並總是允許「${m[1]}」`
    },
    {
      regex: /^Yes, allow (.+) in this conversation$/i,
      render: (m) => `是，在此對話中允許 ${m[1]}`
    },
    {
      regex: /^Yes, always allow (.+)$/i,
      render: (m) => `是，總是允許 ${m[1]}`
    },
    {
      regex: /^Conflicts with your configured Ask permission:\s*(.+)$/i,
      render: (m) => `與您設定的「詢問」權限規則衝突：${m[1]}`
    },
    {
      regex: /^Requires manual confirmation:\s*(.+)$/i,
      render: (m) => `需要人工確認：${m[1]}`
    }
  ];

  function isCoveredByDictOrDynamic(existingKeys, rawLabel) {
    const label = String(rawLabel || '').trim();
    if (!label) return true;
    const norm = label.replace(/\s+/g, ' ');
    if (existingKeys.has(label) || existingKeys.has(norm)) return true;
    if (!label.endsWith('&') && label.includes('&')) {
      if (existingKeys.has(label.replace(/&/g, ''))) return true;
    }
    if (label.endsWith('…')) {
      const asDots = label.slice(0, -1) + '...';
      const base = label.slice(0, -1).trim();
      if (existingKeys.has(asDots) || existingKeys.has(base) || existingKeys.has(base.replace(/\s+/g, ' '))) {
        return true;
      }
    }
    if (label.endsWith('...')) {
      const base = label.slice(0, -3).trim();
      if (existingKeys.has(base) || existingKeys.has(base.replace(/\s+/g, ' '))) return true;
    }
    if (label.endsWith('.')) {
      const withoutDot = label.slice(0, -1).trim();
      if (existingKeys.has(withoutDot) || existingKeys.has(withoutDot.replace(/\s+/g, ' '))) return true;
    } else if (existingKeys.has(label + '.') || existingKeys.has(norm + '.')) {
      return true;
    }
    if (label.endsWith(':')) {
      const base = label.slice(0, -1).trim();
      if (existingKeys.has(base) || existingKeys.has(base.replace(/\s+/g, ' '))) return true;
    }
    const sm = label.match(SHORTCUT_SUFFIX_RE);
    if (sm) {
      const base = sm[1].trim();
      if (existingKeys.has(base) || existingKeys.has(base.replace(/\s+/g, ' '))) return true;
    }
    for (let i = 0; i < DYNAMIC_RULES.length; i++) {
      if (DYNAMIC_RULES[i].regex.test(label)) return true;
    }
    return false;
  }

  if (typeof window === 'undefined') {
    if (typeof module === 'object' && module && module.exports) {
      module.exports = { SHORTCUT_SUFFIX_RE, DYNAMIC_RULES, isCoveredByDictOrDynamic };
    }
    return;
  }

  if (window.__AGY_ZHTW__ && window.__AGY_ZHTW__.initialized) {
    if (!window.__AGY_ZHTW_ALLOW_REINIT__) {
      return;
    }
    if (typeof window.__AGY_ZHTW__.teardown === 'function') {
      window.__AGY_ZHTW__.teardown();
    }
    window.__AGY_ZHTW_ALLOW_REINIT__ = false;
  }

  const SKIP_TEXT_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'CODE',
    'PRE',
    'KBD',
    'SVG',
    'PATH',
    'CANVAS',
    'IFRAME',
    'WEBVIEW'
  ]);

  const SKIP_EXACT_CLASSES = new Set([
    'notranslate',
    'textLayer',
    'google-symbols',
    'material-symbols-outlined',
    'material-symbols-rounded',
    'material-symbols-sharp',
    'material-icons',
    'codicon',
    'monaco-editor',
    'xterm',
    'katex',
    'hljs',
    'prism'
  ]);

  const SKIP_PREFIX_CLASSES = [
    'material-symbols-',
    'codicon-',
    'monaco-',
    'xterm-',
    'katex-',
    'hljs-',
    'cm-'
  ];

  const ISOLATED_TESTIDS = new Set([
    'user-message-content',
    'pending-user-messages',
    'transcript-line-text',
    'browser-subagent-thinking',
    'ask-question-header-text',
    'ask-question-option-text',
    'comment-card-text',
    'pill-comment-anchor-text',
    'subagent-tab-header-title',
    'side-question-tab-header-name',
    'file-title-name',
    'branch-pill-label',
    'branch-option',
    'branch-repo-label',
    'attached-context-pill',
    'voice-picker-name',
    'voice-settings-name',
    'automation-name',
    'browser-url-display',
    'url-security-host',
    'external-link-confirm-uri',
    'webview-download-filename',
    'settings-error-messages-card',
    'sidecar-logs-content',
    'csv-file-viewer',
    'code-gutter',
    'code-gutter-diff'
  ]);

  const ISOLATED_ARIA_LABELS = new Set(['File Viewer', 'Virtual File Viewer']);

  const CASCADE_PANE_TESTIDS = new Set([
    'conversation-view',
    'subagent-tab-conversation',
    'side-question-tab-conversation'
  ]);

  const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'];

  const textStateMap = new WeakMap();
  const attrStateMap = new WeakMap();
  const observedRoots = new WeakSet();
  const trackedTextNodes = new Set();
  const trackedAttrElements = new Set();

  let flatDict = Object.create(null);
  let dictSize = 0;
  let enabled = true;
  let pendingNodes = new Set();
  let pendingAttrElements = new Set();
  let rafScheduled = false;
  let activeObserver = null;
  let healthStatus = 'pending';
  let healthCheckDone = false;

  function buildFlatDict(rawDict) {
    const map = Object.create(null);
    if (!rawDict || typeof rawDict !== 'object') return map;

    for (const [sectionKey, sectionVal] of Object.entries(rawDict)) {
      if (sectionKey.startsWith('_')) continue;
      if (typeof sectionVal === 'string') {
        if (sectionVal.trim() !== '') {
          map[sectionKey.trim()] = sectionVal;
        }
      } else if (sectionVal && typeof sectionVal === 'object') {
        for (const [en, zh] of Object.entries(sectionVal)) {
          if (typeof zh === 'string' && zh.trim() !== '') {
            const k = en.trim();
            if (sectionKey === 'auto' && map[k]) continue;
            map[k] = zh;
          }
        }
      }
    }
    dictSize = Object.keys(map).length;
    return map;
  }

  function hasSkippedClassToken(el) {
    const classList = el.classList;
    if (!classList || classList.length === 0) return false;
    for (let i = 0; i < classList.length; i++) {
      const token = classList[i];
      if (!token || token.includes(':') || token.includes('[')) {
        continue;
      }
      if (SKIP_EXACT_CLASSES.has(token) || token.includes('diffEditor')) {
        return true;
      }
      for (let j = 0; j < SKIP_PREFIX_CLASSES.length; j++) {
        if (token.startsWith(SKIP_PREFIX_CLASSES[j])) {
          return true;
        }
      }
    }
    return false;
  }

  function isInsideActiveEditable(el) {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return false;
    const aTag = (active.tagName || '').toUpperCase();
    const ce = active.getAttribute ? active.getAttribute('contenteditable') : null;
    if (
      aTag === 'INPUT' ||
      aTag === 'TEXTAREA' ||
      active.isContentEditable ||
      ce === 'true' ||
      ce === 'plaintext-only' ||
      ce === '' ||
      (active.hasAttribute && active.hasAttribute('data-lexical-editor'))
    ) {
      return active === el || (typeof active.contains === 'function' && active.contains(el));
    }
    return false;
  }

  function shouldSkipElement(el, isTextParent = false) {
    let cur = el;
    let sawPreWrap = false;
    let sawTruncate = false;
    let sawTruncateSpan = false;
    const elTag = el && el.tagName ? el.tagName.toUpperCase() : '';

    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      const upperTag = (cur.tagName || '').toUpperCase();
      if (SKIP_TEXT_TAGS.has(upperTag) || cur.namespaceURI === 'http://www.w3.org/2000/svg') {
        return true;
      }
      const ce = cur.getAttribute('contenteditable');
      if (cur.isContentEditable || ce === 'true' || ce === 'plaintext-only' || ce === '') {
        return true;
      }
      if (
        cur.hasAttribute('data-icon') ||
        cur.getAttribute('translate') === 'no' ||
        cur.hasAttribute('data-markdown-root') ||
        cur.hasAttribute('data-lexical-editor') ||
        cur.hasAttribute('data-quotable') ||
        cur.hasAttribute('data-quotable-inline') ||
        cur.hasAttribute('data-file-uri') ||
        cur.hasAttribute('data-uri') ||
        cur.hasAttribute('data-project-name') ||
        cur.hasAttribute('data-repo-slug')
      ) {
        return true;
      }
      const cls = cur.classList;
      if (cls && cls.length > 0) {
        if (cls.contains('whitespace-pre-wrap')) sawPreWrap = true;
        if (cls.contains('truncate')) {
          sawTruncate = true;
          if (upperTag === 'SPAN') sawTruncateSpan = true;
        }
      }
      const tid = cur.getAttribute('data-testid');
      if (tid) {
        if (ISOLATED_TESTIDS.has(tid)) return true;
        if (tid === 'user-input-step' && sawPreWrap) return true;
      }
      if (cur.getAttribute('role') === 'treeitem' && (isTextParent || sawTruncate)) {
        return true;
      }
      if (
        cur.hasAttribute('data-project-card') &&
        cur.hasAttribute('data-project-label') &&
        cur.getAttribute('data-project-label') !== 'Standalone'
      ) {
        return true;
      }
      if (
        cur.hasAttribute('data-cascade-id') &&
        (!tid || !CASCADE_PANE_TESTIDS.has(tid)) &&
        (sawTruncateSpan || (elTag === 'A' && el.parentElement === cur))
      ) {
        return true;
      }
      const savedAttrs = attrStateMap.get(cur);
      const rawAria =
        savedAttrs && savedAttrs['aria-label'] !== undefined
          ? savedAttrs['aria-label'].orig
          : cur.getAttribute('aria-label');
      if (rawAria && ISOLATED_ARIA_LABELS.has(rawAria.trim())) {
        return true;
      }
      if (hasSkippedClassToken(cur)) {
        return true;
      }
      if (
        upperTag === 'SPAN' &&
        cur.getAttribute('aria-hidden') === 'true' &&
        cur.childElementCount === 0 &&
        /^[a-z0-9_]+$/.test((cur.textContent || '').trim())
      ) {
        return true;
      }
      cur = cur.parentElement || (cur.parentNode && cur.parentNode.host) || null;
    }
    return false;
  }

  function lookupTranslation(trimmedText) {
    if (!trimmedText || trimmedText.length < 2 || trimmedText.length > 1200) {
      return null;
    }

    if (flatDict[trimmedText]) {
      return flatDict[trimmedText];
    }

    const normalizedSpaces = trimmedText.replace(/\s+/g, ' ');
    if (normalizedSpaces !== trimmedText && flatDict[normalizedSpaces]) {
      return flatDict[normalizedSpaces];
    }

    if (trimmedText.endsWith('…')) {
      const norm = trimmedText.slice(0, -1) + '...';
      if (flatDict[norm]) return flatDict[norm];
      const base = trimmedText.slice(0, -1).trim();
      if (flatDict[base]) return flatDict[base] + '...';
      const normBase = base.replace(/\s+/g, ' ');
      if (flatDict[normBase]) return flatDict[normBase] + '...';
    }
    if (trimmedText.endsWith('...')) {
      const base = trimmedText.slice(0, -3).trim();
      if (flatDict[base]) return flatDict[base] + '...';
      const normBase = base.replace(/\s+/g, ' ');
      if (flatDict[normBase]) return flatDict[normBase] + '...';
    }

    if (trimmedText.endsWith('.')) {
      const withoutDot = trimmedText.slice(0, -1).trim();
      if (flatDict[withoutDot]) return flatDict[withoutDot] + '。';
      const normWithoutDot = withoutDot.replace(/\s+/g, ' ');
      if (flatDict[normWithoutDot]) return flatDict[normWithoutDot] + '。';
    } else {
      const withDot = trimmedText + '.';
      if (flatDict[withDot]) return flatDict[withDot].replace(/。$/, '');
      const normWithDot = normalizedSpaces + '.';
      if (flatDict[normWithDot]) return flatDict[normWithDot].replace(/。$/, '');
    }

    if (trimmedText.endsWith(':')) {
      const base = trimmedText.slice(0, -1).trim();
      if (flatDict[base]) return flatDict[base] + '：';
      const normBase = base.replace(/\s+/g, ' ');
      if (flatDict[normBase]) return flatDict[normBase] + '：';
    }

    const shortcutMatch = trimmedText.match(SHORTCUT_SUFFIX_RE);
    if (shortcutMatch) {
      const baseLabel = shortcutMatch[1].trim();
      const normBaseLabel = baseLabel.replace(/\s+/g, ' ');
      const baseTranslated = flatDict[baseLabel] || flatDict[normBaseLabel];
      if (baseTranslated) {
        return `${baseTranslated} ${shortcutMatch[2]}`;
      }
    }

    for (let i = 0; i < DYNAMIC_RULES.length; i++) {
      const rule = DYNAMIC_RULES[i];
      const match = trimmedText.match(rule.regex);
      if (match) {
        try {
          return rule.render(match);
        } catch (_) {}
      }
    }

    return null;
  }

  function processTextNode(textNode) {
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
    const parent = textNode.parentElement;
    if (!parent) return;
    const pTag = (parent.tagName || '').toUpperCase();
    if (pTag === 'TEXTAREA' || pTag === 'INPUT') return;
    if (pTag === 'OPTION' && !parent.hasAttribute('value')) return;
    if (isInsideActiveEditable(parent) || shouldSkipElement(parent, true)) return;

    const currentVal = textNode.nodeValue || '';
    if (!currentVal.trim()) return;

    let state = textStateMap.get(textNode);
    if (!state || (currentVal !== state.orig && currentVal !== state.applied)) {
      state = { orig: currentVal, applied: currentVal };
      textStateMap.set(textNode, state);
    }

    if (!enabled) {
      if (currentVal !== state.orig) {
        textNode.nodeValue = state.orig;
      }
      state.applied = state.orig;
      return;
    }

    const translated = lookupTranslation(state.orig.trim());
    if (translated) {
      const leadingSpaces = state.orig.match(/^\s*/)[0];
      const trailingSpaces = state.orig.match(/\s*$/)[0];
      const nextVal = leadingSpaces + translated + trailingSpaces;
      if (currentVal !== nextVal) {
        textNode.nodeValue = nextVal;
      }
      state.applied = nextVal;
      trackedTextNodes.add(textNode);
    } else {
      if (currentVal !== state.orig) {
        textNode.nodeValue = state.orig;
      }
      state.applied = state.orig;
    }
  }

  function processElementAttributes(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (shouldSkipElement(el)) return;

    let elAttrs = attrStateMap.get(el);
    for (let i = 0; i < TRANSLATABLE_ATTRS.length; i++) {
      const attr = TRANSLATABLE_ATTRS[i];
      if (!el.hasAttribute(attr)) continue;

      const currVal = el.getAttribute(attr) || '';
      if (!elAttrs) {
        elAttrs = Object.create(null);
        attrStateMap.set(el, elAttrs);
      }

      let state = elAttrs[attr];
      if (!state || (currVal !== state.orig && currVal !== state.applied)) {
        state = { orig: currVal, applied: currVal };
        elAttrs[attr] = state;
      }

      if (!enabled) {
        if (currVal !== state.orig) {
          el.setAttribute(attr, state.orig);
        }
        state.applied = state.orig;
        continue;
      }

      const translated = lookupTranslation(state.orig.trim());
      const nextVal = translated || state.orig;
      if (currVal !== nextVal) {
        el.setAttribute(attr, nextVal);
      }
      state.applied = nextVal;
      if (translated) {
        trackedAttrElements.add(el);
      }
    }
  }

  function walkAndTranslate(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      processTextNode(root);
      return;
    }
    const isElement = root.nodeType === Node.ELEMENT_NODE;
    const isFragment = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
    if (!isElement && !isFragment) return;

    if (isElement) {
      if (shouldSkipElement(root)) return;
      processElementAttributes(root);
      if (root.shadowRoot) {
        observeRoot(root.shadowRoot);
        walkAndTranslate(root.shadowRoot);
      }
      if (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') return;
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
              return NodeFilter.FILTER_ACCEPT;
            }
            if (shouldSkipElement(node)) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let current = walker.nextNode();
    while (current) {
      if (current.nodeType === Node.TEXT_NODE) {
        processTextNode(current);
      } else if (current.nodeType === Node.ELEMENT_NODE) {
        processElementAttributes(current);
        if (current.shadowRoot) {
          observeRoot(current.shadowRoot);
          walkAndTranslate(current.shadowRoot);
        }
      }
      current = walker.nextNode();
    }
  }

  function scheduleBatchFlush() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      if (!enabled) {
        pendingNodes.clear();
        pendingAttrElements.clear();
        return;
      }
      if (pendingAttrElements.size > 0) {
        const attrBatch = Array.from(pendingAttrElements);
        pendingAttrElements.clear();
        for (let i = 0; i < attrBatch.length; i++) {
          const el = attrBatch[i];
          if (el && el.isConnected) {
            processElementAttributes(el);
          }
        }
      }
      if (pendingNodes.size > 0) {
        const batch = Array.from(pendingNodes);
        pendingNodes.clear();
        for (let i = 0; i < batch.length; i++) {
          const node = batch[i];
          if (node && node.isConnected) {
            walkAndTranslate(node);
          }
        }
      }
      if (trackedTextNodes.size > 1500) {
        for (const tn of trackedTextNodes) {
          if (!tn.isConnected) trackedTextNodes.delete(tn);
        }
      }
      if (trackedAttrElements.size > 1500) {
        for (const el of trackedAttrElements) {
          if (!el.isConnected) trackedAttrElements.delete(el);
        }
      }
    });
  }

  function showToast(message, level = 'info') {
    if (!document.body) return;
    const normLevel =
      level === true || level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';

    let toast = document.getElementById('agy-zhtw-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'agy-zhtw-toast';
      toast.setAttribute('translate', 'no');
      Object.assign(toast.style, {
        position: 'fixed',
        top: '42px',
        right: '18px',
        maxWidth: '460px',
        zIndex: '2147483647',
        padding: '8px 14px',
        borderRadius: '8px',
        color: '#f4f4f5',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
        fontSize: '13px',
        lineHeight: '1.45',
        fontFamily: 'system-ui, -apple-system, "Microsoft JhengHei", sans-serif',
        pointerEvents: 'none',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'opacity 0.2s ease, transform 0.2s ease',
        opacity: '0',
        transform: 'translateY(-6px)'
      });
      document.body.appendChild(toast);
    }

    const hideToast = () => {
      if (typeof cancelAnimationFrame === 'function' && toast._rafId) {
        cancelAnimationFrame(toast._rafId);
        toast._rafId = 0;
      }
      clearTimeout(toast._hideTimer);
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
      toast.style.pointerEvents = 'none';
    };

    toast.onclick = hideToast;
    toast.title = '點擊關閉提示';

    if (normLevel === 'info' && document.hidden) {
      hideToast();
      return;
    }

    if (normLevel === 'error') {
      toast.style.backgroundColor = 'rgba(127, 29, 29, 0.96)';
      toast.style.border = '1px solid rgba(248, 113, 113, 0.55)';
    } else if (normLevel === 'warn') {
      toast.style.backgroundColor = 'rgba(120, 53, 15, 0.95)';
      toast.style.border = '1px solid rgba(251, 191, 36, 0.5)';
    } else {
      toast.style.backgroundColor = 'rgba(24, 24, 27, 0.92)';
      toast.style.border = '1px solid rgba(255, 255, 255, 0.15)';
    }

    if (typeof cancelAnimationFrame === 'function' && toast._rafId) {
      cancelAnimationFrame(toast._rafId);
    }
    clearTimeout(toast._hideTimer);

    const durationMs = normLevel === 'error' ? 8000 : normLevel === 'warn' ? 6000 : 2400;
    toast.textContent = message;
    toast._rafId = requestAnimationFrame(() => {
      toast._rafId = 0;
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
      toast.style.pointerEvents = 'auto';
      clearTimeout(toast._hideTimer);
      toast._hideTimer = setTimeout(hideToast, durationMs);
    });
  }

  function toggleLanguage() {
    enabled = !enabled;
    if (!enabled) {
      for (const textNode of trackedTextNodes) {
        if (!textNode.isConnected) {
          trackedTextNodes.delete(textNode);
          continue;
        }
        const state = textStateMap.get(textNode);
        if (state) {
          textNode.nodeValue = state.orig;
          state.applied = state.orig;
        }
      }
      for (const el of trackedAttrElements) {
        if (!el.isConnected) {
          trackedAttrElements.delete(el);
          continue;
        }
        const elAttrs = attrStateMap.get(el);
        if (!elAttrs) continue;
        for (const attr of TRANSLATABLE_ATTRS) {
          const state = elAttrs[attr];
          if (state && el.hasAttribute(attr)) {
            el.setAttribute(attr, state.orig);
            state.applied = state.orig;
          }
        }
      }
      showToast('已切換為：英文原文 (按 Alt+Z 切回繁中)');
    } else {
      if (document.body) {
        walkAndTranslate(document.body);
      }
      showToast('已切換為：繁體中文 (按 Alt+Z 切換原文)');
    }
  }

  function observeRoot(targetRoot) {
    if (!enabled || !targetRoot || observedRoots.has(targetRoot)) return;
    if (!activeObserver) {
      activeObserver = new MutationObserver((mutations) => {
        if (!enabled) return;
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          if (m.type === 'childList') {
            const added = m.addedNodes;
            for (let j = 0; j < added.length; j++) {
              pendingNodes.add(added[j]);
            }
          } else if (m.type === 'characterData' && m.target) {
            pendingNodes.add(m.target);
          } else if (m.type === 'attributes' && m.target) {
            pendingAttrElements.add(m.target);
          }
        }
        if (pendingNodes.size > 0 || pendingAttrElements.size > 0) {
          scheduleBatchFlush();
        }
      });
    }
    try {
      activeObserver.observe(targetRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TRANSLATABLE_ATTRS
      });
      observedRoots.add(targetRoot);
    } catch (_) {}
  }

  function ensureObserver() {
    if (!enabled || !document.body) return;
    observeRoot(document.body);
  }

  function onNavigate() {
    if (!enabled || !document.body) return;
    ensureObserver();
    walkAndTranslate(document.body);
  }

  function isEditableOrCodeFocus(target) {
    const el = target && target.nodeType === Node.ELEMENT_NODE ? target : document.activeElement;
    if (!el || typeof el.closest !== 'function') return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
    return Boolean(
      el.closest(
        '[contenteditable="true"], [contenteditable="plaintext-only"], [data-lexical-editor], .monaco-editor, .cm-editor, .xterm, [aria-label="File Viewer"], [aria-label="Virtual File Viewer"]'
      )
    );
  }

  function getHealthReport() {
    return {
      status: healthStatus,
      done: healthCheckDone,
      translatedCount: trackedTextNodes.size + trackedAttrElements.size,
      dictSize
    };
  }

  function runHealthCheck(attempt = 1, retryDelayMs = 2500) {
    if (!enabled || !document.body) return;
    walkAndTranslate(document.body);

    const translatedCount = trackedTextNodes.size + trackedAttrElements.size;

    if (dictSize === 0) {
      healthStatus = 'empty_dict';
      healthCheckDone = true;
      showToast('[中文化異常] 字典檔內容為空或損毀，請檢查 zh-tw.json', 'error');
      return;
    }

    if (translatedCount === 0) {
      const bodyTextLen = ((document.body.innerText || document.body.textContent) || '').trim().length;
      if (bodyTextLen < 20 && attempt < 3) {
        healthStatus = 'pending';
        setTimeout(() => runHealthCheck(attempt + 1, retryDelayMs), retryDelayMs);
        return;
      }
      if (bodyTextLen >= 20) {
        healthStatus = 'zero_hits';
        healthCheckDone = true;
        showToast(
          '[中文化異常] 翻譯引擎已載入但命中 0 處介面文字，可能因官方改版導致結構不相容',
          'error'
        );
        return;
      }
      healthStatus = 'idle_dom';
      healthCheckDone = true;
      return;
    }

    healthCheckDone = true;
    healthStatus = 'ok';
    showToast('繁體中文介面已啟用 (按 Alt+Z 切換原文)', 'info');
  }

  function init(initialRawDict, options = {}) {
    flatDict = buildFlatDict(initialRawDict);
    healthStatus = 'pending';
    healthCheckDone = false;
    const checkDelayMs = options && typeof options.healthDelayMs === 'number' ? options.healthDelayMs : 2000;
    const retryDelayMs = options && typeof options.retryDelayMs === 'number' ? options.retryDelayMs : 2500;

    const start = () => {
      if (!document.body) return;
      ensureObserver();
      walkAndTranslate(document.body);
      setTimeout(() => runHealthCheck(1, retryDelayMs), checkDelayMs);
    };

    if (document.body) {
      start();
    } else {
      window.addEventListener('DOMContentLoaded', start, { once: true });
    }

    if (window.__AGY_ZHTW_KEYDOWN_HANDLER__) {
      window.removeEventListener('keydown', window.__AGY_ZHTW_KEYDOWN_HANDLER__, true);
    }
    const keydownHandler = (e) => {
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.key && e.key.toLowerCase() === 'z') {
        if (isEditableOrCodeFocus(e.target)) {
          return;
        }
        e.preventDefault();
        toggleLanguage();
      }
    };
    window.__AGY_ZHTW_KEYDOWN_HANDLER__ = keydownHandler;
    window.addEventListener('keydown', keydownHandler, true);
  }

  function teardown() {
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }
    if (window.__AGY_ZHTW_KEYDOWN_HANDLER__) {
      window.removeEventListener('keydown', window.__AGY_ZHTW_KEYDOWN_HANDLER__, true);
      window.__AGY_ZHTW_KEYDOWN_HANDLER__ = null;
    }
    for (const textNode of trackedTextNodes) {
      if (!textNode.isConnected) continue;
      const state = textStateMap.get(textNode);
      if (state) textNode.nodeValue = state.orig;
    }
    for (const el of trackedAttrElements) {
      if (!el.isConnected) continue;
      const elAttrs = attrStateMap.get(el);
      if (!elAttrs) continue;
      for (const attr of TRANSLATABLE_ATTRS) {
        const state = elAttrs[attr];
        if (state && el.hasAttribute(attr)) el.setAttribute(attr, state.orig);
      }
    }
    trackedTextNodes.clear();
    trackedAttrElements.clear();
  }

  window.__AGY_ZHTW__ = {
    initialized: true,
    init,
    teardown,
    onNavigate,
    toggleLanguage,
    getHealthReport,
    showToast,
    updateDict(newRawDict, silent = false) {
      flatDict = buildFlatDict(newRawDict);
      ensureObserver();
      if (enabled && document.body) {
        for (const textNode of trackedTextNodes) {
          if (textNode.isConnected) {
            processTextNode(textNode);
          } else {
            trackedTextNodes.delete(textNode);
          }
        }
        for (const el of trackedAttrElements) {
          if (el.isConnected) {
            processElementAttributes(el);
          } else {
            trackedAttrElements.delete(el);
          }
        }
        walkAndTranslate(document.body);
        if (!silent) {
          showToast('繁體中文字典已即時熱更新');
        }
      }
    }
  };
})();
