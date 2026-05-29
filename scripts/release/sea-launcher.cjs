const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function resolveEntryPoint() {
  const packaged = path.join(path.dirname(process.execPath), 'product', 'server', 'dist', 'index.js');
  if (fs.existsSync(packaged)) {
    return { entry: packaged, packaged: true };
  }

  const dev = path.resolve(__dirname, '..', '..', 'server', 'dist', 'index.js');
  if (fs.existsSync(dev)) {
    return { entry: dev, packaged: false };
  }

  throw new Error(`server entry not found: ${packaged}`);
}

(async () => {
  const { entry, packaged } = resolveEntryPoint();
  if (packaged) {
    process.env.SUPER_JINROH_EXECUTABLE_DIR = path.dirname(process.execPath);
  }
  const serverRoot = path.dirname(path.dirname(entry));
  process.chdir(serverRoot);
  await import(pathToFileURL(entry).href);
})().catch((error) => {
  console.error('[superJinroh] SEA launcher failed.');
  console.error(error);
  process.exit(1);
});
