/**
 * Everything that differs between macOS, Linux and Windows on the machine the
 * mapper runs on lives here, so the rest of the server never has to ask.
 *
 * The targets themselves are always Linux boxes reached over SSH (or Docker),
 * so remote commands do not depend on the local OS. What does: the Python
 * binary name, the Docker socket, the local shell, SSH key paths and key
 * permissions, and how a child Node process is launched.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

/**
 * Normalise a key path typed into the UI or stored in remote_config.json on a
 * different machine: strips surrounding quotes, expands `~/`, `~\`, `$HOME`
 * and `%USERPROFILE%`. If the file is not there, looks for a file with the same
 * name in the usual places (~/.ssh, ~/Downloads, ~/Desktop, ~/Documents), so a
 * config written on Windows still works on a Mac and vice versa.
 */
export function resolveKeyPath(raw: string | undefined | null): string {
  let p = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!p) return p;
  const home = os.homedir();
  if (p === '~') p = home;
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2));
  p = p.replace(/^\$HOME(?=[\\/]|$)/, home).replace(/^%USERPROFILE%(?=[\\/]|$)/i, home);
  if (fs.existsSync(p)) return path.resolve(p);

  // Same file name, different machine: C:\Users\me\Downloads\k.pem -> ~/Downloads/k.pem
  const base = p.split(/[\\/]/).pop() || '';
  if (base) {
    for (const dir of ['.ssh', 'Downloads', 'Desktop', 'Documents', '']) {
      const candidate = path.join(home, dir, base);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return p; // let the caller report the missing file with the path the user gave
}

/**
 * OpenSSH (macOS/Linux) refuses a private key that others can read, which is
 * exactly how a freshly downloaded .pem arrives. The ssh2 library used for
 * discovery does not care, but the interactive terminal shells out to `ssh`.
 * Rather than chmod the user's file behind their back, hand ssh a private copy.
 */
export function keyPathForOpenSSH(keyPath: string): string {
  if (IS_WINDOWS || !keyPath) return keyPath;
  try {
    const st = fs.statSync(keyPath);
    if ((st.mode & 0o077) === 0) return keyPath;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-key-'));
    const copy = path.join(dir, path.basename(keyPath));
    fs.copyFileSync(keyPath, copy);
    fs.chmodSync(copy, 0o600);
    return copy;
  } catch {
    return keyPath;
  }
}

let pythonCache: string | null = null;
/**
 * `python3` on macOS/Linux, usually `python` or `py` on Windows. Override with
 * MAPPER_PYTHON (for example a virtualenv's interpreter).
 */
export function pythonCmd(): string {
  if (process.env.MAPPER_PYTHON) return process.env.MAPPER_PYTHON;
  if (pythonCache) return pythonCache;
  const candidates = IS_WINDOWS ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`)) return (pythonCache = c);
    } catch { /* try the next one */ }
  }
  return (pythonCache = candidates[0]);
}

/** The local interactive shell for the in-app terminal. */
export function localShell(): { cmd: string; args: string[] } {
  if (IS_WINDOWS) return { cmd: 'powershell.exe', args: ['-NoLogo'] };
  const sh = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : (IS_MAC ? '/bin/zsh' : 'bash');
  return { cmd: sh, args: ['-l'] };
}

/**
 * Options for dockerode. DOCKER_HOST wins (dockerode reads it itself); then the
 * platform default. Docker Desktop on macOS only creates /var/run/docker.sock
 * when "Allow the default Docker socket" is on, otherwise the socket lives in
 * ~/.docker/run/docker.sock. Windows uses the named pipe.
 */
export function dockerOptions(): { socketPath?: string } {
  if (process.env.DOCKER_HOST) return {};
  if (IS_WINDOWS) return { socketPath: '//./pipe/docker_engine' };
  const candidates = ['/var/run/docker.sock', path.join(os.homedir(), '.docker', 'run', 'docker.sock'), path.join(os.homedir(), '.colima', 'default', 'docker.sock')];
  return { socketPath: candidates.find((s) => fs.existsSync(s)) ?? candidates[0] };
}
