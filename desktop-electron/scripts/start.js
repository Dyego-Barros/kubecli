const { spawn } = require('child_process');
const electron = require('electron');

if (process.platform === 'win32') {
  console.error('K8sOps suporta somente macOS e Linux.');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
