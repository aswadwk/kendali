// Kendali page agent. Injected on demand into the extension's isolated world.
// Produces compact, token-cheap snapshots and performs DOM actions by ref.
(() => {
  if (globalThis.__kd) return;

  // ---- stable refs -------------------------------------------------------
  const ids = new WeakMap();
  const refs = new Map();
  let seq = 0;
  let prev = null; // last snapshot lines (for diff)

  const refOf = (el) => {
    let i = ids.get(el);
    if (!i) ids.set(el, (i = ++seq));
    refs.set(i, new WeakRef(el));
    return i;
  };
  const byRef = (r) => {
    const el = refs.get(+String(r).replace(/^ref_/, ''))?.deref();
    return el?.isConnected ? el : null;
  };

  const clip = (s, n = 60) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- roles & names -----------------------------------------------------
  const ARIA = {
    button: 'btn', link: 'link', checkbox: 'cb', radio: 'radio', switch: 'switch',
    textbox: 'input', searchbox: 'input', combobox: 'combo', listbox: 'list',
    option: 'opt', tab: 'tab', menuitem: 'menu', menuitemcheckbox: 'menu',
    menuitemradio: 'menu', slider: 'slider', spinbutton: 'num', treeitem: 'item',
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'svg', 'SVG']);
  const HEAD = { H1: '#', H2: '##', H3: '###', H4: '####' };

  function role(el) {
    const r = el.getAttribute('role');
    if (r && ARIA[r]) return ARIA[r];
    switch (el.tagName) {
      case 'A': return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON': case 'SUMMARY': return 'btn';
      case 'SELECT': return 'select';
      case 'TEXTAREA': return 'input';
      case 'INPUT': {
        const t = el.type;
        if (t === 'hidden') return null;
        if (t === 'checkbox') return 'cb';
        if (t === 'radio') return 'radio';
        if (t === 'file') return 'file';
        if (t === 'range') return 'slider';
        if (['button', 'submit', 'reset', 'image'].includes(t)) return 'btn';
        return 'input';
      }
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'input';
    if (el.hasAttribute('onclick')) return 'btn';
    if (el.hasAttribute('tabindex') && el.tabIndex >= 0 && el.tagName !== 'DIALOG') return 'btn';
    return null;
  }

  function name(el) {
    let s = el.getAttribute('aria-label');
    if (!s) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) s = lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
    }
    const formy = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    if (!s && el.labels?.length) s = el.labels[0].innerText;
    if (!s && el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) s = el.value;
    if (!s && formy) s = el.placeholder || el.title || el.name;
    if (!s && !formy) s = el.innerText;
    if (!s) s = el.title || el.querySelector?.('img[alt]')?.alt || el.querySelector?.('svg title')?.textContent;
    return clip(s);
  }

  function shortHref(h) {
    try {
      const u = new URL(h, location.href);
      if (u.protocol === 'javascript:') return '';
      return clip(u.origin === location.origin ? u.pathname + u.search : u.host + u.pathname, 50);
    } catch { return ''; }
  }

  function describe(el, r) {
    let s = `[ref_${refOf(el)}] ${r}`;
    if (r === 'input' && el.tagName === 'INPUT' && el.type !== 'text') s += ':' + el.type;
    const n = name(el);
    if (n) s += ` "${n.replace(/"/g, "'")}"`;
    if (r === 'select') {
      const o = [...el.options];
      s += ` ="${clip(el.selectedOptions[0]?.text, 30)}" {${o.slice(0, 8).map((x) => clip(x.text, 20)).join('|')}${o.length > 8 ? `|…+${o.length - 8}` : ''}}`;
    } else if (r === 'input' || r === 'combo' || r === 'num' || r === 'slider') {
      const v = el.isContentEditable ? el.innerText : el.value;
      if (v) s += el.type === 'password' ? ' ="***"' : ` =${JSON.stringify(clip(v, 40))}`;
    } else if (r === 'link') {
      const h = shortHref(el.getAttribute('href'));
      if (h && !n.includes(h)) s += ' →' + h;
    }
    const checked = el.checked ?? (el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || el.getAttribute('aria-pressed'));
    if (checked === true || checked === 'true') s += ' ✓';
    const exp = el.getAttribute('aria-expanded');
    if (exp) s += exp === 'true' ? ' open' : ' closed';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' disabled';
    if (el === deepActive()) s += ' *focus';
    return s;
  }

  function deepActive() {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  // ---- visibility --------------------------------------------------------
  function shown(el) {
    if (el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return true;
    return getComputedStyle(el).display === 'contents';
  }
  function sized(el) {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 ? r : null;
  }

  function modalRoot() {
    const cands = document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]');
    for (let i = cands.length - 1; i >= 0; i--) {
      const d = cands[i];
      const modal = d.matches(':modal') || d.getAttribute('aria-modal') === 'true';
      if (modal && shown(d) && sized(d)) return d;
    }
    return null;
  }

  // ---- snapshot ----------------------------------------------------------
  function collect(o) {
    const out = [];
    const els = [];
    const st = { above: 0, below: 0, n: 0 };
    const vh = innerHeight, vw = innerWidth;

    const emit = (line, el = null) => { if (st.n < o.max) { out.push(line); els.push(el); } st.n++; };

    const inView = (rect) => {
      if (o.scope === 'all') return true;
      if (rect.bottom < 0) { st.above++; return false; }
      if (rect.top > vh) { st.below++; return false; }
      return rect.right > 0 && rect.left < vw;
    };

    const visit = (el, pp, d = 0) => {
      if (o.depth && d > o.depth) return;
      if (SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true' || el.inert) return;
      if (!shown(el)) return;

      let r = role(el);
      // cursor:pointer elements without semantics (div onClick etc.)
      const cursor = !r && el.firstChild ? getComputedStyle(el).cursor === 'pointer' : false;

      if (r) {
        const rect = sized(el);
        if (rect && inView(rect)) emit(describe(el, r), el);
        if (r !== 'list' && r !== 'combo') return; // don't descend into controls
      } else if (cursor && !pp) {
        const rect = sized(el);
        // big pointer containers (cards/body) aren't buttons; only list small ones
        if (rect && rect.width * rect.height < vw * vh * 0.25 && inView(rect)) emit(describe(el, 'click'), el);
      } else if (HEAD[el.tagName] || el.getAttribute('role') === 'heading') {
        const rect = sized(el);
        if (rect && inView(rect)) {
          const t = clip(el.innerText, 80);
          if (t) emit(`${HEAD[el.tagName] || '##'} ${t}`, el);
        }
        return;
      } else if (el.matches('dialog[open], [role=dialog], [role=alertdialog]')) {
        emit(`== dialog "${clip(el.getAttribute('aria-label') || el.querySelector('h1,h2,h3')?.innerText, 40)}"`);
      } else if (o.text) {
        let t = '';
        for (const c of el.childNodes) if (c.nodeType === 3) t += c.data;
        t = clip(t, 120);
        if (t.length > 2) {
          const rect = sized(el);
          if (rect && inView(rect)) emit(`[ref_${refOf(el)}] · ${t}`, el);
        }
      }

      const isPtr = pp || cursor;
      for (const c of el.children) visit(c, isPtr, d + 1);
      if (el.shadowRoot) for (const c of el.shadowRoot.children) visit(c, isPtr, d + 1);
      if (el.tagName === 'IFRAME') {
        try { const b = el.contentDocument?.body; if (b) visit(b, false, d + 1); } catch { /* cross-origin */ }
      }
    };

    let root = null;
    if (o.root != null) {
      root = byRef(o.root);
      if (!root) throw new Error(`ref_id ${o.root} not found (stale). Run read_page again.`);
    }
    const modal = o.noModal || root ? null : modalRoot();
    visit(root || modal || document.body, false);
    return { out, els, st, modal: !!modal };
  }

  function header() {
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    return `${clip(document.title, 80)} | ${clip(location.href, 140)}\nscroll ${Math.round(scrollY)}/${max}`;
  }

  async function snap(o = {}) {
    o = { scope: 'view', max: 150, ...o };
    if (o.settle) await settle(200, 1500);
    const { out, st, modal } = collect(o);
    const lines = out;
    let foot = [];
    if (modal) foot.push('(modal open: showing dialog only)');
    if (st.n > o.max) foot.push(`(+${st.n - o.max} more lines cut; raise max_lines/max_chars, or focus with ref_id)`);
    if (st.below || st.above) foot.push(`(offscreen: ${st.above} above, ${st.below} below → scroll or scope:"all")`);

    if (o.diff && prev) {
      const a = new Set(prev), b = new Set(lines);
      const rem = prev.filter((l) => !b.has(l)), add = lines.filter((l) => !a.has(l));
      prev = lines;
      if (!rem.length && !add.length) return header() + '\n(no visible change)';
      if (rem.length + add.length < Math.max(12, lines.length * 0.7)) {
        return [header(), ...rem.map((l) => '- ' + l), ...add.map((l) => '+ ' + l), ...foot].join('\n');
      }
    }
    prev = lines;
    return cut([header(), ...lines, ...foot].join('\n'), o.maxChars);
  }

  function cut(txt, max) {
    if (!max || txt.length <= max) return txt;
    const at = txt.lastIndexOf('\n', max);
    return txt.slice(0, at > 0 ? at : max) + `\n…(truncated: full output is ${txt.length} chars; pass a larger max_chars or focus with ref_id/depth)`;
  }

  function settle(quiet = 200, max = 1500) {
    return new Promise((res) => {
      let t;
      const done = () => { obs.disconnect(); clearTimeout(t); clearTimeout(m); res(); };
      const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, quiet); });
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      t = setTimeout(done, quiet);
      const m = setTimeout(done, max);
    });
  }

  // ---- locating ----------------------------------------------------------
  function locate(a) {
    if (a.ref != null) {
      const el = byRef(a.ref);
      if (!el) throw new Error(`ref ${a.ref} not found (stale). Run snap again.`);
      return el;
    }
    if (a.sel) {
      const el = document.querySelector(a.sel);
      if (!el) throw new Error(`selector not found: ${a.sel}`);
      return el;
    }
    if (a.text) {
      const q = a.text.toLowerCase();
      let best = null, score = 0;
      const all = document.querySelectorAll('a,button,input,select,textarea,summary,[role],[onclick],[tabindex],label');
      for (const el of all) {
        if (!sized(el) || !shown(el)) continue;
        const n = name(el).toLowerCase();
        const s = n === q ? 3 : n.startsWith(q) ? 2 : n.includes(q) ? 1 : 0;
        if (s > score) { best = el; score = s; if (s === 3) break; }
      }
      if (!best) {
        // fall back to any element whose own text matches
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) {
          if (w.currentNode.data.toLowerCase().includes(q) && w.currentNode.parentElement && sized(w.currentNode.parentElement)) {
            best = w.currentNode.parentElement; break;
          }
        }
      }
      if (!best) throw new Error(`no element with text "${a.text}"`);
      return best;
    }
    const f = deepActive();
    if (f && f !== document.body) return f;
    throw new Error('need ref, sel or text');
  }

  function center(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  function label(el) {
    const r = role(el) || el.tagName.toLowerCase();
    const n = name(el);
    return `${r}${n ? ` "${n}"` : ''}`;
  }

  // ---- actions -----------------------------------------------------------
  const mouse = (el, type, p) => el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, {
    bubbles: true, cancelable: true, composed: true, view: window, clientX: p.x, clientY: p.y, button: 0, pointerId: 1, isPrimary: true,
  }));

  function setValue(el, v) {
    if (el.isContentEditable) {
      el.focus();
      document.getSelection().selectAllChildren(el);
      if (!document.execCommand('insertText', false, v)) el.innerText = v;
      return;
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function key(el, k) {
    const opts = { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, composed: true };
    if (k === 'Enter') opts.keyCode = opts.which = 13;
    const ok = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (ok && k === 'Enter' && el.form && el.tagName === 'INPUT') el.form.requestSubmit();
  }

  async function act(a) {
    const action = a.action;
    if (action === 'scroll' && a.ref == null && !a.sel && !a.text) {
      const dy = (a.dir === 'up' ? -1 : 1) * (a.amount || Math.round(innerHeight * 0.8));
      let tgt = document.scrollingElement;
      if (tgt.scrollHeight <= innerHeight + 5) {
        // page itself doesn't scroll: find a scrollable container in the middle
        let e = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        while (e && !(e.scrollHeight > e.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement;
        if (e) tgt = e;
      }
      tgt.scrollBy({ top: dy, behavior: 'instant' });
      await sleep(150);
      return { msg: `scrolled ${a.dir || 'down'}` };
    }
    if (action === 'press' && a.ref == null && !a.sel && !a.text) {
      const el = deepActive() || document.body;
      if (a.trusted) return { msg: `pressed ${a.key}`, cdp: { type: 'key', key: a.key } };
      key(el, a.key || 'Enter');
      await settle();
      return { msg: `pressed ${a.key}` };
    }

    const el = locate(a);
    const what = label(el);
    const p = center(el);

    switch (action) {
      case 'click': {
        if (a.trusted) return { msg: `clicked ${what}`, cdp: { type: 'click', ...p } };
        for (const t of ['pointerover', 'pointerenter', 'mouseover', 'pointerdown', 'mousedown']) mouse(el, t, p);
        el.focus?.({ preventScroll: true });
        for (const t of ['pointerup', 'mouseup']) mouse(el, t, p);
        el.click();
        break;
      }
      case 'hover':
        if (a.trusted) return { msg: `hovered ${what}`, cdp: { type: 'hover', ...p } };
        for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) mouse(el, t, p);
        break;
      case 'focus': el.focus(); break;
      case 'scroll': break; // already scrolled into view
      case 'clear': el.focus(); setValue(el, ''); break;
      case 'type': case 'fill': {
        const v = String(a.value ?? '');
        el.focus();
        if (a.trusted) {
          if (!a.append) { if (el.select) el.select(); else document.getSelection().selectAllChildren(el); }
          return { msg: `typed into ${what}`, cdp: { type: 'insert', text: v, submit: a.submit } };
        }
        setValue(el, a.append ? (el.value ?? el.innerText) + v : v);
        if (a.submit) key(el, 'Enter');
        break;
      }
      case 'select': {
        if (el.tagName !== 'SELECT') throw new Error(`${what} is not a <select>; click it then click the option`);
        const want = String(a.value ?? '').toLowerCase();
        const opt = [...el.options].find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want)
          || [...el.options].find((o) => o.text.toLowerCase().includes(want));
        if (!opt) throw new Error(`option "${a.value}" not in ${what}`);
        el.focus();
        setValue(el, opt.value);
        break;
      }
      case 'check': case 'uncheck': {
        const want = action === 'check';
        const cur = el.checked ?? el.getAttribute('aria-checked') === 'true';
        if (cur !== want) {
          if (a.trusted) return { msg: `${action}ed ${what}`, cdp: { type: 'click', ...p } };
          el.click();
        }
        break;
      }
      case 'press':
        el.focus();
        if (a.trusted) return { msg: `pressed ${a.key}`, cdp: { type: 'key', key: a.key } };
        key(el, a.key || 'Enter');
        break;
      default: throw new Error(`unknown action: ${action}`);
    }
    await settle();
    return { msg: `${action} ${what} ok` };
  }

  // ---- misc ops ----------------------------------------------------------
  function read(a) {
    // last:true with a selector → the last match (e.g. the newest chat message)
    const root = a.sel ? (a.last ? [...document.querySelectorAll(a.sel)].pop() : document.querySelector(a.sel))
      : a.ref != null ? byRef(a.ref)
      : document.querySelector('main, article, [role=main]') || document.body;
    if (!root) throw new Error('element not found');
    const txt = root.innerText.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    if (a.raw) return txt;
    const off = a.offset || 0, max = a.max || 4000;
    const part = txt.slice(off, off + max);
    const rest = txt.length - off - part.length;
    return part + (rest > 0 ? `\n…(${rest} more chars; read offset:${off + max})` : '');
  }

  // "find" by purpose or text: scores every element on the page against the query's words,
  // with role synonyms ("search bar" → input, "login button" → btn) and attributes (id, name, placeholder…)
  const ROLE_WORDS = {
    button: 'btn', btn: 'btn', tombol: 'btn', link: 'link', tautan: 'link', anchor: 'link',
    input: 'input', field: 'input', box: 'input', bar: 'input', textbox: 'input', textarea: 'input', kolom: 'input', search: 'input',
    checkbox: 'cb', toggle: 'switch', switch: 'switch', radio: 'radio', dropdown: 'select', select: 'select', combobox: 'combo', picker: 'select',
    menu: 'menu', tab: 'tab', slider: 'slider', upload: 'file', file: 'file', heading: '#', title: '#', judul: '#', option: 'opt',
  };
  const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'at', 'with', 'and', 'or', 'that', 'this', 'which', 'containing',
    'contains', 'called', 'named', 'labeled', 'labelled', 'element', 'elements', 'text', 'yang', 'di', 'ke', 'untuk', 'dan', 'atau', 'dengan']);
  const SYN = { login: ['log in', 'sign in', 'masuk'], signin: ['sign in', 'log in'], signup: ['sign up', 'register', 'daftar'], logout: ['log out', 'sign out', 'keluar'],
    cart: ['basket', 'keranjang', 'bag'], search: ['cari', 'find', 'query'], submit: ['send', 'kirim', 'save', 'simpan'], close: ['dismiss', 'tutup', '×', 'x'],
    email: ['e-mail', 'mail'], password: ['kata sandi', 'pass'], next: ['continue', 'lanjut'], menu: ['hamburger', 'navigation'] };

  function attrs(el) {
    if (!el || el.nodeType !== 1) return '';
    return [el.id, el.getAttribute('name'), el.getAttribute('placeholder'), el.getAttribute('type'), el.getAttribute('title'),
      el.getAttribute('aria-label'), el.getAttribute('role'), el.getAttribute('data-testid'), el.getAttribute('href'),
      typeof el.className === 'string' ? el.className : ''].filter(Boolean).join(' ').toLowerCase();
  }

  function find(a) {
    const raw = String(a.q || '').trim();
    const q = raw.toLowerCase();
    const words = q.split(/[^\p{L}\p{N}@._-]+/u).filter((w) => w && !STOP.has(w));
    const roles = new Set(words.map((w) => ROLE_WORDS[w.replace(/s$/, '')] || ROLE_WORDS[w]).filter(Boolean));
    const { out, els } = collect({ scope: 'all', text: true, max: 8000, noModal: true });
    const scored = [];
    out.forEach((line, i) => {
      const l = line.toLowerCase();
      const at = attrs(els[i]);
      const lineRole = (/\] (\S+)/.exec(line)?.[1] || (line.startsWith('#') ? '#' : '')).split(':')[0];
      let sc = 0, hit = 0;
      if (q && l.includes(q)) sc += 10;
      for (const w of words) {
        const alts = [w, ...(SYN[w] || [])];
        if (alts.some((x) => l.includes(x))) { sc += 3; hit++; }
        else if (alts.some((x) => at.includes(x))) { sc += 1.5; hit++; }
      }
      if (roles.size && roles.has(lineRole)) sc += 2.5;
      if (/·/.test(line) && roles.size) sc -= 1; // plain text when an element type was asked for
      if (sc > 0 && (hit || (roles.has(lineRole) && words.length <= 2))) scored.push([sc, i, line]);
    });
    if (!scored.length) return `no element matches "${raw}" (try other words, or read_page scope:"all")`;
    scored.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    const top = scored[0][0];
    const good = scored.filter((x) => x[0] >= Math.min(top * 0.5, 4));
    // the best matches only: drop weak tails (well below the top score), then cap
    const lim = Math.min(Math.max(+a.limit || 5, 1), 20);
    const strong = good.filter((x) => x[0] >= top * 0.6);
    const shown = strong.slice(0, lim);
    let res = shown.map((x) => x[2]).join('\n');
    if (good.length > shown.length) res += `\n(${shown.length} of ${good.length} matches shown; raise limit (max 20) or use a more specific query)`;
    return res;
  }

  async function wait(a) {
    const end = Date.now() + (a.timeout || 10000);
    const test = () => {
      let hit = a.sel ? !!document.querySelector(a.sel) : document.body.innerText.toLowerCase().includes(String(a.text).toLowerCase());
      return a.gone ? !hit : hit;
    };
    if (test()) return a.gone ? 'absent' : 'ok';
    while (Date.now() < end) {
      await sleep(100);
      if (test()) return 'ok';
    }
    throw new Error(`timeout waiting for ${a.sel || `"${a.text}"`}${a.gone ? ' to disappear' : ''}`);
  }

  // Scroll only when needed, then re-measure until the box stops moving: popovers/menus
  // (e.g. GitHub's anchored overlays) reposition a frame or two after a scroll or open.
  async function rect(a) {
    const el = locate(a);
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    let r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    if (!visible) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    for (let i = 0; i < 10; i++) {
      await Promise.race([frame(), sleep(50)]);
      const n = el.getBoundingClientRect();
      const same = Math.abs(n.left - r.left) < 1 && Math.abs(n.top - r.top) < 1 && Math.abs(n.width - r.width) < 1;
      r = n;
      if (same && i > 0) break;
    }
    return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth };
  }

  // tag an element so the main world / CDP can find it (refs live in this isolated world)
  function mark(a) {
    const el = locate(a);
    const tok = 'm' + Math.random().toString(36).slice(2, 10);
    el.setAttribute('data-kd-mark', tok);
    return { tok, what: label(el), tag: el.tagName, type: el.type || '' };
  }

  // put a file into an <input type=file>, or drag-and-drop it onto an element / point
  function drop(a) {
    const el = a.x != null ? document.elementFromPoint(a.x, a.y) : locate(a);
    if (!el) throw new Error(`nothing at (${a.x},${a.y})`);
    const bin = atob(a.b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], a.name || 'image.png', { type: a.mime || 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    if (el.tagName === 'INPUT' && el.type === 'file') {
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { msg: `set ${file.name} (${u8.length} bytes) on ${label(el)}` };
    }
    const r = el.getBoundingClientRect();
    const x = a.x ?? r.left + r.width / 2, y = a.y ?? r.top + r.height / 2;
    for (const t of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
    }
    return { msg: `dropped ${file.name} (${u8.length} bytes) onto ${label(el)} at (${Math.round(x)},${Math.round(y)})` };
  }

  // cheap signature of an element's (or the page's) text, to detect when streaming output settles
  function sig(a) {
    const el = a.sel ? [...document.querySelectorAll(a.sel)].pop() : document.body;
    if (!el) return 'missing';
    const t = el.innerText || '';
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    return `${t.length}:${h}`;
  }

  const OPS = { snap, act, read, find, wait, rect, mark, drop, sig };
  globalThis.__kd = async (op, a) => {
    try { return await OPS[op](a || {}); } catch (e) { return { __err: e.message || String(e) }; }
  };
})();
