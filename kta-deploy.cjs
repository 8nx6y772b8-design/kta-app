#!/usr/bin/env node
// KTA Deploy Server
// Watches ~/Downloads for write_*.py files, runs them, then git commits and pushes
// Run once: node kta-deploy.js
// Keep running in a terminal tab

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const PROJECT   = path.join(os.homedir(), 'Desktop', 'workos');
const PROCESSED = path.join(PROJECT, '.deploy-processed');

// Track which files we've already handled
const processed = new Set(
  fs.existsSync(PROCESSED) ? fs.readFileSync(PROCESSED, 'utf8').split('\n').filter(Boolean) : []
);

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

function run(cmd, cwd) {
  return execSync(cmd, { cwd: cwd || PROJECT, encoding: 'utf8', stdio: 'pipe' });
}

function getVersion(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/v(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function processFile(pyFile) {
  const name = path.basename(pyFile);
  if (processed.has(name)) return;
  if (!name.startsWith('write_') || !name.endsWith('.py')) return;

  log(`📦 Found: ${name}`);

  try {
    // Run the python script to write the file
    const result = execSync(`python3 "${pyFile}"`, { encoding: 'utf8' });
    log(`✅ Written: ${result.trim()}`);

    // Mark as processed
    processed.add(name);
    fs.appendFileSync(PROCESSED, name + '\n');

    // Delete the py file so it doesn't re-trigger
    fs.unlinkSync(pyFile);
    log(`🗑  Cleaned up: ${name}`);

    // Wait a moment in case multiple files are incoming
    await new Promise(r => setTimeout(r, 2000));

    // Check git status
    const status = run('git status --short');
    const changed = status.trim().split('\n').filter(l => l.trim() && !l.includes('.DS_Store'));

    if (!changed.length) {
      log('ℹ️  No git changes detected');
      return;
    }

    log(`📝 Changes: ${changed.map(l=>l.trim()).join(', ')}`);

    // Get version from App.jsx if it changed
    const appFile = path.join(PROJECT, 'src', 'App.jsx');
    const version = getVersion(appFile);
    const commitMsg = version ? `v${version} - auto deploy` : 'Auto deploy update';

    // Git add, commit, push
    run('git add src/App.jsx src/supabaseClient.js 2>/dev/null || git add -A -- src/');
    run(`git commit -m "${commitMsg}"`);
    run('git push');
    log(`🚀 Pushed: ${commitMsg}`);

    // Vercel deploy
    log('⏳ Deploying to Vercel...');
    execSync('npx vercel --prod --force', {
      cwd: PROJECT,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    log('🌐 Live on crmkta.com!');

  } catch (err) {
    log(`❌ Error: ${err.message}`);
  }
}

// Watch Downloads folder
log('👀 Watching ~/Downloads for write_*.py files...');
log(`📁 Project: ${PROJECT}`);
log('💡 Drop any write_app.py or write_*.py into Downloads and it deploys automatically\n');

fs.watch(DOWNLOADS, async (event, filename) => {
  if (!filename || !filename.startsWith('write_') || !filename.endsWith('.py')) return;
  const full = path.join(DOWNLOADS, filename);

  // Small delay to ensure file is fully written
  setTimeout(() => {
    if (fs.existsSync(full)) processFile(full);
  }, 500);
});

// Also scan Downloads on startup for any pending files
fs.readdirSync(DOWNLOADS)
  .filter(f => f.startsWith('write_') && f.endsWith('.py'))
  .forEach(f => {
    const full = path.join(DOWNLOADS, f);
    setTimeout(() => processFile(full), 1000);
  });

// Keep process alive
process.on('SIGINT', () => {
  log('👋 Deploy server stopped');
  process.exit(0);
});
