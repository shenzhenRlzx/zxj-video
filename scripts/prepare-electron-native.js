#!/usr/bin/env node
/**
 * 准备原生模块二进制（跨平台）。
 *
 * - better-sqlite3：用 prebuild-install 按 Electron ABI 下载预编译二进制。
 *   默认准备"当前平台"；交叉打包 Windows 时传 --win（等价 win32-x64）。
 *   注意：本项目 electron-builder 配置了 npmRebuild=false，二进制必须提前放好。
 * - serialport（@serialport/bindings-cpp）：node-gyp-build 的 prebuilds 自带全平台
 *   二进制（含 win32-x64），无需处理。
 *
 * 用法：
 *   node scripts/prepare-electron-native.js          # 当前平台（本机调试）
 *   node scripts/prepare-electron-native.js --win    # 交叉打包 Windows 前调用
 *
 * 网络不好时可走国内镜像（prebuild-install 识别 npm config env）：
 *   npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const wantWin = process.argv.includes('--win');
const platform = wantWin ? 'win32' : process.platform;
const arch = wantWin ? 'x64' : process.arch;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const electronVersion = readJson(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const bs3Dir = path.join(root, 'node_modules', 'better-sqlite3');
const bs3Pkg = readJson(path.join(bs3Dir, 'package.json'));

console.log(`[prepare-native] target=${platform}-${arch} electron=${electronVersion} better-sqlite3=${bs3Pkg.version}`);

const args = [
  'prebuild-install',
  '-r', 'electron',
  '-t', electronVersion,
  '--platform', platform,
  '--arch', arch,
  '--verbose'
];

// shell:true 统一处理 npx 在不同平台的可执行方式
const res = spawnSync('npx', args, { cwd: bs3Dir, stdio: 'inherit', shell: true });

if (res.status !== 0) {
  console.error('[prepare-native] better-sqlite3 预编译下载失败。');
  console.error('网络受限时可配置国内镜像后重试：');
  console.error('  npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3');
  process.exit(res.status == null ? 1 : res.status);
}

console.log('[prepare-native] done');
