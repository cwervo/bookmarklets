// ==Bookmarklet==
// @name Watson Library
// @author Andres Cuervo
// ==/Bookmarklet==
//
// A phone-first search + request ("checkout") experience layered on top of
// Watsonline (https://library.metmuseum.org), the Sierra WebPAC catalog of the
// Met's Thomas J. Watson Library.
//
// How it works: this script runs *on* library.metmuseum.org, so it can fetch
// the catalog's own HTML (same origin) and re-render it as a modern UI. The
// parts that need a signed-in session (placing a request, your account) are
// the real Watsonline pages, shown inside a sheet with mobile-friendly CSS.
//
// Usable as a Safari bookmarklet or pasted into an iOS Shortcuts
// "Run JavaScript on Web Page" action (it calls completion() when ready).
(function () {
  'use strict';

  var HOST = 'library.metmuseum.org';
  var APP_ID = 'watson-app-host';
  var STORE = { bag: 'watson.bag', recent: 'watson.recent', requested: 'watson.requested' };
  var COVER_API = 'https://covers.openlibrary.org/b/isbn/';

  function finish() {
    // iOS Shortcuts "Run JavaScript on Web Page" requires completion() to be called.
    try { if (typeof completion === 'function') completion(); } catch (e) { /* not in Shortcuts */ }
  }

  if (location.hostname !== HOST) {
    // Not on Watsonline yet: go there. Run the bookmarklet/shortcut again once it loads.
    location.href = 'https://' + HOST + '/';
    finish();
    return;
  }

  var previous = document.getElementById(APP_ID);
  if (previous) previous.remove();

  // ---------------------------------------------------------------------------
  // Catalog plumbing (Sierra WebPAC URL conventions)
  // ---------------------------------------------------------------------------

  var scopeMatch = location.pathname.match(/~S(\d+)/);
  var SCOPE = scopeMatch ? scopeMatch[1] : '1';
  var TILDE = '~S' + SCOPE;
  var ORIGIN = location.origin;

  var FIELDS = [
    { key: 'X', label: 'Everything', prefix: '' },
    { key: 't', label: 'Title', prefix: 't:' },
    { key: 'a', label: 'Author', prefix: 'a:' },
    { key: 'd', label: 'Subject', prefix: 'd:' }
  ];
  var SORTS = [
    { key: 'R', label: 'Relevance' },
    { key: 'D', label: 'Date' }
  ];

  function searchUrl(q, field, sort) {
    var arg = field.prefix ? field.prefix + '(' + q + ')' : q;
    return ORIGIN + '/search' + TILDE + '/?searchtype=X&searcharg=' + encodeURIComponent(arg) +
      '&searchscope=' + SCOPE + '&SORT=' + sort + '&extended=0&SUBMIT=Search&searchlimits=';
  }
  function recordUrl(id) { return ORIGIN + '/record=' + id + TILDE; }
  function requestUrlFor(id) {
    return ORIGIN + '/search' + TILDE + '?/.' + id + '/.' + id + '/1,1,1,B/request~' + id;
  }
  var ACCOUNT_URL = ORIGIN + '/patroninfo' + TILDE + '/';
  var LOGOUT_URL = ORIGIN + '/logout' + TILDE + '?';

  function absolutize(href) {
    try { return new URL(href, location.href).href; } catch (e) { return href; }
  }

  function clean(s) { return (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }

  // textContent, but with <br> and block elements turned into line breaks.
  function textLines(node) {
    var out = '';
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { out += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        var tag = c.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
        if (tag === 'BR') { out += '\n'; continue; }
        var block = /^(DIV|P|TR|LI|TABLE|UL|OL|DD|DT|H[1-6])$/.test(tag);
        if (block) out += '\n';
        walk(c);
        if (block) out += '\n';
      }
    })(node);
    return out;
  }
  function lines(node) {
    return textLines(node).split('\n').map(clean).filter(Boolean);
  }

  async function fetchDoc(url) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    try {
      var res = await fetch(url, { credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error('Watsonline answered with status ' + res.status);
      var html = await res.text();
      return { doc: new DOMParser().parseFromString(html, 'text/html'), url: res.url || url };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Sierra brief-citation result rows all link to /record=bNNNNNNN. We group
  // anchors by record id and grow each anchor's container upward until it
  // would swallow a different record, which survives template differences.
  function recordContainer(anchor, id, root) {
    var el = anchor;
    while (el.parentElement && el.parentElement !== root && el.parentElement !== root.body) {
      var parent = el.parentElement;
      var links = parent.querySelectorAll('a[href*="record=b"]');
      var foreign = false;
      for (var i = 0; i < links.length; i++) {
        if ((links[i].getAttribute('href') || '').indexOf('record=' + id) === -1) { foreign = true; break; }
      }
      if (foreign) break;
      el = parent;
    }
    return el;
  }

  // Sierra item statuses are rendered in upper case; matching case-sensitively
  // keeps words like "online" in titles from being mistaken for a status.
  var STATUS_RE = /\b(AVAILABLE|CHECKED OUT|IN LIBRARY|LIB USE ONLY|LIBRARY USE ONLY|IN PROCESS|ON HOLD|ON ORDER|DUE \d\d-\d\d-\d\d|MISSING|LOST|NON-CIRC|NON-CIRCULATING|ONLINE|IN TRANSIT|BEING PAGED|ASK AT DESK|ON RESERVE|STORAGE|OFFSITE)\b/;
  var BIB_RE = /^b\d{5,9}$/;

  function statusKind(s) {
    s = (s || '').toUpperCase();
    if (!s) return '';
    if (/AVAILABLE|IN LIBRARY|ASK AT DESK/.test(s)) return 'ok';
    if (/LIB USE|LIBRARY USE|NON-CIRC|ONLINE|ON RESERVE|STORAGE|OFFSITE/.test(s)) return 'note';
    if (/CHECKED OUT|DUE|IN PROCESS|ON HOLD|ON ORDER|MISSING|LOST|IN TRANSIT|BEING PAGED/.test(s)) return 'busy';
    return '';
  }

  function isHoldingsTable(table) {
    if (table.querySelector('tr.bibItemsEntry')) return true;
    var head = table.querySelector('tr');
    var t = head ? clean(head.textContent).toUpperCase() : '';
    return /STATUS/.test(t) && /LOCATION|CALL/.test(t);
  }

  // Rows of (Location, Call No., [Vol/Copy], Status)
  function holdingsFromTable(table) {
    var out = [];
    if (!isHoldingsTable(table)) return out;
    var rows = table.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll('td');
      if (cells.length < 2) continue;
      var vals = [];
      for (var j = 0; j < cells.length; j++) vals.push(clean(textLines(cells[j])));
      var status = '';
      for (var k = vals.length - 1; k >= 0; k--) {
        if (vals[k].length <= 40 && STATUS_RE.test(vals[k])) { status = vals[k]; vals.splice(k, 1); break; }
      }
      if (!status && !rows[i].classList.contains('bibItemsEntry')) continue;
      out.push({ location: vals[0] || '', call: vals[1] || '', extra: vals.slice(2).join(' · '), status: status });
    }
    return out;
  }

  // Find the bib record id (b1234567) for a chunk of results markup. Sierra
  // exposes it via the "save" checkbox, record= links, request links or the
  // /.b1234567/ segment of its command URLs, depending on the template.
  function bibIdIn(box) {
    var cb = box.querySelector('input[name="save"]');
    if (cb && BIB_RE.test(cb.value)) return cb.value;
    var m = (box.innerHTML || '').match(/record=(b\d{5,9})/) || (box.innerHTML || '').match(/request~(b\d{5,9})/) || (box.innerHTML || '').match(/\/\.(b\d{5,9})\//);
    return m ? m[1] : '';
  }

  function pickTitleAnchor(box) {
    // Selector lists return document order, so check them in priority order.
    var selectors = ['.briefcitTitle a', '.browseEntryData a', 'a[href*="frameset"]', 'a[href*="record=b"]', 'a[href*="/search"]'];
    for (var s = 0; s < selectors.length; s++) {
      var candidates = box.querySelectorAll(selectors[s]);
      for (var i = 0; i < candidates.length; i++) {
        var a = candidates[i];
        if (clean(a.textContent) && !a.querySelector('img') && !/request~b/.test(a.getAttribute('href') || '')) return a;
      }
    }
    return null;
  }

  function fillFromBox(r, box) {
    var detailEl = box.querySelector('.briefcitDetail') || box.querySelector('.browseEntryData');
    var titleEl = box.querySelector('.briefcitTitle');
    if (titleEl && clean(titleEl.textContent)) r.title = clean(titleEl.textContent);
    if (detailEl) {
      var dl = lines(detailEl).filter(function (l) { return l !== r.title; });
      r.author = dl[0] || '';
      r.detail = dl.slice(1).join(' · ');
    }
    var statusEl = box.querySelector('.briefcitStatus');
    // The status class may sit on the table itself or on a wrapper; try the
    // innermost tables first so a layout table never wins over the real one.
    var tables = Array.prototype.slice.call(box.querySelectorAll('table'));
    if (statusEl && statusEl.tagName === 'TABLE') tables.unshift(statusEl);
    tables.sort(function (a, b) { return (a.querySelector('table') ? 1 : 0) - (b.querySelector('table') ? 1 : 0); });
    for (var t = 0; t < tables.length && !r.holdings.length; t++) r.holdings = holdingsFromTable(tables[t]);
    if (!r.holdings.length) {
      var st = clean(textLines(statusEl || box)).match(STATUS_RE);
      if (st) r.holdings.push({ location: '', call: '', extra: '', status: st[0] });
    }
    if (!detailEl) {
      // Fallback: everything in the box that isn't the title, a status line or a button label.
      var rest = lines(box).filter(function (l) { return l !== r.title && !STATUS_RE.test(l) && !/^(request|add to|save|export|location|call no|status)\b/i.test(l) && l.length > 2; });
      r.author = rest[0] || '';
      r.detail = rest.slice(1, 4).join(' · ');
    }
    var media = box.querySelector('.briefcitMedia, .briefcitFormat');
    if (media && clean(textLines(media))) r.format = clean(textLines(media));
    var img = box.querySelector('img[src*="syndetics"], img[src*="cover"], img[src*="isbn"], img[src*="openlibrary"]');
    if (img) r.cover = absolutize(img.getAttribute('src'));
    var req = box.querySelector('a[href*="request~b"]');
    if (req) r.requestUrl = absolutize(req.getAttribute('href'));
    else if (BIB_RE.test(r.id)) r.requestUrl = requestUrlFor(r.id);
    return r;
  }

  function parseResults(doc, baseUrl) {
    var results = [];
    var seen = {};
    function add(r) {
      if (!r.title && !r.id) return;
      var key = r.id || r.url;
      if (seen[key]) return;
      seen[key] = true;
      results.push(r);
    }

    var rows = doc.querySelectorAll('tr.briefCitRow, tr.browseEntry');
    if (rows.length) {
      for (var i = 0; i < rows.length; i++) {
        var box = rows[i];
        var id = bibIdIn(box);
        var ta = pickTitleAnchor(box);
        var url = BIB_RE.test(id) ? recordUrl(id) : (ta ? absolutize(ta.getAttribute('href')) : '');
        if (!url) continue;
        add(fillFromBox({ id: id || url, title: ta ? clean(ta.textContent) : '', url: url, author: '', detail: '', holdings: [], cover: '', requestUrl: '' }, box));
      }
    } else {
      // Unknown template: group record links by bib id and grow each link's
      // container until it would swallow a different record.
      var anchors = doc.querySelectorAll('a[href*="record=b"]');
      var byId = {};
      for (var k = 0; k < anchors.length; k++) {
        var a = anchors[k];
        var m = (a.getAttribute('href') || '').match(/record=(b\d{5,9})/);
        if (!m) continue;
        var text = clean(a.textContent);
        if (byId[m[1]]) { if (!byId[m[1]].title && text) byId[m[1]].title = text; continue; }
        var r = fillFromBox({ id: m[1], title: text, url: recordUrl(m[1]), author: '', detail: '', holdings: [], cover: '', requestUrl: '' }, recordContainer(a, m[1], doc));
        byId[m[1]] = r;
        add(r);
      }
    }

    var bodyText = clean(doc.body ? doc.body.textContent : '');
    var totalMatch = bodyText.match(/(\d[\d,]*)\s+results?\s+found/i) || bodyText.match(/of\s+(\d[\d,]*)\s+(?:results|entries|titles)/i);
    var total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : null;
    if (!results.length && /no (matches|entries|results) found|0 results found|no hits/i.test(bodyText)) total = 0;

    var nextUrl = null;
    var navLinks = doc.querySelectorAll('a[href]');
    for (var n = 0; n < navLinks.length; n++) {
      var link = navLinks[n];
      var label = clean(link.textContent) || clean(link.getAttribute('title')) || '';
      var imgAlt = link.querySelector('img') ? clean(link.querySelector('img').getAttribute('alt')) : '';
      if (/^next\b/i.test(label) || /^next\b/i.test(imgAlt) || link.rel === 'next') {
        nextUrl = new URL(link.getAttribute('href'), baseUrl || location.href).href;
        break;
      }
    }
    return { results: results, total: total, nextUrl: nextUrl };
  }

  function looksLikeRecord(doc, url) {
    return /record=b\d+/.test(url || '') ||
      !!doc.querySelector('.bibInfoEntry, .bibItems, .bibInfoLabel, a[href*="marksave"], a[href*="request~b"]');
  }

  function parseRecord(doc, url) {
    var html = doc.body ? doc.body.innerHTML : '';
    var idm = (url || '').match(/record=b(\d{5,9})/) || html.match(/request~b(\d{5,9})/) || html.match(/\/\.b(\d{5,9})\//) || html.match(/marksave[^"']*b(\d{5,9})/);
    var id = idm ? 'b' + idm[1] : '';
    var r = { id: id, title: '', author: '', detail: '', holdings: [], cover: '', requestUrl: '', url: id ? recordUrl(id) : url, fields: [], subjects: [], links: [] };

    var rows = doc.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      var l = rows[i].querySelector('.bibInfoLabel');
      var d = rows[i].querySelector('.bibInfoData');
      if (!l || !d) continue;
      var label = clean(l.textContent).replace(/:$/, '');
      var vals = lines(d);
      if (!label || !vals.length) continue;
      r.fields.push({ label: label, values: vals });
      var ext = d.querySelectorAll('a[href^="http"]');
      for (var e = 0; e < ext.length; e++) {
        if (ext[e].hostname && ext[e].hostname !== HOST) r.links.push({ text: clean(ext[e].textContent) || ext[e].hostname, href: ext[e].href });
      }
    }
    r.fields.forEach(function (f) {
      var L = f.label.toLowerCase();
      if (!r.title && /^(title|uniform title)/.test(L)) r.title = f.values[0];
      else if (!r.author && /^(author|creator|personal|corporate|main entry)/.test(L)) r.author = f.values[0];
      else if (!r.detail && /^(publi|imprint|published)/.test(L)) r.detail = f.values.join(' ');
      else if (/^subject/.test(L)) r.subjects = r.subjects.concat(f.values);
      else if (/isbn/.test(L) && !r.cover) {
        var isbn = (f.values.join(' ').match(/\b(97[89]\d{10}|\d{9}[\dXx])\b/) || [])[0];
        if (isbn) r.cover = COVER_API + isbn + '-M.jpg?default=false';
      }
    });
    if (!r.title) {
      var h = doc.querySelector('.bibTitle, h1, h2');
      r.title = h ? clean(h.textContent) : (id || 'Untitled record');
    }
    var items = doc.querySelectorAll('tr.bibItemsEntry');
    if (items.length) r.holdings = holdingsFromTable(items[0].closest('table') || doc.body);
    if (!r.holdings.length) {
      var tables = doc.querySelectorAll('table');
      for (var t = 0; t < tables.length && !r.holdings.length; t++) {
        var head = clean(tables[t].textContent).toUpperCase();
        if (head.indexOf('STATUS') !== -1 && (head.indexOf('LOCATION') !== -1 || head.indexOf('CALL') !== -1)) r.holdings = holdingsFromTable(tables[t]);
      }
    }
    var req = doc.querySelector('a[href*="request~b"], form[action*="request~b"]');
    if (req) r.requestUrl = absolutize(req.getAttribute('href') || req.getAttribute('action'));
    else if (id) r.requestUrl = requestUrlFor(id);
    r.requestFound = !!req;
    return r;
  }

  // ---------------------------------------------------------------------------
  // Persistence (Safari localStorage on library.metmuseum.org)
  // ---------------------------------------------------------------------------

  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  var state = {
    tab: 'search',
    q: '',
    field: FIELDS[0],
    sort: SORTS[0].key,
    results: [],
    total: null,
    nextUrl: null,
    loading: false,
    loadingMore: false,
    error: null,
    searched: false,
    bag: load(STORE.bag, []),
    requested: load(STORE.requested, []),
    recent: load(STORE.recent, [])
  };

  function inBag(id) { return state.bag.some(function (b) { return b.id === id; }); }
  function toggleBag(item) {
    if (inBag(item.id)) {
      state.bag = state.bag.filter(function (b) { return b.id !== item.id; });
      toast('Removed from bag');
    } else {
      state.bag.push({ id: item.id, title: item.title, author: item.author, detail: item.detail, url: item.url, requestUrl: item.requestUrl || (BIB_RE.test(item.id) ? requestUrlFor(item.id) : ''), cover: item.cover });
      toast('Added to bag');
    }
    save(STORE.bag, state.bag);
    render();
  }
  function markRequested(item) {
    state.bag = state.bag.filter(function (b) { return b.id !== item.id; });
    state.requested = [{ id: item.id, title: item.title, author: item.author, url: item.url, at: Date.now() }]
      .concat(state.requested.filter(function (x) { return x.id !== item.id; })).slice(0, 30);
    save(STORE.bag, state.bag);
    save(STORE.requested, state.requested);
  }
  function remember(q, fieldKey) {
    state.recent = [{ q: q, field: fieldKey }].concat(state.recent.filter(function (r) { return !(r.q === q && r.field === fieldKey); })).slice(0, 8);
    save(STORE.recent, state.recent);
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  var CSS = '\
:host{all:initial;position:fixed;inset:0;z-index:2147483647;display:block}\
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}\
.app{--red:#e4002b;--bg:#f6f5f2;--card:#fff;--fg:#141414;--muted:#6b6b6b;--line:#e3e1dc;--chip:#ecebe7;--ok:#1a7f4b;--busy:#b7791f;--note:#5b6b8a;--sheet:#fff;\
 position:absolute;inset:0;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);\
 font:16px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;overflow:hidden;\
 padding-top:env(safe-area-inset-top);}\
@media(prefers-color-scheme:dark){.app{--bg:#111;--card:#1c1c1e;--fg:#f2f2f2;--muted:#a0a0a0;--line:#2c2c2e;--chip:#2a2a2c;--sheet:#161616}}\
.serif{font-family:"New York","Iowan Old Style","Palatino","Georgia",serif}\
button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer}\
a{color:inherit}\
.hdr{display:flex;align-items:center;gap:12px;padding:10px 16px 6px}\
.hdr .brand{flex:1;min-width:0}\
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--red)}\
.title{font-size:22px;font-weight:700;line-height:1.15;margin:0}\
.iconbtn{width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--chip);font-size:18px;flex:none}\
.iconbtn:active{opacity:.7}\
.searchbar{display:flex;gap:8px;padding:4px 16px 8px;align-items:center}\
.searchbar .box{flex:1;min-width:0;display:flex;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:0 12px;height:46px;box-shadow:0 1px 2px rgba(0,0,0,.04)}\
.searchbar input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:17px;color:inherit;height:100%;-webkit-appearance:none;appearance:none}\
.searchbar input::-webkit-search-cancel-button{display:none}\
.searchbar .go{flex:none;background:var(--red);color:#fff;border-radius:12px;height:46px;padding:0 14px;font-weight:600}\
.searchbar .clear{color:var(--muted);font-size:18px;padding:0 4px}\
.seg{display:flex;gap:6px;padding:0 16px 10px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}\
.seg::-webkit-scrollbar{display:none}\
.seg button{white-space:nowrap;padding:6px 12px;border-radius:999px;background:var(--chip);font-size:14px;font-weight:500}\
.seg button.on{background:var(--fg);color:var(--bg)}\
main{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 16px 24px}\
.meta{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:13px;padding:2px 0 10px}\
.meta .sorts button{margin-left:10px;font-weight:600;color:var(--muted)}\
.meta .sorts button.on{color:var(--fg);text-decoration:underline;text-underline-offset:3px}\
.card{display:flex;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px;margin-bottom:10px;text-align:left;width:100%;align-items:flex-start}\
.card:active{transform:scale(.995)}\
.cover{width:52px;height:72px;border-radius:6px;background:var(--chip);flex:none;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:var(--muted)}\
.cover img{width:100%;height:100%;object-fit:cover;display:block}\
.card .body{flex:1;min-width:0}\
.card h3{margin:0 0 2px;font-size:17px;line-height:1.25;font-weight:600;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}\
.sub{color:var(--muted);font-size:14px;margin:0 0 6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\
.pills{display:flex;flex-wrap:wrap;gap:6px;align-items:center}\
.pill{font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;background:var(--chip);color:var(--muted);letter-spacing:.01em}\
.pill.ok{background:rgba(26,127,75,.12);color:var(--ok)}\
.pill.busy{background:rgba(183,121,31,.14);color:var(--busy)}\
.pill.note{background:rgba(91,107,138,.14);color:var(--note)}\
.pill.call{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:500}\
.bagbtn{width:36px;height:36px;border-radius:50%;background:var(--chip);flex:none;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;align-self:center}\
.bagbtn.on{background:var(--red);color:#fff}\
.empty{padding:36px 8px;text-align:center;color:var(--muted)}\
.empty h2{font-size:26px;color:var(--fg);margin:0 0 8px;line-height:1.2}\
.empty p{margin:0 auto 18px;max-width:30em}\
.chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}\
.chips button{padding:8px 14px;border-radius:999px;background:var(--card);border:1px solid var(--line);font-size:14px}\
.skeleton{height:96px;border-radius:16px;background:linear-gradient(90deg,var(--chip),var(--card),var(--chip));background-size:200% 100%;animation:sh 1.2s infinite;margin-bottom:10px}\
@keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}\
.more{display:block;width:100%;padding:14px;border-radius:14px;background:var(--card);border:1px solid var(--line);font-weight:600;margin:6px 0 20px}\
.err{background:rgba(228,0,43,.08);border:1px solid rgba(228,0,43,.25);color:var(--red);border-radius:14px;padding:14px;margin:8px 0}\
.err button{font-weight:700;text-decoration:underline;margin-left:8px}\
.tabbar{display:flex;border-top:1px solid var(--line);background:var(--card);padding:6px 8px calc(6px + env(safe-area-inset-bottom))}\
.tabbar button{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:11px;font-weight:600;color:var(--muted);padding:6px 0;position:relative}\
.tabbar button.on{color:var(--red)}\
.tabbar .ico{font-size:22px;line-height:1}\
.badge{position:absolute;top:2px;left:calc(50% + 8px);min-width:18px;height:18px;border-radius:9px;background:var(--red);color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0 5px}\
.section{font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px}\
.primary{display:block;width:100%;padding:15px;border-radius:14px;background:var(--red);color:#fff;font-weight:700;font-size:17px;text-align:center}\
.primary:disabled{opacity:.5}\
.secondary{display:block;width:100%;padding:13px;border-radius:14px;background:var(--chip);font-weight:600;text-align:center;margin-top:8px}\
.row{display:flex;gap:12px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:8px}\
.row .body{flex:1;min-width:0}\
.row h4{margin:0;font-size:16px;font-weight:600;line-height:1.3}\
.row .x{color:var(--muted);font-size:20px;padding:6px}\
.sheet{position:absolute;inset:0;background:var(--sheet);display:flex;flex-direction:column;transform:translateY(100%);transition:transform .28s cubic-bezier(.2,.8,.2,1);padding-top:env(safe-area-inset-top);will-change:transform}\
.sheet.open{transform:none}\
.sheet-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--line)}\
.sheet-head .t{flex:1;min-width:0;font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\
.sheet-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 16px calc(24px + env(safe-area-inset-bottom))}\
.sheet-body.frame{padding:0;display:flex;flex-direction:column}\
.banner{padding:12px 16px;font-size:14px;line-height:1.4;background:var(--chip);border-bottom:1px solid var(--line)}\
.banner.ok{background:rgba(26,127,75,.12);color:var(--ok)}\
.banner.warn{background:rgba(183,121,31,.14);color:var(--busy)}\
iframe{flex:1;width:100%;border:0;background:#fff}\
.detail h1{font-size:24px;line-height:1.2;margin:0 0 6px;font-weight:700}\
.detail .by{font-size:16px;color:var(--muted);margin:0 0 14px}\
.detail .hero{display:flex;gap:14px;align-items:flex-start;margin-bottom:16px}\
.detail .hero .cover{width:84px;height:118px;font-size:30px}\
.hold{display:flex;flex-direction:column;gap:4px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:8px;font-size:14px}\
.hold b{font-weight:600}\
dl{margin:0}\
dt{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-top:12px}\
dd{margin:2px 0 0;font-size:15px;line-height:1.45;overflow-wrap:anywhere}\
.linklist a{display:block;padding:12px;border-radius:12px;background:var(--card);border:1px solid var(--line);margin-bottom:8px;text-decoration:none;font-weight:600}\
.stepper{font-size:13px;color:var(--muted)}\
.toast{position:absolute;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translate(-50%,20px);background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:999px;font-size:14px;font-weight:600;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap}\
.toast.show{opacity:1;transform:translate(-50%,0)}\
.hint{font-size:13px;color:var(--muted);text-align:center;margin:14px 0 0}\
';

  var FRAME_CSS = '\
html,body{max-width:100%!important;overflow-x:hidden!important}\
body{margin:0!important;padding:12px 14px 40px!important;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,sans-serif!important;font-size:16px!important;line-height:1.45!important;background:#fff!important;color:#111!important}\
table{max-width:100%!important}\
img{max-width:100%!important;height:auto!important}\
input[type=text],input[type=password],input[type=number],input[type=tel],input:not([type]),select,textarea{font-size:16px!important;padding:10px 12px!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;border:1px solid #bdbdbd!important;border-radius:10px!important;margin:4px 0 12px!important;background:#fff!important;-webkit-appearance:none!important}\
input[type=submit],input[type=button],button{font-size:16px!important;font-weight:600!important;padding:12px 18px!important;border-radius:12px!important;background:#e4002b!important;color:#fff!important;border:0!important;-webkit-appearance:none!important;margin:6px 0!important}\
a{color:#e4002b!important}\
#topnav,.topnav,#navbar,.navbar,#banner,#pageBanner,#leftbar,#rightbar,#sidebar,#footer,.footer,#botlogo,#toplogo{display:none!important}\
';

  // Tiny DOM helper: el('div.card', {onclick: fn}, 'text', childEl, ...)
  function el(spec, props) {
    var parts = spec.split('.');
    var node = document.createElement(parts[0] || 'div');
    if (parts.length > 1) node.className = parts.slice(1).join(' ');
    var kids = Array.prototype.slice.call(arguments, 2);
    if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k in node && k !== 'list') { try { node[k] = v; } catch (e) { node.setAttribute(k, v); } }
        else node.setAttribute(k, v);
      });
    } else if (props != null) {
      kids.unshift(props);
    }
    (function append(list) {
      list.forEach(function (k) {
        if (k == null || k === false) return;
        if (Array.isArray(k)) return append(k);
        node.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
      });
    })(kids);
    return node;
  }

  var host = el('div', { id: APP_ID });
  var root = host.attachShadow({ mode: 'open' });
  root.appendChild(el('style', CSS));
  var app = el('div.app');
  root.appendChild(app);

  var headerEl = el('header.hdr');
  var searchEl = el('div');
  var mainEl = el('main');
  var tabbarEl = el('nav.tabbar');
  var sheetEl = el('div.sheet');
  var toastEl = el('div.toast');
  app.appendChild(headerEl); app.appendChild(searchEl); app.appendChild(mainEl); app.appendChild(tabbarEl); app.appendChild(sheetEl); app.appendChild(toastEl);

  var savedOverflow = [document.documentElement.style.overflow, document.body.style.overflow];
  function mount() {
    var vp = document.querySelector('meta[name="viewport"]');
    if (!vp) { vp = document.createElement('meta'); vp.name = 'viewport'; document.head.appendChild(vp); }
    vp.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.appendChild(host);
    document.addEventListener('keydown', onKey);
  }
  function unmount() {
    document.removeEventListener('keydown', onKey);
    document.documentElement.style.overflow = savedOverflow[0];
    document.body.style.overflow = savedOverflow[1];
    host.remove();
  }
  function onKey(e) { if (e.key === 'Escape') { if (sheetEl.classList.contains('open')) closeSheet(); else unmount(); } }

  var toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1600);
  }

  function coverEl(item, big) {
    var box = el('div.cover' + (big ? '.big' : ''));
    if (item.cover) {
      var img = el('img', { src: item.cover, alt: '', loading: 'lazy' });
      img.addEventListener('error', function () { img.remove(); box.textContent = monogram(item.title); });
      box.appendChild(img);
    } else {
      box.textContent = monogram(item.title);
    }
    return box;
  }
  function monogram(title) {
    var m = (title || '').replace(/^(the|a|an|le|la|les|der|die|das|el|los|las)\s+/i, '').match(/[A-Za-z0-9]/);
    return m ? m[0].toUpperCase() : '·';
  }

  function holdingPills(item) {
    var pills = el('div.pills');
    var h = item.holdings[0];
    if (!h) return pills;
    if (h.status) pills.appendChild(el('span.pill.' + statusKind(h.status), h.status));
    if (h.location) pills.appendChild(el('span.pill', h.location));
    if (h.call) pills.appendChild(el('span.pill.call', h.call));
    if (item.holdings.length > 1) pills.appendChild(el('span.pill', '+' + (item.holdings.length - 1) + ' more'));
    return pills;
  }

  // ---- header + search box -------------------------------------------------

  function renderHeader() {
    headerEl.innerHTML = '';
    headerEl.appendChild(el('div.brand',
      el('div.eyebrow', 'The Met'),
      el('h1.title.serif', state.tab === 'bag' ? 'Your bag' : state.tab === 'account' ? 'My account' : 'Watson Library')));
    headerEl.appendChild(el('button.iconbtn', { onclick: unmount, 'aria-label': 'Close' }, '✕'));
  }

  var inputEl;
  function renderSearchBox() {
    searchEl.innerHTML = '';
    if (state.tab !== 'search') return;
    inputEl = el('input', {
      type: 'search', placeholder: 'Search books, catalogs, journals…', value: state.q,
      enterkeyhint: 'search', autocapitalize: 'none', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
      oninput: function () { state.q = inputEl.value; clearBtn.style.visibility = state.q ? 'visible' : 'hidden'; }
    });
    var clearBtn = el('button.clear', { type: 'button', 'aria-label': 'Clear', onclick: function () { state.q = ''; inputEl.value = ''; inputEl.focus(); clearBtn.style.visibility = 'hidden'; } }, '⨂');
    clearBtn.style.visibility = state.q ? 'visible' : 'hidden';
    var form = el('form.searchbar', { onsubmit: function (e) { e.preventDefault(); inputEl.blur(); runSearch(); } },
      el('div.box', el('span', { style: 'color:var(--muted);margin-right:8px' }, '🔍'), inputEl, clearBtn),
      el('button.go', { type: 'submit' }, 'Search'));
    searchEl.appendChild(form);
    searchEl.appendChild(el('div.seg', FIELDS.map(function (f) {
      return el('button' + (state.field.key === f.key ? '.on' : ''), { type: 'button', onclick: function () { state.field = f; renderSearchBox(); if (state.searched && state.q) runSearch(); } }, f.label);
    })));
  }

  // ---- search results -------------------------------------------------------

  var searchSeq = 0;
  async function runSearch() {
    var q = clean(state.q);
    if (!q) return;
    var seq = ++searchSeq;
    state.searched = true; state.loading = true; state.error = null; state.results = []; state.total = null; state.nextUrl = null;
    remember(q, state.field.key);
    render();
    try {
      var page = await fetchDoc(searchUrl(q, state.field, state.sort));
      if (seq !== searchSeq) return;
      var parsed = parseResults(page.doc, page.url);
      if (!parsed.results.length && looksLikeRecord(page.doc, page.url)) {
        // Sierra jumps straight to the record when a search has exactly one hit.
        var rec = parseRecord(page.doc, page.url);
        parsed = { results: [rec], total: 1, nextUrl: null };
      }
      state.results = parsed.results; state.total = parsed.total; state.nextUrl = parsed.nextUrl;
      state.lastUrl = page.url;
    } catch (e) {
      if (seq !== searchSeq) return;
      state.error = e && e.name === 'AbortError' ? 'Watsonline took too long to answer.' : ('Couldn’t reach Watsonline. ' + (e && e.message ? e.message : ''));
    }
    state.loading = false;
    render();
  }

  async function loadMore() {
    if (!state.nextUrl || state.loadingMore) return;
    var seq = searchSeq;
    state.loadingMore = true; render();
    try {
      var page = await fetchDoc(state.nextUrl);
      if (seq !== searchSeq) return;
      var parsed = parseResults(page.doc, page.url);
      var seen = {};
      state.results.forEach(function (r) { seen[r.id] = true; });
      parsed.results.forEach(function (r) { if (!seen[r.id]) state.results.push(r); });
      state.nextUrl = parsed.nextUrl && parsed.nextUrl !== state.nextUrl ? parsed.nextUrl : null;
      if (!parsed.results.length) state.nextUrl = null;
    } catch (e) {
      toast('Couldn’t load more');
    }
    state.loadingMore = false; render();
  }

  function resultCard(item) {
    var bagBtn = el('button.bagbtn' + (inBag(item.id) ? '.on' : ''), {
      type: 'button', 'aria-label': inBag(item.id) ? 'Remove from bag' : 'Add to bag',
      onclick: function (e) { e.stopPropagation(); toggleBag(item); }
    }, inBag(item.id) ? '✓' : '+');
    var sub = [item.author, item.detail].filter(Boolean).join(' · ');
    return el('button.card', { type: 'button', onclick: function () { openDetail(item); } },
      coverEl(item),
      el('div.body', el('h3.serif', item.title || 'Untitled'), sub ? el('p.sub', sub) : null, holdingPills(item)),
      bagBtn);
  }

  function renderSearchTab() {
    if (!state.searched) {
      var empty = el('div.empty',
        el('h2.serif', 'Search the Met’s art library'),
        el('p', 'Over a million volumes on art and archaeology. Find something, add it to your bag, then check out to have it paged for your visit to Watson Library.'));
      if (state.recent.length) {
        empty.appendChild(el('div.section', 'Recent'));
        empty.appendChild(el('div.chips', state.recent.map(function (r) {
          var f = FIELDS.filter(function (x) { return x.key === r.field; })[0] || FIELDS[0];
          return el('button', { type: 'button', onclick: function () { state.q = r.q; state.field = f; renderSearchBox(); runSearch(); } }, (f.prefix ? f.label + ': ' : '') + r.q);
        })));
      } else {
        empty.appendChild(el('div.chips', ['Vermeer', 'Japanese prints', 'Costume Institute', 'Islamic calligraphy'].map(function (s) {
          return el('button', { type: 'button', onclick: function () { state.q = s; renderSearchBox(); runSearch(); } }, s);
        })));
      }
      mainEl.appendChild(empty);
      return;
    }
    if (state.loading) {
      mainEl.appendChild(el('div.meta', el('span', 'Searching Watsonline…')));
      for (var i = 0; i < 5; i++) mainEl.appendChild(el('div.skeleton'));
      return;
    }
    if (state.error) {
      mainEl.appendChild(el('div.err', state.error, el('button', { type: 'button', onclick: runSearch }, 'Retry')));
      return;
    }
    var countText = state.total != null ? state.total.toLocaleString() + (state.total === 1 ? ' result' : ' results') : state.results.length + ' shown';
    mainEl.appendChild(el('div.meta', el('span', countText),
      el('span.sorts', SORTS.map(function (s) {
        return el('button' + (state.sort === s.key ? '.on' : ''), { type: 'button', onclick: function () { if (state.sort !== s.key) { state.sort = s.key; runSearch(); } } }, s.label);
      }))));
    if (!state.results.length) {
      mainEl.appendChild(el('div.empty', el('h2.serif', 'Nothing found'),
        el('p', state.total ? 'Watsonline returned results in a layout this app couldn’t read.' : 'Try fewer words, a different spelling, or search Everything instead of a single field.'),
        state.lastUrl ? el('div.linklist', el('a', { href: state.lastUrl, target: '_blank', rel: 'noopener' }, 'Open this search on Watsonline ↗')) : null));
      return;
    }
    state.results.forEach(function (r) { mainEl.appendChild(resultCard(r)); });
    if (state.nextUrl) {
      var more = el('button.more', { type: 'button', onclick: loadMore, disabled: state.loadingMore }, state.loadingMore ? 'Loading…' : 'Load more');
      mainEl.appendChild(more);
      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (entries) { if (entries[0].isIntersecting) { io.disconnect(); loadMore(); } }, { root: mainEl, rootMargin: '400px' });
        io.observe(more);
      }
    }
  }

  // ---- bag ------------------------------------------------------------------

  function renderBagTab() {
    if (!state.bag.length && !state.requested.length) {
      mainEl.appendChild(el('div.empty', el('h2.serif', 'Your bag is empty'),
        el('p', 'Tap + on any result to collect items, then check out to request them all at once.'),
        el('div.chips', el('button', { type: 'button', onclick: function () { setTab('search'); } }, 'Start searching'))));
      return;
    }
    if (state.bag.length) {
      mainEl.appendChild(el('div.section', state.bag.length + (state.bag.length === 1 ? ' item' : ' items')));
      state.bag.forEach(function (b) {
        mainEl.appendChild(el('div.row',
          coverEl(b),
          el('div.body', el('h4.serif', b.title), el('p.sub', [b.author, b.detail].filter(Boolean).join(' · '))),
          el('button.x', { type: 'button', 'aria-label': 'Remove', onclick: function () { toggleBag(b); } }, '✕')));
      });
      mainEl.appendChild(el('button.primary', { type: 'button', onclick: function () { startCheckout(); } }, 'Check out · request ' + state.bag.length + (state.bag.length === 1 ? ' item' : ' items')));
      mainEl.appendChild(el('p.hint', 'Requested books are paged to Watson Library’s reading room for your visit. Nothing leaves the building.'));
    }
    if (state.requested.length) {
      mainEl.appendChild(el('div.section', 'Recently requested'));
      state.requested.forEach(function (r) {
        mainEl.appendChild(el('div.row', el('div.body', el('h4.serif', r.title), el('p.sub', new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (r.author ? ' · ' + r.author : ''))),
          el('a', { href: r.url, target: '_blank', rel: 'noopener', style: 'color:var(--muted);font-size:13px;text-decoration:none' }, 'Record ↗')));
      });
      mainEl.appendChild(el('button.secondary', { type: 'button', onclick: function () { state.requested = []; save(STORE.requested, []); render(); } }, 'Clear history'));
    }
  }

  // ---- account --------------------------------------------------------------

  function renderAccountTab() {
    mainEl.appendChild(el('div.empty', el('h2.serif', 'Your Watsonline account'),
      el('p', 'See what you have checked out, your holds, saved searches and reading history. Sign in with your last name and the last 6 digits of your library barcode.'),
      el('div.chips',
        el('button', { type: 'button', onclick: function () { openFrameSheet('My account', ACCOUNT_URL, { logout: true }); } }, 'Open my account'),
        el('button', { type: 'button', onclick: function () { openFrameSheet('Sign out', LOGOUT_URL, {}); } }, 'Sign out'))));
    mainEl.appendChild(el('p.hint', 'Library cards are issued at the Watson Library desk; visitors 18+ are welcome.'));
  }

  // ---- tabs + render --------------------------------------------------------

  function setTab(tab) { state.tab = tab; mainEl.scrollTop = 0; render(); }

  function renderTabbar() {
    tabbarEl.innerHTML = '';
    [['search', '🔍', 'Search'], ['bag', '👜', 'Bag'], ['account', '👤', 'Account']].forEach(function (t) {
      var b = el('button' + (state.tab === t[0] ? '.on' : ''), { type: 'button', onclick: function () { setTab(t[0]); } }, el('span.ico', t[1]), t[2]);
      if (t[0] === 'bag' && state.bag.length) b.appendChild(el('span.badge', String(state.bag.length)));
      tabbarEl.appendChild(b);
    });
  }

  function render() {
    var scroll = mainEl.scrollTop;
    renderHeader();
    renderSearchBox();
    mainEl.innerHTML = '';
    if (state.tab === 'search') renderSearchTab();
    else if (state.tab === 'bag') renderBagTab();
    else renderAccountTab();
    renderTabbar();
    mainEl.scrollTop = scroll;
  }

  // ---- sheets ---------------------------------------------------------------

  function closeSheet() {
    sheetEl.classList.remove('open');
    setTimeout(function () { if (!sheetEl.classList.contains('open')) sheetEl.innerHTML = ''; }, 300);
    render();
  }
  function openSheet(headChildren, body) {
    sheetEl.innerHTML = '';
    sheetEl.appendChild(el('div.sheet-head', headChildren));
    sheetEl.appendChild(body);
    requestAnimationFrame(function () { sheetEl.classList.add('open'); });
  }

  async function openDetail(item) {
    var body = el('div.sheet-body.detail');
    var bagBtn = el('button.secondary', { type: 'button', onclick: function () { toggleBag(item); bagBtn.textContent = inBag(item.id) ? '✓ In your bag' : '+ Add to bag'; } }, inBag(item.id) ? '✓ In your bag' : '+ Add to bag');
    openSheet([
      el('button.iconbtn', { type: 'button', 'aria-label': 'Back', onclick: closeSheet }, '←'),
      el('div.t', item.title),
      el('a.iconbtn', { href: item.url, target: '_blank', rel: 'noopener', 'aria-label': 'Open on Watsonline', style: 'text-decoration:none' }, '↗')
    ], body);

    function paint(rec, loading) {
      body.innerHTML = '';
      body.appendChild(el('div.hero', coverEl(rec, true), el('div', { style: 'flex:1;min-width:0' },
        el('h1.serif', rec.title), rec.author ? el('p.by', rec.author) : null, rec.detail ? el('p.sub', rec.detail) : null)));
      var canRequest = rec.requestFound !== false || !rec.fields;
      body.appendChild(el('button.primary', { type: 'button', disabled: loading, onclick: function () { startCheckout([rec]); } }, loading ? 'Loading…' : 'Request this item'));
      body.appendChild(bagBtn);
      if (!canRequest) body.appendChild(el('p.hint', 'Watsonline didn’t show a Request button for this record; it may be online-only or non-requestable. You can still try.'));
      body.appendChild(el('div.section', 'Copies'));
      if (loading && !rec.holdings.length) body.appendChild(el('div.skeleton', { style: 'height:56px' }));
      else if (!rec.holdings.length) body.appendChild(el('p.sub', 'No item information found.'));
      rec.holdings.forEach(function (h) {
        body.appendChild(el('div.hold',
          el('div.pills', h.status ? el('span.pill.' + statusKind(h.status), h.status) : null, h.extra ? el('span.pill', h.extra) : null),
          h.location ? el('div', el('b', 'Location '), h.location) : null,
          h.call ? el('div', el('b', 'Call number '), el('span', { style: 'font-family:ui-monospace,Menlo,monospace' }, h.call)) : null));
      });
      if (rec.links && rec.links.length) {
        body.appendChild(el('div.section', 'Online'));
        body.appendChild(el('div.linklist', rec.links.map(function (l) { return el('a', { href: l.href, target: '_blank', rel: 'noopener' }, l.text + ' ↗'); })));
      }
      if (rec.subjects && rec.subjects.length) {
        body.appendChild(el('div.section', 'Subjects'));
        body.appendChild(el('div.pills', rec.subjects.map(function (s) {
          return el('button.pill', { type: 'button', onclick: function () { closeSheet(); state.q = s.split(/\s+--\s+/)[0]; state.field = FIELDS[3]; setTab('search'); renderSearchBox(); runSearch(); } }, s);
        })));
      }
      if (rec.fields && rec.fields.length) {
        var dl = el('dl');
        rec.fields.forEach(function (f) {
          if (/^(subject|title|author)/i.test(f.label)) return;
          dl.appendChild(el('dt', f.label));
          f.values.forEach(function (v) { dl.appendChild(el('dd', v)); });
        });
        body.appendChild(el('div.section', 'Details'));
        body.appendChild(dl);
      }
    }

    paint(item, !item.fields);
    if (item.fields) return;
    try {
      var page = await fetchDoc(item.url);
      var rec = parseRecord(page.doc, page.url);
      ['title', 'author', 'detail', 'cover'].forEach(function (k) { if (!rec[k] && item[k]) rec[k] = item[k]; });
      if (!rec.holdings.length) rec.holdings = item.holdings;
      if (!BIB_RE.test(rec.id)) rec.id = item.id;
      if (!rec.requestUrl) rec.requestUrl = item.requestUrl;
      Object.assign(item, rec);
      paint(item, false);
    } catch (e) {
      paint(item, false);
      body.insertBefore(el('div.err', 'Couldn’t load the full record. ' + (e.message || '')), body.firstChild);
    }
  }

  function tidyFrame(iframe) {
    try {
      var d = iframe.contentDocument;
      if (!d || !d.head) return null;
      if (!d.querySelector('meta[name="viewport"]')) {
        var m = d.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width, initial-scale=1'; d.head.appendChild(m);
      }
      var s = d.createElement('style'); s.textContent = FRAME_CSS; d.head.appendChild(s);
      return d;
    } catch (e) { return null; }
  }

  function frameState(d) {
    var t = clean(d.body ? d.body.textContent : '');
    if (/was successful|successfully (placed|requested|submitted)|request has been (placed|received|submitted)|your request for .* was/i.test(t)) return 'success';
    if (d.querySelector('input[name="code"], input[name="pin"], input[name="password"], input[type="password"], form[action*="cas/login"]')) return 'login';
    if (/not requestable|cannot be requested|can not be requested|no items? (are )?available|unable to (place|process)|already (have|requested|placed)|not eligible|exceeds/i.test(t)) return 'problem';
    return 'form';
  }

  function setBanner(banner, cls, text, url) {
    banner.className = 'banner' + (cls ? ' ' + cls : '');
    banner.innerHTML = '';
    banner.appendChild(document.createTextNode(text + ' '));
    if (url) banner.appendChild(el('a', { href: url, target: '_blank', rel: 'noopener', style: 'font-weight:600;white-space:nowrap' }, 'Open in Watsonline ↗'));
  }

  function openFrameSheet(title, url, opts) {
    var banner = el('div.banner');
    setBanner(banner, '', 'Loading Watsonline…', url);
    var iframe = el('iframe', { src: url, title: title });
    var body = el('div.sheet-body.frame', banner, iframe);
    var head = [el('button.iconbtn', { type: 'button', 'aria-label': 'Close', onclick: closeSheet }, '✕'), el('div.t', title)];
    if (opts && opts.logout) head.push(el('button.iconbtn', { type: 'button', 'aria-label': 'Sign out', title: 'Sign out', onclick: function () { iframe.src = LOGOUT_URL; } }, '⎋'));
    openSheet(head, body);
    iframe.addEventListener('load', function () {
      var d = tidyFrame(iframe);
      if (!d) { setBanner(banner, 'warn', 'Watsonline wouldn’t load inside this sheet.', url); return; }
      var st = frameState(d);
      if (st === 'login') setBanner(banner, '', 'Sign in with your last name and the last 6 digits of your library barcode.', url);
      else if (/logout/.test(iframe.src)) setBanner(banner, 'ok', 'You’re signed out.', '');
      else setBanner(banner, '', 'Your Watsonline account.', url);
    });
  }

  // ---- checkout (request) flow ---------------------------------------------

  function startCheckout(items) {
    var queue = (items || state.bag).slice();
    if (!queue.length) return;
    var index = 0;
    var outcome = {};

    var banner = el('div.banner');
    var iframe = el('iframe', { title: 'Watsonline request' });
    var titleEl = el('div.t');
    var stepEl = el('div.stepper');
    var body = el('div.sheet-body.frame', banner, iframe);
    var nextBtn = el('button.iconbtn', { type: 'button', 'aria-label': 'Skip', title: 'Skip this item', onclick: function () { outcome[queue[index].id] = outcome[queue[index].id] || 'skipped'; advance(); } }, '⏭');
    openSheet([
      el('button.iconbtn', { type: 'button', 'aria-label': 'Close', onclick: closeSheet }, '✕'),
      el('div', { style: 'flex:1;min-width:0' }, titleEl, stepEl),
      nextBtn
    ], body);

    function currentUrl() {
      var item = queue[index];
      // Without a bib id we can't build the request URL; fall back to the
      // record page, which carries Watsonline's own Request button.
      return item.requestUrl || (BIB_RE.test(item.id) ? requestUrlFor(item.id) : item.url);
    }

    function show() {
      var item = queue[index];
      titleEl.textContent = item.title;
      stepEl.textContent = 'Checkout · ' + (index + 1) + ' of ' + queue.length;
      setBanner(banner, '', 'Loading request form…', currentUrl());
      iframe.src = currentUrl();
    }

    function advance() {
      index++;
      if (index < queue.length) { show(); return; }
      summary();
    }

    function summary() {
      var ok = queue.filter(function (q) { return outcome[q.id] === 'success'; });
      var rest = queue.filter(function (q) { return outcome[q.id] !== 'success'; });
      var sb = el('div.sheet-body',
        el('h1.serif', { style: 'font-size:26px;margin:8px 0 6px' }, ok.length ? 'Requested ' + ok.length + (ok.length === 1 ? ' item' : ' items') : 'No requests placed'),
        el('p.sub', ok.length ? 'Watson Library will page these for you. Check the paging schedule for when they’ll be ready in the reading room.' : 'Nothing was confirmed by Watsonline.'));
      if (ok.length) { sb.appendChild(el('div.section', 'Requested')); ok.forEach(function (q) { sb.appendChild(el('div.row', el('div.body', el('h4.serif', q.title)), el('span.pill.ok', '✓'))); }); }
      if (rest.length) { sb.appendChild(el('div.section', 'Still in your bag')); rest.forEach(function (q) { sb.appendChild(el('div.row', el('div.body', el('h4.serif', q.title)), el('span.pill.busy', outcome[q.id] || 'skipped'))); }); }
      sb.appendChild(el('button.primary', { type: 'button', style: 'margin-top:20px', onclick: function () { closeSheet(); setTab('bag'); } }, 'Done'));
      sheetEl.innerHTML = '';
      sheetEl.appendChild(el('div.sheet-head', el('div.t', 'Checkout complete')));
      sheetEl.appendChild(sb);
    }

    iframe.addEventListener('load', function () {
      var item = queue[index];
      if (!item) return;
      var d = tidyFrame(iframe);
      if (!d) { setBanner(banner, 'warn', 'Watsonline wouldn’t load inside this sheet. Request it there, then tap ⏭.', currentUrl()); return; }
      var st = frameState(d);
      if (st === 'success') {
        if (outcome[item.id] !== 'success') {
          outcome[item.id] = 'success';
          markRequested(item);
          setBanner(banner, 'ok', '✓ Requested. ' + (index + 1 < queue.length ? 'Next item in a moment…' : 'Wrapping up…'), '');
          setTimeout(advance, 1400);
        }
      } else if (st === 'login') {
        setBanner(banner, '', 'Sign in to place the request: last name + last 6 digits of your library barcode.', currentUrl());
      } else if (st === 'problem') {
        outcome[item.id] = 'not requestable';
        setBanner(banner, 'warn', 'Watsonline couldn’t take this request. Tap ⏭ to skip it.', currentUrl());
      } else {
        setBanner(banner, '', 'Choose a pickup location if asked, then submit the request.', currentUrl());
      }
    });
    show();
  }

  // ---------------------------------------------------------------------------

  mount();
  render();
  if (!state.searched && inputEl) setTimeout(function () { try { inputEl.focus(); } catch (e) { /* ignore */ } }, 350);
  finish();
})();
