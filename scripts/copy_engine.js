#!/usr/bin/env node
// Predeploy hook: the server runs the SAME engine the client renders with.
// (A file rather than an inline -e one-liner: quoting survives every shell.)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
fs.copyFileSync(path.join(ROOT, 'js', 'engine.js'), path.join(ROOT, 'functions', 'engine.js'));
console.log('functions/engine.js refreshed from js/engine.js');
