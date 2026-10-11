import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function startProcess(database) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, PORT: '0', DB_PATH: database },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out')); }, 10000);
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${errors}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(line => line.startsWith('{"listening":'));
      if (line) { clearTimeout(timeout); resolve(`http://127.0.0.1:${JSON.parse(line).listening}`); }
    });
  });
  return { child, base };
}
export async function stopProcess(service) {
  if (service.child.exitCode !== null) return;
  const exited = once(service.child, 'exit');
  service.child.kill('SIGTERM');
  await exited;
}
