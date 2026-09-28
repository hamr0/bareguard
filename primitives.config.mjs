import { basename } from 'node:path';
function inferCategory(file) {
  const b = basename(file, '.js');
  if (b === 'index' || b === 'types') return 'core';
  if (b === 'gate') return 'gate';
  if (b === 'glob') return 'matching';
  if (b === 'audit-window') return 'audit';
  if (b === 'defer-rate' || b === 'spawn-rate') return 'rate';
  return b;
}
export default {
  inferCategory,
  sourceRoots: ['src', 'tools'],
  receivers: {},
};
