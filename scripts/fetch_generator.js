// npm run fetch-generator: download BingoSync's Beta Quest generator (see load_generator.js) into vendor/bingosync/.
"use strict";

const { fetchGenerator } = require("../load_generator");

fetchGenerator()
  .then((dir) => console.log(`BingoSync's generator is ready in ${dir}`))
  .catch((e) => { console.error(e.message); process.exit(1); });
