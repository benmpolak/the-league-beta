// the-league-beta is the lads' pre-season test site: it plays ONLY in the
// sandbox league. Classic (non-module) script so it runs during parse, before
// the sync module computes the league key. Inert on every other host/path.
// External file because the page CSP rightly forbids inline scripts.
if (location.pathname.includes('the-league-beta') && !location.search.includes('sandbox')) {
  location.replace(location.pathname + '?sandbox' + location.hash);
}
