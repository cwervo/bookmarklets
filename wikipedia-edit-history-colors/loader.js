// ==Bookmarklet==
// @name Wikipedia Edit History Colors (loader)
// @author Andres Cuervo
// ==/Bookmarklet==
//
// Tiny variant that loads the full script from GitHub Pages, for browsers
// that choke on long bookmark URLs. Note that a site's Content Security
// Policy can block scripts loaded this way; the self-contained bookmarklet
// in source.js never has that problem.
var s = document.createElement('script');
s.src = 'https://cwervo.github.io/bookmarklets/wikipedia-edit-history-colors.js?' + Date.now();
document.body.appendChild(s);
