import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Data, NtExecutable, NtExecutableResource, Resource, calculateCheckSumForPE } from '@shockpkg/resedit';

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

const assetsDir = path.join(productRoot, 'scripts', 'release', 'assets');
const packageJson = JSON.parse(fs.readFileSync(path.join(productRoot, 'package.json'), 'utf8'));
const appVersion = String(packageJson.version ?? '0.0.0');

function toWindowsVersion(version) {
  const core = version.split('-')[0];
  const parts = core.split('.').map((entry) => Number.parseInt(entry, 10));
  while (parts.length < 4) {
    parts.push(0);
  }
  return parts.slice(0, 4).map((entry) => (Number.isFinite(entry) ? entry : 0)).join('.');
}

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

function ensureCustomRoleSetDir(baseDir) {
  const customDir = path.join(baseDir, 'role-sets', 'custom');
  fs.mkdirSync(customDir, { recursive: true });
  const gitkeepPath = path.join(customDir, '.gitkeep');
  if (!fs.existsSync(gitkeepPath)) {
    fs.writeFileSync(gitkeepPath, '');
  }
}

function readPngDimensions(pngBuffer) {
  const pngSignature = '89504e470d0a1a0a';
  if (pngBuffer.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error('Invalid PNG signature for Windows icon asset.');
  }
  if (pngBuffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('PNG IHDR chunk was not found for Windows icon asset.');
  }
  return {
    width: pngBuffer.readUInt32BE(16),
    height: pngBuffer.readUInt32BE(20),
  };
}

async function applyWindowsExecutableResources(targetExePath) {
  if (platform !== 'win32') {
    return;
  }

  const pngPath = path.join(assetsDir, 'superjinroh.png');
  const exeBuffer = fs.readFileSync(targetExePath);
  const exeBinary = exeBuffer.buffer.slice(exeBuffer.byteOffset, exeBuffer.byteOffset + exeBuffer.byteLength);
  const executable = NtExecutable.from(exeBinary, { ignoreCert: true });
  const resources = NtExecutableResource.from(executable, true);
  const versionLang = 1033;
  const versionCodepage = 1200;
  const version = toWindowsVersion(appVersion);

  if (fs.existsSync(pngPath)) {
    const pngBuffer = fs.readFileSync(pngPath);
    const pngBinary = pngBuffer.buffer.slice(pngBuffer.byteOffset, pngBuffer.byteOffset + pngBuffer.byteLength);
    const { width, height } = readPngDimensions(pngBuffer);
    const iconItem = Data.RawIconItem.from(pngBinary, width, height, 32);
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, versionLang, [iconItem]);
  }

  const versionInfo = Resource.VersionInfo.create({
    lang: versionLang,
    fixedInfo: {
      fileOS: Resource.VersionFileOS.NT_Windows32,
      fileType: Resource.VersionFileType.App,
    },
    strings: [{
      lang: versionLang,
      codepage: versionCodepage,
      values: {
        FileDescription: 'superJinroh',
        InternalFilename: 'superjinroh.exe',
        OriginalFilename: 'superjinroh.exe',
        ProductName: 'superJinroh',
      },
    }],
  });
  versionInfo.setFileVersion(version, versionLang);
  versionInfo.setProductVersion(version, versionLang);
  versionInfo.outputToResourceEntries(resources.entries);

  resources.outputResource(executable, false, true);
  const generatedBinary = executable.generate();
  calculateCheckSumForPE(generatedBinary, true);
  fs.writeFileSync(targetExePath, Buffer.from(generatedBinary));
  console.log(`Embedded Windows icon and version metadata into ${targetExePath}`);
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

async function buildSeaBinary() {
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

  if (platform === 'win32') {
    await applyWindowsExecutableResources(exePath);
  }
}

async function packageWindows() {
  const releaseExe = path.join(outRoot, 'superjinroh.exe');
  fs.copyFileSync(exePath, releaseExe);
  ensureCustomRoleSetDir(outRoot);
  console.log(`Created ${releaseExe}`);
}

function packageMac() {
  const icnsPath = path.join(assetsDir, 'superjinroh.icns');
  const dmgPath = path.join(outRoot, 'superjinroh.dmg');

  if (fs.existsSync(icnsPath)) {
    // UDRW (read-write) DMG を作り、ボリュームアイコンを設定後に UDZO に変換する
    const rwDmg = `${dmgPath}.rw.dmg`;
    run('hdiutil', ['create', '-volname', 'superJinroh', '-srcfolder', appRoot, '-ov', '-format', 'UDRW', '-o', `${dmgPath}.rw`]);

    const attachResult = spawnSync('hdiutil', ['attach', rwDmg, '-readwrite', '-noverify', '-noautoopen']);
    const attachOut = (attachResult.stdout ?? Buffer.alloc(0)).toString();
    const mountMatch = attachOut.match(/\/Volumes\/[^\n]+/);
    const mountPoint = mountMatch?.[0]?.trim();

    if (mountPoint) {
      fs.copyFileSync(icnsPath, path.join(mountPoint, '.VolumeIcon.icns'));
      const sf = spawnSync('SetFile', ['-a', 'C', mountPoint]);
      if (sf.status !== 0) {
        spawnSync('xattr', ['-wx', 'com.apple.FinderInfo',
          '0000000000000000040000000000000000000000000000000000000000000000',
          mountPoint]);
      }
      spawnSync('hdiutil', ['detach', mountPoint]);
    } else {
      console.warn('DMG mount point not found - volume icon not applied.');
      spawnSync('hdiutil', ['detach', '-force', rwDmg]);
    }

    run('hdiutil', ['convert', rwDmg, '-format', 'UDZO', '-o', dmgPath]);
    fs.rmSync(rwDmg, { force: true });
  } else {
    run('hdiutil', ['create', '-volname', 'superJinroh', '-srcfolder', appRoot, '-ov', '-format', 'UDZO', dmgPath]);
  }

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

  // PNG を AppDir 直下にコピーして .desktop の Icon 名と一致させる
  const pngSrc = path.join(assetsDir, 'superjinroh.png');
  if (fs.existsSync(pngSrc)) {
    fs.copyFileSync(pngSrc, path.join(appDir, 'superjinroh.png'));
  }

  fs.writeFileSync(
    path.join(appDir, 'superjinroh.desktop'),
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=superJinroh',
      'Exec=superjinroh',
      'Icon=superjinroh',
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
  ensureCustomRoleSetDir(outRoot);
  console.log(`Created ${appImagePath}`);
}

async function main() {
  ensureEmptyDir(outRoot);
  fs.mkdirSync(appRoot, { recursive: true });
  ensureCustomRoleSetDir(appRoot);

  stageRuntimeFiles();
  await buildSeaBinary();

  if (platform === 'win32') {
    await packageWindows();
  } else if (platform === 'darwin') {
    packageMac();
  } else if (platform === 'linux') {
    packageLinux();
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  console.log(`SEA build output: ${outRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});