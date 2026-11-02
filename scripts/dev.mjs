// `npm run dev`: API server (tsx watch) + Vite dev server, output prefixed, both stopped together.
import { spawn } from 'node:child_process';

const procs = [
  { name: 'server', color: 36, script: 'dev:server' },
  { name: 'web', color: 35, script: 'dev:web' },
];

const children = procs.map(({ name, color, script }) => {
  const child = spawn('npm', ['run', '--silent', script], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    process.stdout.write(`${prefix}exited (${signal ?? code})\n`);
    shutdown(code ?? 1);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
