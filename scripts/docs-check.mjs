import fs from 'node:fs';

const requiredFiles = [
  'README.md',
  'docs/quickstart.md',
  'docs/mcp-clients.md',
  'docs/tools.md',
  'docs/agent-instructions.md',
  'docs/configuration.md',
];

const requiredReadmeText = [
  'Stop AI coding agents from wasting tokens on grep',
  'Security model',
  'Configuration',
  'Token savings benchmark',
  'codebone_impact',
];

const missing = [];
for (const file of requiredFiles) {
  if (!fs.existsSync(file)) missing.push(file);
}

if (!missing.length) {
  const readme = fs.readFileSync('README.md', 'utf8');
  for (const text of requiredReadmeText) {
    if (!readme.includes(text)) missing.push(`README missing: ${text}`);
  }
}

if (missing.length) {
  console.error(`docs-check failed:\n${missing.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('docs-check ok');
