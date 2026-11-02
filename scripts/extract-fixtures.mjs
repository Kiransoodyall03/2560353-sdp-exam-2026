// `npm run fixtures`: cuts small, real fixtures for the Vitest suites out of docs/samples.txt.
// Each fixture keeps the samples.txt line format: `<topic> <payload>` (payload may be empty).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'server/test/fixtures');
mkdirSync(out, { recursive: true });

const lines = readFileSync(join(root, 'docs/samples.txt'), 'utf8').split('\n').filter(Boolean);
const topicOf = (l) => {
  const i = l.indexOf(' ');
  return i < 0 ? l : l.slice(0, i);
};
const pick = (pred, limit = Infinity) => {
  const res = [];
  for (const l of lines) {
    if (res.length >= limit) break;
    if (pred(topicOf(l), l)) res.push(l);
  }
  return res;
};
/** First `n` lines per distinct topic pattern (entity segment generalised). */
const perPattern = (pred, n) => {
  const seen = new Map();
  return pick((t, l) => {
    if (!pred(t, l)) return false;
    const key = t.replace(/^(arl\/[a-z]+\/)[^/]+\/(telemetry|state)\//, '$1+/$2/');
    const c = seen.get(key) ?? 0;
    if (c >= n) return false;
    seen.set(key, c + 1);
    return true;
  });
};

const files = {
  'topology.txt': pick((t) => t.endsWith('/$topology')),
  'rta-telemetry.txt': [
    ...pick((t) => /^arl\/rta\/[^/]+\/telemetry\/normal$/.test(t), 120),
    ...pick((t) => /^arl\/rta\/[^/]+\/telemetry\/scan$/.test(t), 400),
  ],
  'rta-state.txt': perPattern((t) => /^arl\/rta\/[^/]+\/state\//.test(t), 6),
  'rta-events.txt': [
    ...pick((t) => t === 'arl/rta/events/scan'),
    ...pick((t) => /^arl\/rta\/(ack|cmd)\//.test(t)),
  ],
  'alerts.txt': [
    ...pick((t) => t === 'arl/rta/events/alert', 250),
    ...pick((t) => /^arl\/(lwm|opg)\/events\/alert$/.test(t)),
    ...pick((t) => /\/global\/state\/active_alerts$/.test(t), 40),
  ],
  'lwm-opg.txt': [
    ...perPattern((t) => /^arl\/(lwm|opg)\/[^/]+\/telemetry\//.test(t), 5),
    ...perPattern((t) => /^arl\/(lwm|opg)\/[^/]+\/state\//.test(t), 2),
    ...pick((t) => /^arl\/lwm\/events\/lightning$/.test(t), 10),
  ],
};

for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(out, name), content.join('\n') + '\n');
  console.log(`${name.padEnd(20)} ${String(content.length).padStart(5)} lines`);
}
