#!/usr/bin/env node
import { main } from '../src/index.js';

main(process.argv.slice(2))
  .then((code) => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    const message = err?.stack || String(err);
    console.error(message);
    process.exit(1);
  });
