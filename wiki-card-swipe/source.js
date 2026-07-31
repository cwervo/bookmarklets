// ==Bookmarklet==
// @name Wikipedia Card Swipe
// @author Andres Cuervo
// ==/Bookmarklet==
/*
 * Turns a Wikipedia article into a deck of cards, one per section.
 *
 * Swipe up  -> keep the section
 * Swipe L/R -> discard it
 * Tap       -> expand the card and scroll inside it
 *
 * Written to run in two places:
 *   - as a plain bookmarklet (compile with `bookmarklet source.js out.js`)
 *   - as the body of an iOS Shortcuts "Run JavaScript on Web Page" action,
 *     which hands us a global `completion()` we have to call or the shortcut
 *     hangs. We call it as soon as the UI is on screen, not when the deck is
 *     finished -- Safari stays on the page with our overlay alive, and the
 *     shortcut isn't left spinning while you read.
 */

/* ------------------------------------------------------------------ *
 * 0. Guards
 * ------------------------------------------------------------------ */

var DONE = typeof completion === 'function' ? completion : function () {};

if (document.getElementById('wsw-root')) {
  document.getElementById('wsw-root').remove();
  document.documentElement.style.overflow = '';
  DONE();
} else {

// Works on en.wikipedia.org, en.m.wikipedia.org, and most other MediaWiki
// installs, since they all render into .mw-parser-output.
var root =
  document.querySelector('.mw-parser-output') ||
  document.querySelector('#mw-content-text') ||
  document.querySelector('#bodyContent');

if (!root) {
  alert(
    "Couldn't find a MediaWiki article body on " +
      location.host +
      ' — this one only works on Wikipedia-style pages.'
  );
  DONE();
} else {

/* ------------------------------------------------------------------ *
 * 1. Slice the article into sections
 * ------------------------------------------------------------------ */

// Chrome we never want inside a card.
var JUNK = [
  '.mw-editsection', '.navbox', '.navbox-styles', '.vertical-navbox',
  '.metadata', '.mbox-small', '.sistersitebox', '.reflist', '.refbegin',
  '.catlinks', '.printfooter', '.noprint', '.mw-empty-elt', '.ambox',
  '.side-box', '.shortdescription', '.mw-references-wrap', '.hatnote',
  '.mw-kartographer-map', '.mw-jump-link', 'style', 'link', 'script',
  'sup.reference', '.mw-cite-backlink', '.mw-collapsible-toggle',
  // The infobox is a metadata table, not prose -- it otherwise eats the
  // whole lead card. Drop this line if you'd rather keep it.
  '.infobox', '.infobox_v2', 'table.infobox'
].join(',');

// Sections that are link farms rather than prose.
var BORING = /^(references|notes|citations|footnotes|external links|further reading|bibliography|sources|works cited|see also)$/i;

// The mobile skin nests everything in <section> wrappers; desktop doesn't.
// Flattening one level of those gives us the same linear stream either way.
function* stream(node) {
  for (var el of node.children) {
    if (el.tagName === 'SECTION') yield* stream(el);
    else yield el;
  }
}

// Headings come in three flavors depending on skin/vintage:
//   <h2 id="X">                       (old desktop)
//   <div class="mw-heading"><h2>      (current desktop)
//   <h2><span class="mw-headline">    (older mobile)
function headingIn(el) {
  if (el.tagName === 'H2') return el;
  if (el.classList && el.classList.contains('mw-heading')) return el.querySelector('h2');
  return null;
}

function titleOf(h) {
  var span = h.querySelector('.mw-headline');
  return ((span || h).textContent || '').trim();
}

var sections = [];
var current = { title: null, anchor: null, nodes: [] };

for (var el of stream(root)) {
  var h = headingIn(el);
  if (h) {
    sections.push(current);
    current = {
      title: titleOf(h),
      anchor: h.id || (h.querySelector('[id]') || {}).id || null,
      nodes: []
    };
  } else {
    current.nodes.push(el);
  }
}
sections.push(current);

// The first pseudo-section is the lead (everything before the first h2).
if (sections[0]) sections[0].title = sections[0].title || document.title.replace(/ - Wikipedia.*$/, '');

// Build each card's cleaned content + a plaintext version for the clipboard.
var cards = sections
  .filter(function (s) { return s.title && !BORING.test(s.title); })
  .map(function (s) {
    var holder = document.createElement('div');
    s.nodes.forEach(function (n) { holder.appendChild(n.cloneNode(true)); });
    holder.querySelectorAll(JUNK).forEach(function (n) { n.remove(); });
    // Links stay visible but inert: navigating away nukes the whole session.
    holder.querySelectorAll('a').forEach(function (a) { a.removeAttribute('href'); });

    var text = Array.from(holder.querySelectorAll('p, li'))
      .map(function (n) { return n.textContent.replace(/\s+/g, ' ').trim(); })
      .filter(Boolean)
      .join('\n\n');

    return { title: s.title, anchor: s.anchor, html: holder.innerHTML, text: text };
  })
  .filter(function (c) { return c.text.length > 40; });

if (!cards.length) {
  alert('Found the article but no sections with enough prose to make cards.');
  DONE();
} else {

/* ------------------------------------------------------------------ *
 * 2. Chrome
 * ------------------------------------------------------------------ */

var THROW = 90;   // px of travel that commits a swipe
var FLICK = 0.55; // px/ms that commits a swipe regardless of distance
var TAP = 8;      // px of slop still counted as a tap

var ui = document.createElement('div');
ui.id = 'wsw-root';
ui.innerHTML =
  '<style>' +
  '#wsw-root{position:fixed;inset:0;z-index:2147483647;' +
    'font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'background:#12131a;color:#f2f3f7;overscroll-behavior:none;' +
    'padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);' +
    'display:flex;flex-direction:column;touch-action:none;-webkit-user-select:none;user-select:none}' +
  '#wsw-root *{box-sizing:border-box;max-width:100%}' +
  '.wsw-hud{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:14px 18px 8px}' +
  '.wsw-bar{flex:1;height:4px;border-radius:2px;background:#2c2e3a;overflow:hidden}' +
  '.wsw-bar i{display:block;height:100%;background:#6ee7b7;transition:width .3s ease}' +
  '.wsw-count{font-size:13px;color:#9aa0b4;font-variant-numeric:tabular-nums}' +
  '.wsw-x{background:none;border:0;color:#9aa0b4;font-size:22px;line-height:1;padding:0 4px}' +
  '.wsw-stage{position:relative;flex:1;margin:8px 18px 0}' +
  // bottom:30px leaves the gutter the peeking cards show through.
  '.wsw-card{position:absolute;top:0;left:0;right:0;bottom:30px;background:#1c1e29;border-radius:20px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.45);display:flex;flex-direction:column;' +
    'overflow:hidden;will-change:transform;transition:transform .28s cubic-bezier(.22,1,.36,1),opacity .28s}' +
  '.wsw-card.is-drag{transition:none}' +
  // scaleX, not scale: a uniform scale on a full-height card moves the bottom
  // edge up by tens of px, so the card behind never actually peeks out.
  '.wsw-d1{transform:translateY(14px) scaleX(.96)}' +
  '.wsw-d2{transform:translateY(28px) scaleX(.92)}' +
  '.wsw-d1,.wsw-d2{pointer-events:none}' +
  '.wsw-d1 .wsw-hint,.wsw-d2 .wsw-hint{opacity:0}' +
  '.wsw-card.is-open{bottom:0}' +
  '.wsw-gone{transition:transform .32s ease-in,opacity .32s ease-in;opacity:0}' +
  '.wsw-h{flex:0 0 auto;padding:20px 22px 10px;font-size:21px;font-weight:650;letter-spacing:-.01em}' +
  '.wsw-body{flex:1;padding:0 22px 22px;overflow:hidden;position:relative;-webkit-mask-image:linear-gradient(#000 78%,transparent)}' +
  '.wsw-card.is-open .wsw-body{overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;-webkit-mask-image:none}' +
  '.wsw-body p{margin:0 0 .9em}' +
  '.wsw-body a{color:#9ec1ff;text-decoration:none}' +
  '.wsw-body h3,.wsw-body h4{font-size:16px;margin:1.2em 0 .4em;color:#cfd3e4}' +
  '.wsw-body img{height:auto;border-radius:8px}' +
  '.wsw-body .thumb,.wsw-body figure,.wsw-body table{float:none!important;width:auto!important;' +
    'margin:.8em 0!important;display:block;overflow-x:auto;font-size:13px}' +
  '.wsw-body ul,.wsw-body ol{padding-left:1.2em;margin:0 0 .9em}' +
  '.wsw-hint{flex:0 0 auto;padding:0 22px 14px;font-size:12px;color:#6b7185}' +
  // Stamps live on the stage, not on the card: a card-mounted stamp slides
  // off the top of the screen with the very gesture it's meant to confirm.
  '.wsw-stamp{position:absolute;z-index:50;font-size:15px;font-weight:800;letter-spacing:.14em;' +
    'padding:7px 12px;border-radius:8px;border:2.5px solid;opacity:0;pointer-events:none;transition:opacity .12s}' +
  '.wsw-keep{left:50%;margin-left:-42px;top:18px;color:#6ee7b7;border-color:#6ee7b7}' +
  '.wsw-skip{right:22px;top:18px;color:#fb7185;border-color:#fb7185;transform:rotate(12deg)}' +
  '.wsw-acts{flex:0 0 auto;display:flex;justify-content:center;gap:16px;padding:16px 0 20px}' +
  '.wsw-acts button{width:58px;height:58px;border-radius:50%;border:1px solid #333747;' +
    'background:#1c1e29;color:#f2f3f7;font-size:22px;line-height:1;display:grid;place-items:center}' +
  '.wsw-acts button:disabled{opacity:.35}' +
  '#wsw-root.is-done .wsw-yes,#wsw-root.is-done .wsw-no{display:none}' +
  '.wsw-acts .wsw-yes{border-color:#6ee7b7;color:#6ee7b7}' +
  '.wsw-acts .wsw-no{border-color:#fb7185;color:#fb7185}' +
  '.wsw-end{position:absolute;inset:0;background:#1c1e29;border-radius:20px;padding:26px 22px;' +
    'display:flex;flex-direction:column;gap:14px}' +
  '.wsw-end h2{margin:0;font-size:24px}' +
  '.wsw-end pre{flex:1;overflow:auto;white-space:pre-wrap;font:13px/1.5 ui-monospace,Menlo,monospace;' +
    'background:#12131a;border-radius:12px;padding:14px;color:#c9cee0;-webkit-user-select:text;user-select:text;touch-action:pan-y}' +
  '.wsw-end .wsw-row{display:flex;gap:10px}' +
  '.wsw-end button{flex:1;padding:14px;border-radius:12px;border:0;font-size:16px;font-weight:600;' +
    'background:#2c2e3a;color:#f2f3f7}' +
  '.wsw-end .wsw-copy{background:#6ee7b7;color:#0d2b21}' +
  '</style>' +
  '<div class="wsw-hud">' +
    '<span class="wsw-count"></span>' +
    '<span class="wsw-bar"><i style="width:0"></i></span>' +
    '<button class="wsw-x" aria-label="Close">&times;</button>' +
  '</div>' +
  '<div class="wsw-stage">' +
    '<div class="wsw-stamp wsw-keep">KEEP</div>' +
    '<div class="wsw-stamp wsw-skip">SKIP</div>' +
  '</div>' +
  '<div class="wsw-acts">' +
    '<button class="wsw-undo" aria-label="Undo" disabled>&#8630;</button>' +
    '<button class="wsw-no" aria-label="Skip">&times;</button>' +
    '<button class="wsw-yes" aria-label="Keep">&#8593;</button>' +
  '</div>';

document.body.appendChild(ui);
document.documentElement.style.overflow = 'hidden';

var stage = ui.querySelector('.wsw-stage');
var countEl = ui.querySelector('.wsw-count');
var barEl = ui.querySelector('.wsw-bar i');
var undoBtn = ui.querySelector('.wsw-undo');
var stampKeep = ui.querySelector('.wsw-stamp.wsw-keep');
var stampSkip = ui.querySelector('.wsw-stamp.wsw-skip');

/* ------------------------------------------------------------------ *
 * 3. State + rendering
 * ------------------------------------------------------------------ */

var i = 0;          // index of the card on top
var kept = [];      // cards swiped up, in order
var log = [];       // {index, keptIt} so undo can rewind

function build(card) {
  var el = document.createElement('div');
  el.className = 'wsw-card';
  el.innerHTML =
    '<div class="wsw-h"></div>' +
    '<div class="wsw-body"></div>' +
    '<div class="wsw-hint">Tap to expand &middot; swipe up to keep</div>';
  el.querySelector('.wsw-h').textContent = card.title;
  el.querySelector('.wsw-body').innerHTML = card.html;
  // Inert links, belt and braces -- href is already stripped.
  el.addEventListener('click', function (e) {
    if (e.target.closest('a')) e.preventDefault();
  });
  return el;
}

// Keep exactly three cards mounted: the live one plus two peeking behind it.
function sync() {
  var want = [];
  for (var n = i; n < Math.min(i + 3, cards.length); n++) want.push(n);

  Array.from(stage.querySelectorAll('.wsw-card')).forEach(function (el) {
    if (want.indexOf(+el.dataset.i) === -1) el.remove();
  });

  want.slice().reverse().forEach(function (n) {
    var el = stage.querySelector('.wsw-card[data-i="' + n + '"]');
    if (!el) {
      el = build(cards[n]);
      el.dataset.i = n;
      stage.insertBefore(el, stage.firstChild); // behind whatever's there
    }
    el.classList.remove('wsw-d1', 'wsw-d2');
    if (n === i + 1) el.classList.add('wsw-d1');
    if (n === i + 2) el.classList.add('wsw-d2');
    // Explicit z-index rather than relying on DOM order -- the live card has
    // to paint over the two behind it no matter what order they got built in.
    el.style.zIndex = 10 - (n - i);
  });

  countEl.textContent = Math.min(i + 1, cards.length) + ' / ' + cards.length;
  barEl.style.width = (i / cards.length) * 100 + '%';
  undoBtn.disabled = !log.length;

  if (i >= cards.length) finish();
  else arm(stage.querySelector('.wsw-card[data-i="' + i + '"]'));
}

/* ------------------------------------------------------------------ *
 * 4. Gestures
 * ------------------------------------------------------------------ */

function paint(el, dx, dy) {
  el.style.transform =
    'translate(' + dx + 'px,' + dy + 'px) rotate(' + dx / 22 + 'deg)';
  var up = Math.min(1, Math.max(0, -dy / THROW));
  var side = Math.min(1, Math.abs(dx) / THROW);
  // Only show the stamp for the axis that's actually winning, so a sloppy
  // diagonal doesn't light up both.
  stampKeep.style.opacity = -dy > Math.abs(dx) ? up : 0;
  stampSkip.style.opacity = -dy > Math.abs(dx) ? 0 : side;
}

function arm(el) {
  if (!el || el.dataset.armed) return;
  el.dataset.armed = '1';

  var x0, y0, t0, dx = 0, dy = 0, live = false, drag = false;

  el.addEventListener('pointerdown', function (e) {
    // An expanded card's text is a scroll surface, not a drag surface. We
    // still track the gesture though, so a *tap* on that text can collapse
    // the card -- otherwise an expanded card becomes a trap.
    drag = !(el.classList.contains('is-open') && e.target.closest('.wsw-body'));
    live = true;
    x0 = e.clientX; y0 = e.clientY; t0 = e.timeStamp; dx = dy = 0;
    if (drag) {
      el.classList.add('is-drag');
      el.setPointerCapture(e.pointerId);
    }
  });

  el.addEventListener('pointermove', function (e) {
    if (!live) return;
    dx = e.clientX - x0;
    dy = e.clientY - y0;
    // Up is the only vertical direction that means anything; damp downward
    // pulls so the card feels anchored rather than droopy.
    if (drag) paint(el, dx, dy > 0 ? dy * 0.25 : dy);
  });

  function release(e) {
    if (!live) return;
    live = false;
    if (drag) el.classList.remove('is-drag');
    var ms = Math.max(1, e.timeStamp - t0);
    var vx = Math.abs(dx) / ms, vy = -dy / ms;

    // pointercancel means the browser took the gesture for scrolling.
    if (e.type !== 'pointercancel' && Math.hypot(dx, dy) < TAP && ms < 400) {
      var open = el.classList.toggle('is-open');
      el.querySelector('.wsw-hint').textContent = open
        ? 'Tap to collapse · scroll to read'
        : 'Tap to expand · swipe up to keep';
      if (drag) paint(el, 0, 0);
      return;
    }
    if (!drag) return; // it was a scroll, not a swipe

    // Up wins ties: it's the deliberate gesture, sideways is the lazy one.
    if (-dy > THROW && -dy > Math.abs(dx)) return go(el, true);
    if (vy > FLICK && -dy > Math.abs(dx)) return go(el, true);
    if (Math.abs(dx) > THROW || vx > FLICK) return go(el, false);
    paint(el, 0, 0); // snap back
  }

  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
}

/* ------------------------------------------------------------------ *
 * 5. Actions
 * ------------------------------------------------------------------ */

function go(el, keepIt) {
  if (!el || el.dataset.flying) return;
  el.dataset.flying = '1';
  var n = +el.dataset.i;

  if (keepIt) kept.push(cards[n]);
  log.push({ index: n, keptIt: !!keepIt });
  i = n + 1;

  stampKeep.style.opacity = stampSkip.style.opacity = 0;
  el.classList.add('wsw-gone');
  el.style.transform = keepIt
    ? 'translateY(-130vh) rotate(-4deg)'
    : 'translate(' + (Math.random() < 0.5 ? -1 : 1) * 130 + 'vw,40px) rotate(28deg)';
  setTimeout(function () { el.remove(); }, 340);

  sync();
}

function act(keepIt) {
  go(stage.querySelector('.wsw-card[data-i="' + i + '"]'), keepIt);
}

function undo() {
  var last = log.pop();
  if (!last) return;
  if (last.keptIt) kept.pop();
  i = last.index;
  var end = stage.querySelector('.wsw-end');
  if (end) end.remove();
  ui.classList.remove('is-done');
  stage.querySelectorAll('.wsw-card').forEach(function (el) { el.remove(); });
  sync();
  var top = stage.querySelector('.wsw-card[data-i="' + i + '"]');
  if (top) {
    // Fly it back in from the direction it left.
    top.style.transition = 'none';
    top.style.transform = last.keptIt ? 'translateY(-60vh)' : 'translateX(-60vw) rotate(-20deg)';
    requestAnimationFrame(function () {
      top.style.transition = '';
      top.style.transform = '';
    });
  }
}

ui.querySelector('.wsw-yes').addEventListener('click', function () { act(true); });
ui.querySelector('.wsw-no').addEventListener('click', function () { act(false); });
undoBtn.addEventListener('click', undo);
ui.querySelector('.wsw-x').addEventListener('click', teardown);

function teardown() {
  ui.remove();
  document.documentElement.style.overflow = '';
}

/* ------------------------------------------------------------------ *
 * 6. Done screen
 * ------------------------------------------------------------------ */

function payload() {
  if (!kept.length) return '';
  var base = location.origin + location.pathname;
  return (
    '# ' + document.title.replace(/ - Wikipedia.*$/, '') + '\n' + base + '\n\n' +
    kept
      .map(function (c) {
        return (
          '## ' + c.title +
          (c.anchor ? '\n' + base + '#' + c.anchor : '') +
          '\n\n' + c.text
        );
      })
      .join('\n\n---\n\n')
  );
}

function copy(text, btn) {
  function flash(ok) {
    btn.textContent = ok ? 'Copied ✓' : 'Select & copy ↑';
    setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
  }
  // navigator.clipboard needs HTTPS + a user gesture; the tap gives us the
  // gesture, but the Shortcuts webview can still refuse, hence the fallback.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { flash(true); }, function () { legacy(); });
  } else legacy();

  function legacy() {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    ui.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(0, text.length); // iOS ignores .select() here
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    flash(ok);
  }
}

function finish() {
  if (stage.querySelector('.wsw-end')) return;
  var text = payload();
  var end = document.createElement('div');
  end.className = 'wsw-end';
  end.innerHTML =
    '<h2></h2><pre></pre>' +
    '<div class="wsw-row">' +
      '<button class="wsw-again">Restart</button>' +
      '<button class="wsw-copy">Copy</button>' +
    '</div>';
  end.querySelector('h2').textContent =
    kept.length ? 'Kept ' + kept.length + ' of ' + cards.length : 'Kept nothing';
  end.querySelector('pre').textContent = text || 'You swiped everything away.';
  end.querySelector('.wsw-copy').addEventListener('click', function (e) {
    if (text) copy(text, e.currentTarget);
  });
  end.querySelector('.wsw-again').addEventListener('click', function () {
    end.remove();
    ui.classList.remove('is-done');
    i = 0; kept = []; log = [];
    sync();
  });
  stage.appendChild(end);
  ui.classList.add('is-done');
  countEl.textContent = cards.length + ' / ' + cards.length;
  barEl.style.width = '100%';
}

sync();

// Hand the shortcut back now -- the overlay lives on in Safari after this.
DONE({ sections: cards.length });

}}}
