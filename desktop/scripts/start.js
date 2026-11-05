const { spawn } = require('node:child_process');
const { join } = require('node:path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(String(electron), [join(__dirname, '..')], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
