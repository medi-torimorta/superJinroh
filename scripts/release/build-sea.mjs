import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const productRoot = path.resolve(__dirname, '..', '..');
const projectRoot = path.resolve(productRoot, '..');

const platform = process.platform;
const arch = process.arch;
const exeName = platform === 'win32' ? 'superjinroh.exe' : 'superjinroh';
const outRoot = path.join(productRoot, 'dist', 'sea', `${platform}-${arch}`);
const appRoot = path.join(outRoot, 'app');
const exePath = path.join(appRoot, exeName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function ensureEmptyDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDirRecursive(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else if (entry.isSymbolicLink()) {
      const resolved = fs.realpathSync(src);
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        copyDirRecursive(resolved, dst);
      } else {
        fs.copyFileSync(resolved, dst);
      }
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function stageRuntimeFiles() {
  const stagedProductRoot = path.join(appRoot, 'product');
  fs.mkdirSync(stagedProductRoot, { recursive: true });

  copyDirRecursive(path.join(productRoot, 'server', 'dist'), path.join(stagedProductRoot, 'server', 'dist'));
  copyDirRecursive(path.join(productRoot, 'server', 'data'), path.join(stagedProductRoot, 'server', 'data'));
  copyDirRecursive(path.join(productRoot, 'client', 'dist'), path.join(stagedProductRoot, 'client', 'dist'));
  copyDirRecursive(path.join(productRoot, 'shared', 'dist'), path.join(stagedProductRoot, 'shared', 'dist'));
  copyDirRecursive(path.join(productRoot, 'node_modules'), path.join(stagedProductRoot, 'node_modules'));

  for (const name of ['package.json', 'package-lock.json']) {
    const src = path.join(productRoot, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(stagedProductRoot, name));
    }
  }
}

function buildSeaBinary() {
  const seaTmpDir = path.join(productRoot, '.sea');
  fs.mkdirSync(seaTmpDir, { recursive: true });

  const launcherPath = path.join(productRoot, 'scripts', 'release', 'sea-launcher.cjs');
  const blobPath = path.join(seaTmpDir, 'sea-prep.blob');
  const configPath = path.join(seaTmpDir, 'sea-config.json');

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        main: launcherPath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
      },
      null,
      2,
    ),
  );

  run(process.execPath, ['--experimental-sea-config', configPath], { cwd: productRoot });

  fs.copyFileSync(process.execPath, exePath);

  if (platform === 'darwin') {
    run('codesign', ['--remove-signature', exePath]);
  }

  run(
    process.execPath,
    [
      path.join(productRoot, 'node_modules', 'postject', 'dist', 'cli.js'),
      exePath,
      'NODE_SEA_BLOB',
      blobPath,
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ],
    { cwd: productRoot },
  );

  if (platform === 'darwin') {
    run('codesign', ['--sign', '-', exePath]);
  }
}

function packageWindows() {
  const releaseExe = path.join(outRoot, 'superjinroh.exe');
  fs.copyFileSync(exePath, releaseExe);
  console.log(`Created ${releaseExe}`);
}

function packageMac() {
  const dmgPath = path.join(outRoot, 'superjinroh.dmg');
  run('hdiutil', ['create', '-volname', 'superJinroh', '-srcfolder', appRoot, '-ov', '-format', 'UDZO', dmgPath]);
  console.log(`Created ${dmgPath}`);
}

function packageLinux() {
  const appDir = path.join(outRoot, 'SuperJinroh.AppDir');
  ensureEmptyDir(appDir);

  fs.copyFileSync(exePath, path.join(appDir, 'superjinroh'));
  fs.chmodSync(path.join(appDir, 'superjinroh'), 0o755);

  const appRun = `#!/usr/bin/env bash\nHERE=\"$(cd \"$(dirname \"$0\")\" && pwd)\"\nexec \"$HERE/superjinroh\"\n`;
  fs.writeFileSync(path.join(appDir, 'AppRun'), appRun);
  fs.chmodSync(path.join(appDir, 'AppRun'), 0o755);

  fs.writeFileSync(
    path.join(appDir, 'superjinroh.desktop'),
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=superJinroh',
      'Exec=superjinroh',
      'Icon=utilities-terminal',
      'Categories=Game;',
      'Terminal=true',
      '',
    ].join('\n'),
  );

  const appImagePath = path.join(outRoot, 'superjinroh-x86_64.AppImage');
  const appImageTool = process.env.APPIMAGETOOL || 'appimagetool';
  run(appImageTool, [appDir, appImagePath], {
    env: {
      ...process.env,
      APPIMAGE_EXTRACT_AND_RUN: process.env.APPIMAGE_EXTRACT_AND_RUN ?? '1',
    },
  });
  console.log(`Created ${appImagePath}`);
}

function main() {
  ensureEmptyDir(outRoot);
  fs.mkdirSync(appRoot, { recursive: true });

  stageRuntimeFiles();
  buildSeaBinary();

  if (platform === 'win32') {
    packageWindows();
  } else if (platform === 'darwin') {
    packageMac();
  } else if (platform === 'linux') {
    packageLinux();
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  console.log(`SEA build output: ${outRoot}`);
}

main();
