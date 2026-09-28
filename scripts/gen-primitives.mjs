#!/usr/bin/env node
// Thin entry: the real generator is vendored byte-identically at
// scripts/primitives-core.mjs (pinned via test/primitives-core.test.mjs).
// See docs/product/bareguard-prd.md § 10.3 "Primitives manifest".
import { run } from './primitives-core.mjs';
import config from '../primitives.config.mjs';
await run(config);
