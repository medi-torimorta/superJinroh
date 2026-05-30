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
const exePath = path.join(outRoot, exeName);

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

function waitForRetry(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function removePathWithRetry(targetPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || (error.code !== 'EBUSY' && error.code !== 'EPERM')) {
        throw error;
      }
      lastError = error;
      waitForRetry(150);
    }
  }
  if (lastError) {
    throw lastError;
  }
}

function ensureEmptyDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    removePathWithRetry(path.join(dirPath, entry.name));
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function packageNameToPath(packageName) {
  return path.join(...packageName.split('/'));
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function collectRuntimeDependencyNames(tree, names = new Set()) {
  if (!tree || typeof tree !== 'object') {
    return names;
  }

  for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
    names.add(name);
    collectRuntimeDependencyNames(dependency, names);
  }

  return names;
}

function getServerRuntimeDependencyNames() {
  const lockfile = readJsonFile(path.join(productRoot, 'package-lock.json'));
  const serverPackage = readJsonFile(path.join(productRoot, 'server', 'package.json'));
  const packageEntries = lockfile.packages ?? {};
  const names = new Set();

  function visitPackage(packageName) {
    if (names.has(packageName)) {
      return;
    }
    names.add(packageName);

    const packageEntry = packageEntries[`node_modules/${packageNameToPath(packageName)}`];
    for (const dependencyName of Object.keys(packageEntry?.dependencies ?? {})) {
      visitPackage(dependencyName);
    }
  }

  for (const dependencyName of Object.keys(serverPackage.dependencies ?? {})) {
    visitPackage(dependencyName);
  }

  return Array.from(names).sort();
}

function copySharedRuntimePackage(targetPackageDir) {
  ensureEmptyDir(targetPackageDir);
  copyDirRecursive(path.join(productRoot, 'shared', 'dist'), path.join(targetPackageDir, 'dist'));
  copyFileIfExists(path.join(productRoot, 'shared', 'package.json'), path.join(targetPackageDir, 'package.json'));
}

function stageRuntimeNodeModules(targetNodeModulesDir) {
  ensureDir(targetNodeModulesDir);

  for (const packageName of getServerRuntimeDependencyNames()) {
    const packageRelativePath = packageNameToPath(packageName);
    const targetPackageDir = path.join(targetNodeModulesDir, packageRelativePath);

    if (packageName === '@super-jinroh/shared') {
      copySharedRuntimePackage(targetPackageDir);
      continue;
    }

    const sourcePackageDir = path.join(productRoot, 'node_modules', packageRelativePath);
    if (!fs.existsSync(sourcePackageDir)) {
      throw new Error(`Runtime dependency package not found: ${packageName}`);
    }
    copyDirRecursive(sourcePackageDir, targetPackageDir);
  }

  const prismaClientDir = path.join(productRoot, 'node_modules', '.prisma', 'client');
  if (fs.existsSync(prismaClientDir)) {
    copyDirRecursive(prismaClientDir, path.join(targetNodeModulesDir, '.prisma', 'client'));
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
  copyDirRecursive(path.join(productRoot, 'server', 'dist'), path.join(outRoot, 'server', 'dist'));
  copyDirRecursive(path.join(productRoot, 'server', 'data'), path.join(outRoot, 'server', 'data'));
  removePathWithRetry(path.join(outRoot, 'server', 'data', 'config.json'));
  copyFileIfExists(path.join(productRoot, 'server', 'data', 'config.json'), path.join(outRoot, 'config.json'));
  copyDirRecursive(path.join(productRoot, 'client', 'dist'), path.join(outRoot, 'client', 'dist'));
  stageRuntimeNodeModules(path.join(outRoot, 'node_modules'));

  const serverPackageJsonPath = path.join(productRoot, 'server', 'package.json');
  if (fs.existsSync(serverPackageJsonPath)) {
    fs.mkdirSync(path.join(outRoot, 'server'), { recursive: true });
    fs.copyFileSync(serverPackageJsonPath, path.join(outRoot, 'server', 'package.json'));
  }
}

function copyFileIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function stageArchiveRoot() {
  const archiveRootParent = path.join(outRoot, '.archive');
  const archiveRoot = path.join(archiveRootParent, 'superjinroh');
  ensureEmptyDir(archiveRootParent);
  ensureDir(archiveRoot);
  copyFileIfExists(exePath, path.join(archiveRoot, exeName));
  copyFileIfExists(path.join(outRoot, 'config.json'), path.join(archiveRoot, 'config.json'));
  copyDirRecursive(path.join(outRoot, 'server'), path.join(archiveRoot, 'server'));
  copyDirRecursive(path.join(outRoot, 'client'), path.join(archiveRoot, 'client'));
  copyDirRecursive(path.join(outRoot, 'node_modules'), path.join(archiveRoot, 'node_modules'));
  return { archiveRootParent, archiveRoot };
}

function cleanupArchiveRoot(archiveRootParent) {
  removePathWithRetry(archiveRootParent);
}

function cleanBuildOutput() {
  ensureDir(outRoot);
  for (const name of [exeName, 'config.json', 'server', 'client', 'node_modules', '.archive']) {
    const targetPath = path.join(outRoot, name);
    if (fs.existsSync(targetPath)) {
      removePathWithRetry(targetPath);
    }
  }
}

function resolveArchiveOutputPath(preferredPath) {
  try {
    removePathWithRetry(preferredPath);
    return preferredPath;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error.code !== 'EBUSY' && error.code !== 'EPERM')) {
      throw error;
    }

    const parsedPath = path.parse(preferredPath);
    const archiveName = parsedPath.ext === '.gz'
      ? parsedPath.base.replace(/\.tar\.gz$/, '')
      : parsedPath.name;
    const archiveExtension = parsedPath.ext === '.gz' ? '.tar.gz' : parsedPath.ext;
    const fallbackPath = path.join(parsedPath.dir, `${archiveName}-${Date.now()}${archiveExtension}`);
    console.warn(`Archive output is locked; writing to ${fallbackPath} instead of ${preferredPath}.`);
    return fallbackPath;
  }
}

function packageWindowsArchive() {
  const archivePath = resolveArchiveOutputPath(path.join(outRoot, `superjinroh-${platform}-${arch}.zip`));
  const { archiveRootParent } = stageArchiveRoot();
  try {
    run(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path "${path.join(archiveRootParent, 'superjinroh')}" -DestinationPath "${archivePath}" -Force`,
      ],
      { cwd: outRoot },
    );
  } finally {
    cleanupArchiveRoot(archiveRootParent);
  }
  console.log(`Created ${archivePath}`);
}

function packageMacArchive() {
  const archivePath = resolveArchiveOutputPath(path.join(outRoot, `superjinroh-${platform}-${arch}.zip`));
  const { archiveRootParent } = stageArchiveRoot();
  try {
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(archiveRootParent, 'superjinroh'), archivePath]);
  } finally {
    cleanupArchiveRoot(archiveRootParent);
  }
  console.log(`Created ${archivePath}`);
}

function packageLinuxArchive() {
  const archivePath = resolveArchiveOutputPath(path.join(outRoot, `superjinroh-${platform}-${arch}.tar.gz`));
  const { archiveRootParent } = stageArchiveRoot();
  try {
    run('tar', ['-czf', archivePath, 'superjinroh'], { cwd: archiveRootParent });
  } finally {
    cleanupArchiveRoot(archiveRootParent);
  }
  console.log(`Created ${archivePath}`);
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
  packageWindowsArchive();
}

function packageMac() {
  packageMacArchive();
}

function packageLinux() {
  packageLinuxArchive();
}

async function main() {
  cleanBuildOutput();

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