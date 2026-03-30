#!/usr/bin/env node
// KTA Edge Function Deploy Helper
// Usage: node kta-deploy-functions.cjs hubspot-proxy
//        node kta-deploy-functions.cjs xero-proxy
//        node kta-deploy-functions.cjs email-proxy
//        node kta-deploy-functions.cjs all

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const PROJECT     = path.join(os.homedir(), 'Desktop', 'workos');
const PROJECT_REF = 'sprlcvxlcjwhfzspkrww';
const FUNCTIONS   = ['hubspot-proxy', 'xero-proxy', 'email-proxy', 'timesheet-action'];

const target   = process.argv[2] || 'all';
const toDeploy = target === 'all' ? FUNCTIONS : [target];

for (const fn of toDeploy) {
  console.log(`\n🚀 Deploying ${fn}...`);
  try {
    execSync(
      `npx supabase functions deploy ${fn} --project-ref ${PROJECT_REF} --no-verify-jwt`,
      { cwd: PROJECT, encoding: 'utf8', stdio: 'inherit' }
    );
    console.log(`✅ ${fn} deployed`);
  } catch (e) {
    console.error(`❌ ${fn} failed: ${e.message}`);
  }
}
