// Downloads a static FFmpeg build and places it where Tauri expects the sidecar:
// src-tauri/bin/ffmpeg-<target-triple>[.exe]

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(root, 'src-tauri', 'bin');

function targetForHost() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') {
    return {
      file: 'ffmpeg-x86_64-pc-windows-msvc.exe',
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
      archiveName: 'ffmpeg.zip',
      extract: 'zip',
      binary: 'ffmpeg.exe',
    };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      file: 'ffmpeg-aarch64-apple-darwin',
      url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip',
      archiveName: 'ffmpeg.zip',
      extract: 'zip',
      binary: 'ffmpeg',
    };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return {
      file: 'ffmpeg-x86_64-apple-darwin',
      url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip',
      archiveName: 'ffmpeg.zip',
      extract: 'zip',
      binary: 'ffmpeg',
    };
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      file: 'ffmpeg-x86_64-unknown-linux-gnu',
      url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
      archiveName: 'ffmpeg.tar.xz',
      extract: 'tarxz',
      binary: 'ffmpeg',
    };
  }
  throw new Error(`No FFmpeg build is set up for ${platform} ${arch}.`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', (err) => reject(new Error(`${command} failed to start: ${err.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download FFmpeg (${response.status} ${response.statusText}).`);
  }
  await pipeline(response.body, createWriteStream(dest));
}

async function findBinary(dir, name) {
  const matches = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === name) matches.push(full);
    }
  }
  await walk(dir);
  return matches.find((file) => path.basename(path.dirname(file)) === 'bin') || matches[0] || null;
}

async function alreadyInstalled(dest) {
  try {
    const info = await stat(dest);
    return info.isFile() && info.size > 1_000_000;
  } catch {
    return false;
  }
}

async function main() {
  const spec = targetForHost();
  const dest = path.join(binDir, spec.file);
  if (await alreadyInstalled(dest)) {
    console.log(`FFmpeg sidecar already present: ${path.relative(root, dest)}`);
    return;
  }
  await mkdir(binDir, { recursive: true });
  const temp = path.join(os.tmpdir(), `y2k-vj-ffmpeg-${process.pid}`);
  await mkdir(temp, { recursive: true });
  const archive = path.join(temp, spec.archiveName);
  const extracted = path.join(temp, 'out');
  try {
    console.log(`Downloading FFmpeg for ${process.platform} ${process.arch}...`);
    await download(spec.url, archive);
    await mkdir(extracted, { recursive: true });
    if (spec.extract === 'zip') await run('tar', ['-xf', archive, '-C', extracted]);
    else await run('tar', ['-xJf', archive, '-C', extracted]);
    const found = await findBinary(extracted, spec.binary);
    if (!found) throw new Error(`The FFmpeg archive did not contain ${spec.binary}.`);
    await copyFile(found, dest);
    if (process.platform !== 'win32') await chmod(dest, 0o755);
    await access(dest);
    console.log(`Installed ${path.relative(root, dest)}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
