// ================= League lore — feeds the weekly preview =================
// Manager ids: 1 Ben Polak · 2 Toby Levy · 3 Ben Levy · 4 Adam Jackson ·
// 5 Ian Tussie · 6 Alex Singer · 7 Ric Blank · 8 Marc Conway ·
// 9 Alex Duckett · 10 Lee Warner · 11 Daniel Geller · 12 Wilko Wilkowski
//
// RIVALRIES: petty history between pairs. `pair` is two manager ids (order
// irrelevant). `line` is what the preview prints when they meet. Add as many
// per pair as you like — one is chosen per meeting, deterministically.
const RIVALRIES = [
  // { pair: [2, 3], line: 'The Levy derby. Mum has asked them not to discuss it at dinner.' },
  // { pair: [5, 7], line: 'Tussie v Blanky — two titles each…' },
];

// One-liners about individual managers, used to colour previews. Keyed by id.
const MANAGER_LORE = {
  // 3: 'has fucked it with Haaland two years running',
  // 11: 'waited ten years on the waiting list for this',
};

// ================= Pitch-side advertising boards =================
// Official partners of The League. A rotating selection appears on every
// pitch — real workplaces first, then the commercial portfolio.
// t = wordmark, s = strapline, c = brand colour, bg = board background.
const AD_BOARDS = [
  { t: 'HERTILITY', s: 'know your body', c: '#ff9ec6', bg: '#1c0f16' },
  { t: 'T8', s: 'ask Iain what it does', c: '#7dd8ff', bg: '#0c1620' },
  { t: 'GELT & CO.', s: 'wealth management, allegedly', c: '#e8b64c', bg: '#171106' },
  { t: 'OY VEY INSURANCE', s: 'you should worry', c: '#f4f4f4', bg: '#5a1414' },
  { t: 'BUBBE’S SOUP CO.', s: 'jewish penicillin since 1936', c: '#ffd98a', bg: '#26190a' },
  { t: 'KOSHER NOSTRA', s: 'a deli you can’t refuse', c: '#e0e0e0', bg: '#101010' },
  { t: 'CHALLAH BACK BOYS', s: 'artisan bakery · est. 5784', c: '#f2c179', bg: '#1d130a' },
  { t: 'GOLDSTEIN & SONS', s: 'we schlep so you don’t have to', c: '#c9d6ff', bg: '#101528' },
  { t: 'MENSCH CAPITAL', s: 'nice boys, aggressive returns', c: '#9fe8c5', bg: '#0a1c14' },
  { t: 'L’CHAIM WINES', s: 'to life. to a 2-1 win.', c: '#e88aa0', bg: '#1e0a10' },
  { t: 'THE SCHMEAR CAMPAIGN', s: 'bagels · lox · public relations', c: '#ffe0b3', bg: '#211405' },
  { t: 'SHABBAT ENERGY', s: 'we’re off saturdays', c: '#fff3a0', bg: '#1c1a05' },
  { t: 'POLAK & LEVY LLP', s: 'no win, no schmear', c: '#b7e4f7', bg: '#0b1a22' },
  { t: 'NICE JEWISH BOY™', s: 'the dating app your mum chose', c: '#f7b7d0', bg: '#20101a' },
];
