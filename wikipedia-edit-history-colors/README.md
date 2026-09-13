# Wikipedia Edit History Colors

A bookmarklet that colors every word of a Wikipedia article by the date it was
added, and lets you triple-click any word to see the section as it looked in
the exact edit that introduced it.

Live page with the drag-to-bookmark button:
<https://cwervo.github.io/bookmarklets/wikipedia-edit-history-colors/>

## Contents

- [What you get](#what-you-get)
- [Installing](#installing)
- [Using it](#using-it)
- [The color ramp](#the-color-ramp)
- [The triple-click popup](#the-triple-click-popup)
- [How it works](#how-it-works)
- [API calls it makes](#api-calls-it-makes)
- [Tuning knobs](#tuning-knobs)
- [Files](#files)
- [Building](#building)
- [Testing](#testing)
- [Limitations and known quirks](#limitations-and-known-quirks)
- [Browser support](#browser-support)
- [Privacy](#privacy)

## What you get

Click the bookmarklet on any Wikipedia article and, after a few seconds of
fetching, every word (and every piece of punctuation) is wrapped in a colored
span. Spaces are never colored. The color says when that text was added:

- Red, orange, yellow, green, blue, violet, from the article's first edit to
  its most recent one.
- Lightness climbs monotonically from near-black to near-white along the same
  axis, so the order still reads in grayscale and under every kind of color
  blindness. Words sit on their color in black or white text, whichever
  contrasts better.

A small legend in the bottom-right corner shows the gradient with dates, lets
you switch modes, reverse the direction, or remove the coloring.

Hovering a word shows the date range it was added in. Triple-clicking (or
triple-tapping on touch screens) a word pinpoints the exact revision and opens
a popup inset 20% from every edge of the window (so it covers 60% of the
viewport) showing that section as it was in that revision, scrolled so the
clicked word is centered and highlighted.

It only talks to Wikipedia's own API on the same origin, so it works on every
language edition, on mobile Wikipedia, and on any other MediaWiki site that
exposes `mw.config`.

## Installing

1. Open <https://cwervo.github.io/bookmarklets/wikipedia-edit-history-colors/>.
2. Drag the **Wikipedia Edit History Colors** button to your bookmarks bar.
3. Open any Wikipedia article and click the bookmark.

The main button is fully self-contained: the whole script lives inside the
bookmark URL (about 27 KB). If your browser refuses bookmark URLs that long,
use the gray **loader** button instead. It stores a tiny bookmark that fetches
`docs/wikipedia-edit-history-colors.js` from this repository's GitHub Pages
site each time it runs. The loader depends on the page's Content Security
Policy allowing an external script, so prefer the self-contained one when it
works.

## Using it

| Action | Result |
| --- | --- |
| Click the bookmarklet | Colors the article. A toast in the top-right shows progress. |
| Click it again, or the ✕ in the legend | Restores the page exactly as it was. |
| Hover a word | Tooltip with the date range the word was added in. |
| Triple-click / triple-tap a word | Opens the popup for the revision that added it. |
| Esc, the ✕, or clicking the backdrop | Closes the popup. |
| **Highlight** (default) | Colors the background behind each word, text in black or white. |
| **Ink** | Colors the letters themselves. The ramp is clamped to a darker range so it stays readable on white. |
| **Mono** | Drops the hue entirely: pure black (oldest) to white (newest). |
| **⇄** | Reverses the ramp direction so the newest text is dark red and the oldest is pale violet. |

Words that are only in the rendered page and not in the article's wikitext
(infobox labels, hatnotes, navigation boxes, anything a template generates)
cannot be dated. They get a dotted gray underline instead of a color.

While the coloring is active, single clicks on links inside the article are
delayed by about 0.7 seconds so that a triple-click on a linked word can open
the popup instead of navigating. Modifier-clicks (Ctrl, Cmd, Shift, middle
button) are passed straight through.

## The color ramp

The ramp is generated in OKLCH so lightness and hue can be controlled
independently:

- **Hue** is piecewise linear through six stops: red (28°), orange (60°),
  yellow (98°), green (142°), blue (258°), violet (305°) at t = 0, 0.2, 0.4,
  0.6, 0.8, 1.
- **Lightness** rises linearly with t. In Highlight and Mono modes it runs from
  0.20 to 0.96, which is why the two ends read as black and white. In Ink mode
  it runs from 0.27 to 0.60 so the text keeps contrast against the page.
- **Chroma** is a constant 0.13 in Highlight mode, 0.17 in Ink mode, and 0 in
  Mono mode. The browser gamut-maps anything that falls outside sRGB.
- Text color in Highlight and Mono modes flips from white to black once
  lightness reaches 0.62, which keeps at least roughly 4:1 contrast at every
  point of the ramp.

`t` is the position of a word's date between the article's first revision
(t = 0) and the revision you are viewing (t = 1), linear in time. Because a
word is dated to a bucket between two samples rather than to an exact second,
its color is taken from the middle of that bucket.

A pure rainbow is one of the worst possible scales for color-blind readers,
since red, green, and (for some) yellow collapse into one another. Tying
lightness to the same axis is what makes this ramp usable: even if every hue
looked identical, the ordering would still be visible, and the Mono button is
there to prove it.

## The triple-click popup

Triple-clicking a word runs a binary search for the exact revision that added
it (see below), then fetches the rendered HTML of that revision and shows it in
a popup:

- The header shows the section name, the revision's date, ID, editor and edit
  summary, and links to open the revision or its diff on Wikipedia.
- Only the section containing the word is shown by default. The **Full page**
  button toggles to the whole article as of that revision.
- The word is found again in the old rendering by matching it together with up
  to three words of context on each side. It gets a strong yellow mark, the
  context a paler one, and the popup scrolls so the mark is vertically
  centered. If the word cannot be found in the old rendering (for example if it
  came from a template parameter), the popup scrolls to the matching section
  heading instead.
- On desktop the popup uses `inset: 20%`, so it is 60% of the viewport in both
  dimensions. Below 720 px wide or 500 px tall it grows to `inset: 4%`.
- Page scrolling is locked while the popup is open and restored on close.

Triple-click detection uses its own tap counter (three clicks on the same word
within 650 ms of each other) as well as the browser's `event.detail`, so it
works on touch screens where `detail` is not reliable. The third `mousedown`
is cancelled so the browser does not select the whole paragraph.

## How it works

Wikipedia does not expose per-word authorship, so the bookmarklet computes it
client-side from a small number of history samples. The pipeline is:

1. **Tokenize the rendered page.** A TreeWalker visits every text node under
   `.mw-parser-output`, skipping edit links, `[1]` citation markers, back
   links, navboxes, the table of contents, math, hatnotes and similar
   generated content. Each text node is split into tokens: runs of letters,
   numbers and combining marks; single characters for punctuation; and one
   token per character for Han, Hiragana, Katakana and Thai scripts so that
   an edit inside an unspaced sentence does not re-date the whole sentence.
   Tokens are compared after NFC normalization and lowercasing.

2. **Fetch the current and first revisions** and tokenize the current
   wikitext the same way (after stripping HTML comments, which are never
   rendered).

3. **Align the rendered tokens to the wikitext tokens.** An index of every
   bigram in the wikitext is built. The rendered tokens are walked in order
   with a pointer into the wikitext:
   - A bigram match within 40 tokens ahead of the pointer is accepted as is.
   - A farther match, forwards or backwards, needs a third matching neighbour
     (a trigram), or must be a bigram that occurs exactly once in the whole
     wikitext. Backwards jumps are what make the reference list work, since
     its text lives inline in `<ref>` tags much earlier in the wikitext.
   - A bigram-only match up to 400 tokens ahead is accepted as a fallback.
   - A single token that is not part of any matching bigram (typically a
     one-word heading, or the last word of a paragraph) is accepted if it is
     exactly at the pointer, or within 40 tokens for words of three or more
     characters.
   - Finally, unmatched tokens sitting between two matched neighbours are
     filled in if the same token appears between the neighbours' wikitext
     positions.
   Anything still unmatched is rendered with the dotted underline.

4. **Sample the history.** 23 requests ask for the first revision at or after
   each of 23 evenly spaced timestamps between the first revision and the one
   being viewed, five requests at a time. Together with the first and current
   revisions that gives up to 24 samples (fewer on articles with sparse
   histories, since duplicates are dropped).

5. **Date every matched wikitext token.** Samples are processed oldest to
   newest. For each one, a set of all its bigrams is built and every not-yet
   dated token is tested against it. A word counts as present in a sample if
   either of its neighbouring bigrams (previous word + it, or it + next word)
   exists there, so inserting a word next to it later does not steal its
   attribution. Punctuation binds to the word it is attached to: the word
   before it, or the word after it for opening brackets and quotes. Each
   token is dated to the first sample that contains it, which is how moved
   text and reverted vandalism keep their original date, in the same spirit
   as WikiWho.

6. **Paint.** Each text node is replaced by a fragment of spans (one per
   token) and plain text nodes for the whitespace between them. Spans carry
   a class per sample, and a single `<style>` element maps each class to its
   color, so switching modes or reversing the ramp rewrites one stylesheet
   instead of touching tens of thousands of elements.

7. **Refine.** The buckets that received the most visible words are split
   further: 16 extra samples are spent four at a time on the busiest buckets
   by fetching the revision at the bucket's midpoint in time and re-testing
   only the tokens dated to that bucket. Buckets narrower than an hour, or
   with no revision at their midpoint, are left alone. The page is repainted
   after every round, so the coloring sharpens while you watch.

8. **Pinpoint on triple-click.** The word's bucket is known to start with a
   sample that lacks the word and end with one that has it. The list of
   revision IDs between those two samples is fetched (up to 2,000 revisions),
   and a binary search over that list fetches the wikitext of the midpoint
   revision each step and tests the word's bigrams. About eleven requests
   pin down the exact edit among two thousand. Fetched revisions are cached,
   so repeated clicks in the same area are fast.

## API calls it makes

All requests go to `wgScriptPath + '/api.php'` on the current origin with
`format=json&formatversion=2`, using the page's own cookies.

| Purpose | Request |
| --- | --- |
| Current revision wikitext | `action=query&prop=revisions&revids=<id>&rvslots=main&rvprop=ids\|timestamp\|user\|comment\|content` |
| First revision | same with `pageids=<id>&rvdir=newer&rvlimit=3` |
| Sample at a time | same plus `rvstart=<iso>&rvend=<iso>` |
| Revisions between two samples | `prop=revisions&pageids=<id>&rvprop=ids\|timestamp&rvdir=newer&rvlimit=max&rvstartid=<a>&rvendid=<b>` with `rvcontinue` |
| Old revision HTML | `action=parse&oldid=<id>&prop=text\|displaytitle&disableeditsection=1&disablelimitreport=1` |

Up to three revisions are requested for each sample so that a revision whose
text is hidden (suppressed) can be skipped. A full run on a typical article is
roughly 45 requests, one of which carries the current wikitext and the rest
one revision's wikitext each.

## Tuning knobs

The `CFG` object at the top of `source.js`:

| Key | Default | Meaning |
| --- | --- | --- |
| `samples` | 24 | Initial samples, evenly spaced in time. |
| `refine` | 16 | Extra adaptive samples spent on the busiest buckets. |
| `concurrency` | 5 | Parallel API requests while sampling. |
| `minGapMs` | 1 hour | Never split a bucket narrower than this. |
| `listPages` | 4 | Maximum pages of 500 revision IDs fetched when pinpointing. |
| `near` | 40 | Bigram-only match window during alignment, in wikitext tokens. |
| `window` | 400 | Mid-range bigram-only fallback window. |

Raising `samples` and `refine` gives finer dating at the cost of more requests
and more wikitext downloads (each sample is a full copy of the article as of
that time).

## Files

| File | What it is |
| --- | --- |
| `source.js` | The bookmarklet. Pure helpers (tokenizer, alignment, presence test, ramp) are at the top and exported when loaded from Node, so they can be unit-tested; the DOM part runs only in a browser. |
| `loader.js` | The tiny alternative bookmarklet that injects the hosted script. |
| `build.js` | Compiles both with the `bookmarklet` npm package, writes the docs page, and copies `source.js` to the hosted location. |
| `../docs/wikipedia-edit-history-colors/index.html` | Generated docs page with both buttons. |
| `../docs/wikipedia-edit-history-colors.js` | Generated hosted copy of the script for the loader. |

## Building

```
npm install -g bookmarklet
cd wikipedia-edit-history-colors
node build.js
```

If `bookmarklet` is installed somewhere else, point `NODE_PATH` at its
`node_modules` directory. The build minifies the source with Terser, wraps it
in an IIFE, URL-encodes it into a `javascript:` URL, and regenerates the two
files under `docs/`. Commit those generated files: GitHub Pages serves the
`docs/` folder.

## Testing

Because Wikipedia's API cannot be hit from a unit test, the script is written
so the algorithmic core can be tested in Node and the DOM behaviour in a
headless browser against a fake Wikipedia:

- **Unit tests** require `source.js` from Node (which exports the pure
  helpers) and check the tokenizer, the bigram presence rule, the alignment on
  a wikitext sample with an infobox, refs, headings and a reflist, and the
  ramp's hue order and monotonic lightness.
- **End-to-end tests** run Playwright with a routed `en.wikipedia.org`: a mock
  page built from a synthetic 12-revision history (2004 to 2024, including a
  vandalism and revert pair) and a mock `api.php` that answers the query and
  parse requests above. The test injects the bookmarklet (either the raw
  source or the compiled `javascript:` URL), waits for refinement to finish,
  and asserts that probed words land on the correct year, that spans never
  contain whitespace, that the three modes render as expected, that a triple
  click on a linked word opens the popup without navigating while a single
  click still follows the link, that the popup is exactly 60% of the viewport
  and shows only the right section with the word marked and visible, that the
  binary search reports the exact revision, that running the bookmarklet
  again restores the original DOM, and that the popup inset shrinks on a
  400 px viewport.

These harnesses are not committed with the repository; the description above
is enough to recreate them.

## Limitations and known quirks

- **Dates are bucketed until you triple-click.** Coloring reflects the sample
  bucket a word first appeared in, so on an article with a 20-year history
  and 24 initial samples the base resolution is about ten months, sharpened
  where most of the text landed. The tooltip always shows the bucket's range,
  and the popup shows the exact revision.
- **Reformatting re-dates words.** A word counts as present when one of its
  neighbouring bigrams exists in the sample. Wrapping a word in bold marks, a
  link, or a template changes both neighbours, so it is dated to the edit
  that reformatted it rather than the edit that wrote it. Common phrases can
  also match an unrelated earlier occurrence and be dated too early.
- **Template output is undatable.** Infobox labels, converted units,
  citation formatting and similar generated text does not exist in the
  wikitext. The alignment leaves it underlined rather than guessing.
- **Very long articles take a while.** Each sample downloads the whole
  wikitext as of that time, and the popup's binary search downloads several
  more. A 300 KB article means several megabytes over the run.
- **Suppressed revisions are skipped.** If a revision's text is hidden, the
  next visible one is used as the sample.
- **Viewing an old revision** (`?oldid=`) dates text relative to that
  revision, which is intended.
- **The loader variant** can be blocked by a Content Security Policy that
  forbids external scripts; the self-contained bookmarklet is unaffected.
- The script was verified against a mock of MediaWiki's output rather than
  live Wikipedia, so alignment quality on unusually template-heavy pages is
  the part most worth a look if something seems off.

## Browser support

The script uses `oklch()` colors, Unicode property escapes with script
extensions in regular expressions, `String.prototype.normalize`, `fetch`,
`URLSearchParams`, `Element.closest`, and `Range.surroundContents`. That means
Chrome and Edge 112+, Firefox 116+, and Safari 17+. Everything is wrapped in a
single IIFE, stores its state on `window.weh`, and removes all of its
listeners, styles and elements when toggled off.

## Privacy

Nothing leaves your browser except the API requests to the Wikipedia site you
are already on. No third-party service is contacted, nothing is stored, and
the self-contained bookmarklet does not even load a remote script.
