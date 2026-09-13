// ==Bookmarklet==
// @name Wikipedia Edit History Colors
// @author Andres Cuervo
// ==/Bookmarklet==
//
// Colors every word of the current Wikipedia article by the date it was
// added, on a ROYGBV ramp whose lightness runs monotonically from black
// (oldest) to white (newest) so the ordering survives color blindness and
// grayscale. Triple-click (or triple-tap) any word to open a 60% inset popup
// showing the article section as it was in the revision that added the word,
// scrolled so that word sits in the center.
//
// Only the same-origin MediaWiki API is used, so it works on every language
// edition (and on any other MediaWiki site that exposes mw.config).
(function () {
  'use strict';

  var NS = 'weh';
  var SEP = '';
  var CFG = {
    samples: 24, // initial samples, evenly spaced in time
    refine: 16, // extra adaptive samples spent on the busiest time buckets
    concurrency: 5,
    minGapMs: 3600e3, // never split a bucket narrower than an hour
    listPages: 4, // max history pages (500 revs each) fetched when pinpointing
    near: 40, // bigram-only match window (in wikitext tokens)
    window: 400 // bigram-only mid-range window
  };

  // ---------------------------------------------------------------------
  // Pure helpers (also exported for unit tests)
  // ---------------------------------------------------------------------

  // CJK-ish scripts get one token per character; everything else splits into
  // letter/number runs plus single punctuation characters. Whitespace is never
  // a token, which is why spaces are never colored.
  var TOKEN_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}]|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}])[\p{L}\p{N}\p{M}])+|[^\s\p{L}\p{N}\p{M}]/gu;

  function norm(s) {
    return s.normalize('NFC').toLowerCase();
  }

  function tokenize(text) {
    var out = [];
    var m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) out.push(norm(m[0]));
    return out;
  }

  function cleanWikitext(wt) {
    return wt.replace(/<!--[\s\S]*?-->/g, ' ');
  }

  function bigramSet(tokens) {
    var s = new Set();
    for (var i = 0; i + 1 < tokens.length; i++) s.add(tokens[i] + SEP + tokens[i + 1]);
    return s;
  }

  var WORD_RE = /[\p{L}\p{N}]/u;
  var OPENERS = '([{<"\'«“‘¿¡';

  // Is token i of W "present" in a revision described by bigram set `set`?
  // A word counts as present when either of its neighbouring bigrams exists,
  // so inserting a word next to it does not steal its attribution.
  // Punctuation binds to the word it is attached to: the one before it, or
  // the one after it for opening brackets and quotes.
  function present(set, W, i) {
    var t = W[i];
    var left = i > 0 && set.has(W[i - 1] + SEP + t);
    var right = i + 1 < W.length && set.has(t + SEP + W[i + 1]);
    if (WORD_RE.test(t)) return left || right;
    if (OPENERS.indexOf(t) !== -1) return i + 1 < W.length ? right : left;
    return i > 0 ? left : right;
  }

  function bigramIndex(W) {
    var idx = new Map();
    for (var j = 0; j + 1 < W.length; j++) {
      var k = W[j] + SEP + W[j + 1];
      var arr = idx.get(k);
      if (arr) arr.push(j);
      else idx.set(k, [j]);
    }
    return idx;
  }

  function firstAtOrAfter(sorted, p) {
    var lo = 0,
      hi = sorted.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (sorted[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return lo < sorted.length ? sorted[lo] : -1;
  }

  // Aligns rendered tokens (RK: array of normalized strings) with wikitext
  // tokens W. Returns an array wi where wi[i] is the index into W or -1.
  // Rendered text mostly follows wikitext order, so we walk with a pointer
  // and accept nearby bigram matches; far jumps (including backwards jumps,
  // which is how the reference list gets matched) need trigram confirmation.
  function align(RK, W) {
    var n = RK.length;
    var wi = new Array(n);
    for (var z = 0; z < n; z++) wi[z] = -1;
    var idx = bigramIndex(W);
    var p = 0;

    function tri(i, j) {
      return (i + 2 < n && j + 2 < W.length && W[j + 2] === RK[i + 2]) || (i > 0 && j > 0 && W[j - 1] === RK[i - 1]);
    }

    for (var i = 0; i < n; i++) {
      if (wi[i] !== -1) {
        p = wi[i] + 1;
        continue;
      }
      var cands = i + 1 < n ? idx.get(RK[i] + SEP + RK[i + 1]) : null;
      var j = -1;
      if (cands) {
        j = firstAtOrAfter(cands, p);
        if (j === -1 || j - p > CFG.near) {
          var confirmed = null;
          var far = j;
          for (var c = 0; c < cands.length; c++) {
            if (tri(i, cands[c])) {
              if (cands[c] >= p) {
                confirmed = cands[c];
                break;
              }
              if (confirmed === null) confirmed = cands[c];
            }
          }
          if (confirmed !== null) j = confirmed;
          else if (far !== -1 && far - p <= CFG.window) j = far;
          else if (cands.length === 1 && RK[i].length + RK[i + 1].length >= 6) j = cands[0]; // unique bigram anchors on its own
          else j = -1;
        }
      }
      if (j !== -1) {
        wi[i] = j;
        wi[i + 1] = j + 1;
        p = j + 2;
        continue;
      }
      // Lone token (e.g. a one-word heading or the last word of a run): take
      // an exact match at the pointer, or look a little ahead for longer words.
      var lim = RK[i].length >= 3 ? Math.min(W.length, p + CFG.near) : Math.min(W.length, p + 1);
      for (var q = p; q < lim; q++) {
        if (W[q] === RK[i]) {
          wi[i] = q;
          p = q + 1;
          break;
        }
      }
    }

    // Gap fill: an unmatched token sitting between two matched neighbours
    // whose wikitext positions bracket it.
    for (var g = 1; g + 1 < n; g++) {
      if (wi[g] !== -1 || wi[g - 1] === -1 || wi[g + 1] === -1) continue;
      var a = wi[g - 1],
        b = wi[g + 1];
      if (b <= a + 1 || b - a > 12) continue;
      for (var k = a + 1; k < b; k++) {
        if (W[k] === RK[g]) {
          wi[g] = k;
          break;
        }
      }
    }
    return wi;
  }

  // Piecewise-linear ROYGBV hue (OKLCH degrees) over t in [0, 1].
  var HUES = [
    [0, 28],
    [0.2, 60],
    [0.4, 98],
    [0.6, 142],
    [0.8, 258],
    [1, 305]
  ];
  function hueAt(t) {
    for (var i = 1; i < HUES.length; i++) {
      if (t <= HUES[i][0]) {
        var f = (t - HUES[i - 1][0]) / (HUES[i][0] - HUES[i - 1][0]);
        return HUES[i - 1][1] + f * (HUES[i][1] - HUES[i - 1][1]);
      }
    }
    return HUES[HUES.length - 1][1];
  }

  // Returns CSS declarations for a token added at position t (0 = oldest,
  // 1 = newest). Lightness always climbs with t so the order can be read in
  // black and white; hue is a redundant ROYGBV cue.
  function ramp(t, mode) {
    t = Math.max(0, Math.min(1, t));
    var h = hueAt(t).toFixed(1);
    var L, C, bg;
    if (mode === 'ink') {
      L = 0.27 + 0.33 * t;
      C = 0.17;
      return 'color:oklch(' + L.toFixed(3) + ' ' + C + ' ' + h + ')';
    }
    L = 0.2 + 0.76 * t;
    C = mode === 'mono' ? 0 : 0.13;
    bg = 'oklch(' + L.toFixed(3) + ' ' + C + ' ' + h + ')';
    return 'background:' + bg + ';color:' + (L >= 0.62 ? '#000' : '#fff');
  }

  function rampColor(t, mode) {
    var m = /oklch\([^)]*\)/.exec(ramp(t, mode));
    return m ? m[0] : '#888';
  }

  function isoSec(ms) {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  var WEH = {
    tokenize: tokenize,
    cleanWikitext: cleanWikitext,
    bigramSet: bigramSet,
    present: present,
    align: align,
    ramp: ramp,
    rampColor: rampColor,
    hueAt: hueAt
  };

  if (typeof window === 'undefined' && typeof module === 'object' && module.exports) {
    module.exports = WEH;
    return;
  }

  // ---------------------------------------------------------------------
  // Browser part
  // ---------------------------------------------------------------------

  if (window[NS]) {
    window[NS].destroy();
    return;
  }

  var mwc = window.mw && window.mw.config;
  if (!mwc || !mwc.get('wgArticleId')) {
    alert('This bookmarklet needs an existing Wikipedia (MediaWiki) article page.');
    return;
  }
  if (mwc.get('wgPageContentModel') && mwc.get('wgPageContentModel') !== 'wikitext') {
    alert('This page is not wikitext, so there is no edit history to color.');
    return;
  }

  var pageId = mwc.get('wgArticleId');
  var revId = mwc.get('wgRevisionId') || mwc.get('wgCurRevisionId');
  var scriptPath = mwc.get('wgScriptPath') || '/w';
  var apiUrl = scriptPath + '/api.php';
  var indexUrl = mwc.get('wgScript') || scriptPath + '/index.php';

  var SKIP =
    'script,style,textarea,input,.mw-editsection,.mw-editsection-like,sup.reference,.mw-cite-backlink,.navbox,.vertical-navbox,.toc,#toc,.mw-jump-link,.mwe-math-element,math,.printfooter,.catlinks,.ambox,.sistersitebox,.side-box,.hatnote,.shortdescription,.mw-indicators,figure figcaption .mw-editsection';

  var state = {
    container: null,
    R: [], // rendered tokens {node, start, end, key, wi, span}
    W: [],
    origin: [], // W index -> sample
    usedW: [],
    samples: [],
    uid: 0,
    t0: 0,
    tN: 1,
    mode: 'highlight',
    reversed: false,
    replaced: [],
    style: null,
    legend: null,
    toast: null,
    popup: null,
    revCache: new Map(),
    listeners: [],
    done: false
  };
  window[NS] = state;

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'style') e.style.cssText = attrs[k];
        else if (k === 'text') e.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  function fmtDate(ms) {
    var d = new Date(ms);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtDateTime(ms) {
    return new Date(ms).toLocaleString();
  }

  function status(msg) {
    if (!state.toast) {
      state.toast = el('div', {
        style:
          'position:fixed;top:12px;right:12px;z-index:100001;background:#222;color:#fff;padding:8px 12px;border-radius:6px;font:13px/1.4 sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:60vw'
      });
      document.body.appendChild(state.toast);
    }
    if (msg === null) {
      state.toast.remove();
      state.toast = null;
    } else state.toast.textContent = msg;
  }

  function api(params) {
    var q = new URLSearchParams({ format: 'json', formatversion: '2' });
    Object.keys(params).forEach(function (k) {
      q.set(k, params[k]);
    });
    return fetch(apiUrl + '?' + q.toString(), { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (j.error) throw new Error(j.error.info || j.error.code);
        return j;
      });
  }

  function pageRevs(j) {
    var p = j.query && j.query.pages && j.query.pages[0];
    return (p && p.revisions) || [];
  }

  function toSample(rev) {
    var c = rev.slots && rev.slots.main && rev.slots.main.content;
    if (typeof c !== 'string') return null;
    return {
      uid: state.uid++,
      id: rev.revid,
      ts: Date.parse(rev.timestamp),
      user: rev.user || '',
      comment: rev.comment || '',
      text: c,
      prev: null,
      noSplit: false,
      between: null
    };
  }

  var REVPROPS = 'ids|timestamp|user|comment|content';

  // First revision with content at or after `fromMs` (and no later than `toMs`).
  function revAt(fromMs, toMs) {
    var params = { action: 'query', prop: 'revisions', pageids: pageId, rvslots: 'main', rvprop: REVPROPS, rvdir: 'newer', rvlimit: 3 };
    if (fromMs != null) params.rvstart = isoSec(fromMs);
    if (toMs != null) params.rvend = isoSec(toMs);
    return api(params).then(function (j) {
      var revs = pageRevs(j);
      for (var i = 0; i < revs.length; i++) {
        var s = toSample(revs[i]);
        if (s) return s;
      }
      return null;
    });
  }

  function revById(id) {
    if (state.revCache.has(id)) return Promise.resolve(state.revCache.get(id));
    return api({ action: 'query', prop: 'revisions', revids: id, rvslots: 'main', rvprop: REVPROPS }).then(function (j) {
      var s = toSample(pageRevs(j)[0] || {});
      state.revCache.set(id, s);
      return s;
    });
  }

  function pool(tasks, limit, onEach) {
    var i = 0,
      results = new Array(tasks.length),
      doneN = 0;
    return new Promise(function (resolve, reject) {
      function next() {
        if (doneN === tasks.length) return resolve(results);
        while (i < tasks.length && i - doneN < limit) {
          (function (k) {
            i++;
            tasks[k]().then(
              function (r) {
                results[k] = r;
                doneN++;
                if (onEach) onEach(doneN);
                next();
              },
              function (e) {
                reject(e);
              }
            );
          })(i);
        }
      }
      next();
    });
  }

  // --- DOM tokens -------------------------------------------------------

  function domTokens(root) {
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || parent.closest(SKIP)) continue;
      var data = node.data;
      if (!/\S/.test(data)) continue;
      var m;
      TOKEN_RE.lastIndex = 0;
      while ((m = TOKEN_RE.exec(data))) {
        out.push({ node: node, start: m.index, end: m.index + m[0].length, key: norm(m[0]), wi: -1, span: null });
      }
    }
    return out;
  }

  function findContainer() {
    var c = document.querySelector('#mw-content-text .mw-parser-output') || document.querySelector('#mw-content-text') || document.querySelector('#bodyContent');
    return c;
  }

  // --- attribution ------------------------------------------------------

  function insertSorted(s) {
    var arr = state.samples;
    var k = 0;
    while (k < arr.length && arr[k].ts <= s.ts) k++;
    arr.splice(k, 0, s);
    relink();
  }

  function relink() {
    var arr = state.samples;
    for (var i = 0; i < arr.length; i++) arr[i].prev = i ? arr[i - 1] : null;
  }

  function attributeAll() {
    var W = state.W;
    var pending = state.usedW.slice();
    var origin = state.origin;
    for (var k = 0; k < state.samples.length && pending.length; k++) {
      var s = state.samples[k];
      var set = bigramSet(tokenize(cleanWikitext(s.text)));
      var rest = [];
      for (var q = 0; q < pending.length; q++) {
        var i = pending[q];
        if (present(set, W, i)) origin[i] = s;
        else rest.push(i);
      }
      pending = rest;
    }
    var last = state.samples[state.samples.length - 1];
    for (var r = 0; r < pending.length; r++) origin[pending[r]] = last;
  }

  function bucketCounts() {
    var counts = new Map();
    for (var q = 0; q < state.usedW.length; q++) {
      var s = state.origin[state.usedW[q]];
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    return counts;
  }

  function splitBucket(s) {
    var prev = s.prev;
    var mid = (prev.ts + s.ts) / 2;
    return revAt(mid, s.ts).then(function (m) {
      if (!m || m.id === s.id || m.id === prev.id) {
        s.noSplit = true;
        return false;
      }
      for (var k = 0; k < state.samples.length; k++) if (state.samples[k].id === m.id) return (s.noSplit = true), false;
      insertSorted(m);
      var set = bigramSet(tokenize(cleanWikitext(m.text)));
      var W = state.W;
      for (var q = 0; q < state.usedW.length; q++) {
        var i = state.usedW[q];
        if (state.origin[i] === s && present(set, W, i)) state.origin[i] = m;
      }
      return true;
    });
  }

  function refine(budget) {
    if (budget <= 0) return Promise.resolve();
    var counts = bucketCounts();
    var cands = state.samples
      .filter(function (s) {
        return s.prev && !s.noSplit && s.ts - s.prev.ts >= CFG.minGapMs && counts.get(s);
      })
      .sort(function (a, b) {
        return counts.get(b) - counts.get(a);
      })
      .slice(0, Math.min(4, budget));
    if (!cands.length) return Promise.resolve();
    status('Refining dates… (' + (CFG.refine - budget + cands.length) + '/' + CFG.refine + ' extra samples)');
    return Promise.all(cands.map(splitBucket)).then(function () {
      paint();
      return refine(budget - cands.length);
    });
  }

  // --- painting ---------------------------------------------------------

  function tOf(s) {
    var mid = s.prev ? (s.prev.ts + s.ts) / 2 : s.ts;
    var t = (mid - state.t0) / (state.tN - state.t0 || 1);
    return state.reversed ? 1 - t : t;
  }

  function buildCss() {
    var css = '.weh-t{border-radius:2px}.weh-na{text-decoration:underline dotted #b0b0b0}.weh-t:hover{outline:1px solid #000}.weh-box .mw-editsection{display:none}\n';
    state.samples.forEach(function (s) {
      css += '.weh-u' + s.uid + '{' + ramp(tOf(s), state.mode) + '}\n';
    });
    return css;
  }

  function paint() {
    if (!state.style) {
      state.style = el('style');
      document.head.appendChild(state.style);
    }
    state.style.textContent = buildCss();
    var R = state.R;
    for (var i = 0; i < R.length; i++) {
      var r = R[i];
      if (!r.span) continue;
      var s = r.wi === -1 ? null : state.origin[r.wi];
      r.span.className = s ? 'weh-t weh-u' + s.uid : 'weh-t weh-na';
    }
    updateLegend();
  }

  function wrapTokens() {
    var R = state.R;
    var i = 0;
    while (i < R.length) {
      var node = R[i].node;
      var j = i;
      while (j < R.length && R[j].node === node) j++;
      var frag = document.createDocumentFragment();
      var pos = 0;
      var data = node.data;
      var nodes = [];
      for (var k = i; k < j; k++) {
        var r = R[k];
        if (r.start > pos) nodes.push(document.createTextNode(data.slice(pos, r.start)));
        r.span = el('span', { 'data-r': String(k), text: data.slice(r.start, r.end) });
        nodes.push(r.span);
        pos = r.end;
      }
      if (pos < data.length) nodes.push(document.createTextNode(data.slice(pos)));
      nodes.forEach(function (n) {
        frag.appendChild(n);
      });
      state.replaced.push({ node: node, nodes: nodes });
      node.parentNode.replaceChild(frag, node);
      i = j;
    }
  }

  function unwrapTokens() {
    state.replaced.forEach(function (rep) {
      var first = rep.nodes[0];
      if (!first.parentNode) return;
      first.parentNode.insertBefore(rep.node, first);
      rep.nodes.forEach(function (n) {
        n.remove();
      });
    });
    state.replaced = [];
  }

  // --- legend -----------------------------------------------------------

  function makeLegend() {
    var bar = el('div', { class: 'weh-bar', style: 'height:14px;border-radius:3px;border:1px solid #888;margin:4px 0' });
    var labels = el('div', { style: 'display:flex;justify-content:space-between;font-size:11px' });
    var modes = el('div', { style: 'display:flex;gap:4px;flex-wrap:wrap;margin-top:6px' });
    function btn(label, title, fn) {
      return el('button', { text: label, title: title, style: 'font:11px sans-serif;padding:2px 7px;border:1px solid #888;border-radius:4px;background:#f4f4f4;cursor:pointer', onclick: fn });
    }
    [
      ['highlight', 'Highlight', 'Color behind each word, black/white text for contrast'],
      ['ink', 'Ink', 'Color the letters themselves'],
      ['mono', 'Mono', 'Grayscale only: black = oldest, white = newest']
    ].forEach(function (m) {
      modes.appendChild(
        btn(m[1], m[2], function () {
          state.mode = m[0];
          paint();
        })
      );
    });
    modes.appendChild(
      btn('⇄', 'Reverse the ramp direction', function () {
        state.reversed = !state.reversed;
        paint();
      })
    );
    modes.appendChild(btn('✕', 'Remove coloring', destroy));
    var info = el('div', { class: 'weh-info', style: 'font-size:11px;color:#444;margin-top:4px' });
    var hint = el('div', { style: 'font-size:11px;color:#444;margin-top:2px', text: 'Triple-click / triple-tap a word to see the section as it was when that word was added.' });
    state.legend = el(
      'div',
      {
        style:
          'position:fixed;bottom:12px;right:12px;z-index:100000;background:#fff;color:#111;border:1px solid #999;border-radius:8px;padding:8px 10px;font:12px/1.35 sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.25);width:min(320px,calc(100vw - 40px))'
      },
      [el('div', { style: 'font-weight:bold', text: 'When was this text added?' }), bar, labels, modes, info, hint]
    );
    state.legend._bar = bar;
    state.legend._labels = labels;
    state.legend._info = info;
    document.body.appendChild(state.legend);
  }

  function updateLegend() {
    if (!state.legend) return;
    var stops = [];
    for (var i = 0; i <= 32; i++) {
      var t = i / 32;
      stops.push(rampColor(t, state.mode) + ' ' + (t * 100).toFixed(1) + '%');
    }
    state.legend._bar.style.background = 'linear-gradient(to right,' + stops.join(',') + ')';
    var a = fmtDate(state.t0),
      b = fmtDate(state.tN),
      mid = fmtDate((state.t0 + state.tN) / 2);
    var l = state.legend._labels;
    l.textContent = '';
    (state.reversed ? [b, mid, a] : [a, mid, b]).forEach(function (s) {
      l.appendChild(el('span', { text: s }));
    });
    var matched = 0;
    for (var k = 0; k < state.R.length; k++) if (state.R[k].wi !== -1) matched++;
    state.legend._info.textContent = state.samples.length + ' revisions sampled · ' + matched + ' of ' + state.R.length + ' words dated' + (state.done ? '' : ' · refining…');
  }

  // --- tooltips + triple click ----------------------------------------

  function describe(s, exact) {
    if (exact) return 'Added ' + fmtDateTime(s.ts) + ' by ' + s.user + ' (revision ' + s.id + ')';
    if (!s.prev) return 'Present since the first revision, ' + fmtDateTime(s.ts);
    return 'Added between ' + fmtDateTime(s.prev.ts) + ' and ' + fmtDateTime(s.ts);
  }

  function onOver(e) {
    var t = e.target;
    if (!t.classList || !t.classList.contains('weh-t') || t.title) return;
    var r = state.R[+t.getAttribute('data-r')];
    var s = r && r.wi !== -1 ? state.origin[r.wi] : null;
    t.title = s ? describe(s, false) : 'Not found in the wikitext (generated by a template or the software)';
  }

  var taps = { el: null, t: 0, n: 0, nav: null };
  function onClick(e) {
    var span = e.target.closest && e.target.closest('.weh-t');
    if (!span || !state.container.contains(span)) return;
    var now = Date.now();
    if (span === taps.el && now - taps.t < 650) taps.n++;
    else taps.n = 1;
    taps.el = span;
    taps.t = now;
    var link = e.target.closest('a[href]');
    if (taps.n >= 3 || e.detail >= 3) {
      taps.n = 0;
      if (taps.nav) clearTimeout(taps.nav);
      taps.nav = null;
      e.preventDefault();
      openPopup(span);
      return;
    }
    if (link && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
      // Delay link navigation a little so a triple click can cancel it.
      e.preventDefault();
      if (taps.nav) clearTimeout(taps.nav);
      taps.nav = setTimeout(function () {
        taps.nav = null;
        if (link.target === '_blank') window.open(link.href);
        else location.href = link.href;
      }, 700);
    }
  }
  function onDown(e) {
    if (e.detail >= 3 && e.target.closest && e.target.closest('.weh-t')) e.preventDefault();
  }
  function onKey(e) {
    if (e.key === 'Escape' && state.popup) closePopup();
  }

  function listen(target, type, fn) {
    target.addEventListener(type, fn);
    state.listeners.push([target, type, fn]);
  }

  // --- popup ------------------------------------------------------------

  function closePopup() {
    if (!state.popup) return;
    state.popup.remove();
    state.popup = null;
    document.documentElement.style.overflow = state._overflow || '';
  }

  function headingBefore(root, node) {
    var hs = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
    var h = null;
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) h = hs[i];
      else break;
    }
    return h;
  }
  function blockOf(h) {
    return h.parentElement && h.parentElement.classList.contains('mw-heading') ? h.parentElement : h;
  }

  // Extracts (as a clone) the section of `root` containing `node`.
  function sectionClone(root, node) {
    var h = headingBefore(root, node);
    var range = document.createRange();
    var hs = root.querySelectorAll('h2,h3,h4,h5,h6');
    var next = null;
    if (h) {
      var lvl = +h.tagName[1];
      for (var i = 0; i < hs.length; i++) {
        if (h.compareDocumentPosition(hs[i]) & Node.DOCUMENT_POSITION_FOLLOWING && +hs[i].tagName[1] <= lvl) {
          next = hs[i];
          break;
        }
      }
      range.setStartBefore(blockOf(h));
    } else {
      range.setStart(root, 0);
      next = hs[0] || null;
    }
    if (next) range.setEndBefore(blockOf(next));
    else range.setEnd(root, root.childNodes.length);
    return range.cloneContents();
  }

  // Finds the rendered token sequence around R index ri inside `root` (a
  // rendering of an older revision). Returns the token objects found.
  function locate(root, ri) {
    var R = state.R;
    var toks = domTokens(root);
    var keys = toks.map(function (t) {
      return t.key;
    });
    var ctx = [3, 2, 1, 0];
    for (var c = 0; c < ctx.length; c++) {
      var a = Math.max(0, ri - ctx[c]),
        b = Math.min(R.length - 1, ri + ctx[c]);
      var seq = [];
      for (var q = a; q <= b; q++) seq.push(R[q].key);
      outer: for (var i = 0; i + seq.length <= keys.length; i++) {
        for (var k = 0; k < seq.length; k++) if (keys[i + k] !== seq[k]) continue outer;
        return { tokens: toks.slice(i, i + seq.length), center: ri - a };
      }
    }
    return null;
  }

  // Wraps the found tokens in <mark>s, the clicked one (index `center`)
  // strongly and its context faintly. Works back to front so earlier offsets
  // in the same text node stay valid.
  function markTokens(found, center) {
    var mark = null;
    for (var i = found.length - 1; i >= 0; i--) {
      var t = found[i];
      var range = document.createRange();
      range.setStart(t.node, t.start);
      range.setEnd(t.node, t.end);
      var isCenter = i === center;
      var m = el('mark', {
        class: isCenter ? 'weh-mark' : 'weh-mark-ctx',
        style: isCenter ? 'background:#ff0;color:#000;outline:2px solid #f80;border-radius:2px' : 'background:#fff3b0;color:#000;border-radius:2px'
      });
      try {
        range.surroundContents(m);
        if (isCenter) mark = m;
      } catch (e) {}
    }
    return mark;
  }

  function revisionsBetween(s) {
    if (s.between) return Promise.resolve(s.between);
    var list = [];
    function page(cont, n) {
      var params = { action: 'query', prop: 'revisions', pageids: pageId, rvprop: 'ids|timestamp', rvdir: 'newer', rvlimit: 'max', rvstartid: s.prev.id, rvendid: s.id };
      if (cont) params.rvcontinue = cont;
      return api(params).then(function (j) {
        list = list.concat(pageRevs(j));
        var c = j['continue'] && j['continue'].rvcontinue;
        if (c && n < CFG.listPages) return page(c, n + 1);
        return list.filter(function (r) {
          return r.revid !== s.prev.id;
        });
      });
    }
    return page(null, 1).then(function (l) {
      s.between = l;
      return l;
    });
  }

  // Binary search for the exact revision that added W token wi within the
  // bucket ending at sample s (known absent at s.prev, present at s).
  function pinpoint(s, wi) {
    if (!s.prev) return Promise.resolve({ rev: s, exact: true });
    var W = state.W;
    return revisionsBetween(s).then(function (list) {
      if (list.length <= 1) return { rev: s, exact: true };
      var lo = 0,
        hi = list.length - 1,
        steps = 0,
        total = Math.ceil(Math.log2(list.length)) + 1;
      if (list[hi].revid !== s.id) hi = list.length; // truncated: s might be beyond the list
      function step() {
        if (lo >= hi) {
          if (lo >= list.length) return { rev: s, exact: false };
          if (list[lo].revid === s.id) return { rev: s, exact: true };
          return revById(list[lo].revid).then(function (r) {
            return { rev: r || s, exact: !!r };
          });
        }
        var mid = (lo + hi) >> 1;
        steps++;
        status('Pinpointing revision… (' + steps + '/' + total + ')');
        return revById(list[mid].revid).then(function (r) {
          var ok = r && present(bigramSet(tokenize(cleanWikitext(r.text))), W, wi);
          if (ok) hi = mid;
          else lo = mid + 1;
          return step();
        });
      }
      return step();
    });
  }

  function openPopup(span) {
    var ri = +span.getAttribute('data-r');
    var r = state.R[ri];
    if (!r || r.wi === -1) {
      status('That word was not found in the wikitext, so it cannot be dated.');
      setTimeout(function () {
        if (state.done) status(null);
      }, 2500);
      return;
    }
    var s = state.origin[r.wi];
    var curHeading = headingBefore(state.container, span);
    status('Pinpointing revision…');
    pinpoint(s, r.wi)
      .then(function (res) {
        return api({ action: 'parse', oldid: res.rev.id, prop: 'text|displaytitle', disableeditsection: 1, disablelimitreport: 1 }).then(function (j) {
          showPopup(res.rev, res.exact, j.parse.text, ri, curHeading);
          status(state.done ? null : 'Refining dates…');
        });
      })
      .catch(function (e) {
        status('Could not load that revision: ' + e.message);
      });
  }

  function showPopup(rev, exact, html, ri, curHeading) {
    closePopup();
    var full = el('div', { class: 'mw-body-content mw-parser-output' });
    full.innerHTML = html;
    var found = locate(full, ri);
    var mark = found ? markTokens(found.tokens, found.center) : null;
    var anchor = mark;
    if (!anchor && curHeading) {
      var want = norm(curHeading.textContent.trim());
      var hs = full.querySelectorAll('h2,h3,h4,h5,h6');
      for (var i = 0; i < hs.length; i++) {
        if (norm(hs[i].textContent.trim()) === want) {
          anchor = hs[i];
          break;
        }
      }
    }
    var section = null;
    if (anchor) {
      section = el('div', { class: 'mw-body-content mw-parser-output' });
      section.appendChild(sectionClone(full, anchor));
    }
    var sectionName = null;
    var h = anchor ? headingBefore(full, anchor) : null;
    if (h) sectionName = h.textContent.replace(/\[edit\]/g, '').trim();

    var showingSection = !!section;
    var body = el('div', { style: 'flex:1;overflow:auto;padding:12px 16px;background:#fff;color:#202122' });
    body.appendChild(showingSection ? section : full);

    var meta = el('div', { style: 'font-size:12px;color:#555' }, [
      (exact ? 'Added in revision ' : 'Added by about revision ') + rev.id + ' · ' + fmtDateTime(rev.ts) + ' · ' + (rev.user || '?') + (rev.comment ? ' · “' + rev.comment + '”' : '')
    ]);
    var links = el('div', { style: 'font-size:12px;margin-top:2px' }, [
      el('a', { href: indexUrl + '?oldid=' + rev.id, target: '_blank', text: 'Open this revision ↗' }),
      ' · ',
      el('a', { href: indexUrl + '?diff=prev&oldid=' + rev.id, target: '_blank', text: 'Diff ↗' })
    ]);
    var toggle = el('button', {
      text: showingSection ? 'Full page' : 'Section',
      style: 'font:12px sans-serif;padding:2px 8px;border:1px solid #888;border-radius:4px;background:#f4f4f4;cursor:pointer',
      onclick: function () {
        showingSection = !showingSection;
        toggle.textContent = showingSection ? 'Full page' : 'Section';
        body.textContent = '';
        body.appendChild(showingSection && section ? section : full);
        center();
      }
    });
    if (!section) toggle.disabled = true;
    var close = el('button', { text: '✕', title: 'Close (Esc)', style: 'font:16px sans-serif;border:0;background:none;cursor:pointer;padding:0 6px', onclick: closePopup });
    var head = el(
      'div',
      { style: 'display:flex;gap:10px;align-items:flex-start;padding:10px 16px;border-bottom:1px solid #ccc;background:#f8f9fa' },
      [
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:bold;font-size:15px' }, [(sectionName ? '§ ' + sectionName + ' — ' : '') + 'as of ' + fmtDate(rev.ts)]),
          meta,
          links
        ]),
        toggle,
        close
      ]
    );
    var box = el(
      'div',
      {
        class: 'weh-box',
        style:
          'position:fixed;inset:20%;z-index:100002;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5);overflow:hidden;font:14px/1.5 sans-serif',
        onclick: function (e) {
          e.stopPropagation();
        }
      },
      [head, body]
    );
    if (window.innerWidth < 720 || window.innerHeight < 500) box.style.inset = '4%';
    state.popup = el('div', { style: 'position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.45)', onclick: closePopup }, [box]);
    state._overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(state.popup);

    function center() {
      var target = body.querySelector('.weh-mark') || (anchor && anchor.tagName ? body.querySelector(anchor.tagName) : null);
      if (target) target.scrollIntoView({ block: 'center', inline: 'nearest' });
      else body.scrollTop = 0;
    }
    center();
  }

  // --- lifecycle --------------------------------------------------------

  function destroy() {
    closePopup();
    unwrapTokens();
    if (state.style) state.style.remove();
    if (state.legend) state.legend.remove();
    if (state.toast) state.toast.remove();
    state.listeners.forEach(function (l) {
      l[0].removeEventListener(l[1], l[2]);
    });
    if (state.container) state.container.normalize();
    delete window[NS];
  }
  state.destroy = destroy;

  function main() {
    state.container = findContainer();
    if (!state.container) {
      alert('Could not find the article content on this page.');
      delete window[NS];
      return;
    }
    status('Reading article…');
    state.R = domTokens(state.container);
    var RK = state.R.map(function (r) {
      return r.key;
    });

    status('Fetching current and first revisions…');
    Promise.all([revById(revId), revAt(null, null)])
      .then(function (res) {
        var cur = res[0],
          first = res[1];
        if (!cur) throw new Error('could not load the current wikitext');
        if (!first) first = cur;
        state.W = tokenize(cleanWikitext(cur.text));
        state.origin = new Array(state.W.length);
        var wi = align(RK, state.W);
        var used = new Set();
        for (var i = 0; i < wi.length; i++) {
          state.R[i].wi = wi[i];
          if (wi[i] !== -1) used.add(wi[i]);
        }
        state.usedW = Array.from(used).sort(function (a, b) {
          return a - b;
        });
        state.t0 = first.ts;
        state.tN = cur.ts;
        var K = CFG.samples;
        var tasks = [];
        for (var k = 1; k < K; k++) {
          (function (k) {
            tasks.push(function () {
              return revAt(state.t0 + ((state.tN - state.t0) * k) / K, state.tN);
            });
          })(k);
        }
        return pool(tasks, CFG.concurrency, function (n) {
          status('Sampling revision history… (' + n + '/' + tasks.length + ')');
        }).then(function (list) {
          var byId = new Map();
          [first].concat(list, [cur]).forEach(function (s) {
            if (s && !byId.has(s.id)) byId.set(s.id, s);
          });
          state.samples = Array.from(byId.values()).sort(function (a, b) {
            return a.ts - b.ts || a.id - b.id;
          });
          relink();
        });
      })
      .then(function () {
        status('Dating words…');
        attributeAll();
        wrapTokens();
        makeLegend();
        paint();
        listen(state.container, 'mouseover', onOver);
        listen(state.container, 'click', onClick);
        listen(state.container, 'mousedown', onDown);
        listen(document, 'keydown', onKey);
        return refine(CFG.refine);
      })
      .then(function () {
        state.done = true;
        updateLegend();
        status(null);
      })
      .catch(function (e) {
        console.error(e);
        status('Edit history colors failed: ' + e.message);
      });
  }

  main();
})();
