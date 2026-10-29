const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ALLOWED_SCRIPTS = new Set(['test', 'lint', 'typecheck', 'build']);
const DEFAULT_SCRIPTS = ['test'];
const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 32_000;

function readVerificationConfig(root) {
  const configPath = path.join(root, '.chat', 'config.json');
  if (!fs.existsSync(configPath)) return { scripts: DEFAULT_SCRIPTS };

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read .chat/config.json: ${error.message}`);
  }

  const scripts = config?.verification?.scripts;
  if (scripts === undefined) return { scripts: DEFAULT_SCRIPTS };
  if (!Array.isArray(scripts) || scripts.some(name => typeof name !== 'string' || !ALLOWED_SCRIPTS.has(name))) {
    throw new Error('verification.scripts must contain only test, lint, typecheck, or build.');
  }
  return { scripts: [...new Set(scripts)] };
}

function packageScripts(root) {
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error('No package.json found in the project directory.');
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read package.json: ${error.message}`);
  }
  return packageJson.scripts || {};
}

function runScript(root, name, timeoutMs = SCRIPT_TIMEOUT_MS) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(command, ['run', name, '--if-present'], {
      cwd: root,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let timedOut = false;
    const append = chunk => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      resolve({
        name, status: 'failed', exitCode: null, durationMs: Date.now() - startedAt,
        output: `${output}\n${error.message}`.trim(), error: error.message
      });
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        name,
        status: exitCode === 0 && !timedOut ? 'passed' : 'failed',
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        timedOut,
        output: output.trim()
      });
    });
  });
}

async function verifyProject({ root, scripts, timeoutMs = SCRIPT_TIMEOUT_MS } = {}) {
  const projectRoot = path.resolve(root || process.cwd());
  const packageJsonScripts = packageScripts(projectRoot);
  const configured = scripts === undefined ? readVerificationConfig(projectRoot).scripts : scripts;
  if (!Array.isArray(configured) || configured.some(name => typeof name !== 'string' || !ALLOWED_SCRIPTS.has(name))) {
    throw new Error('Verification accepts only test, lint, typecheck, or build scripts.');
  }
  const selected = [...new Set(configured)].filter(name => packageJsonScripts[name]);
  if (!selected.length) {
    throw new Error('No configured verification scripts exist in package.json.');
  }

  const results = [];
  for (const name of selected) results.push(await runScript(projectRoot, name, timeoutMs));
  const passed = results.filter(result => result.status === 'passed').length;
  const score = passed / results.length;
  return {
    root: projectRoot,
    status: passed === results.length ? 'passed' : 'failed',
    reward: { score, passed, total: results.length },
    results
  };
}

module.exports = { ALLOWED_SCRIPTS, DEFAULT_SCRIPTS, readVerificationConfig, verifyProject };
