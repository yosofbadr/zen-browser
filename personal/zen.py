#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Build and install this Zen fork on one Apple Silicon Mac."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time

STATE = Path.home() / 'Library/Application Support/Zen Personal'
APPS = Path.home() / 'Applications'
BUILD_ROOT = Path.home() / '.local/share/zen-personal/builds'
LABEL = 'app.yosofb.zen-personal.builder'
ENV = dict(os.environ, PATH='/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:' + os.environ.get('PATH', '') )


def run(*args, cwd=None, capture=False):
    return subprocess.run(args, cwd=cwd, env=ENV, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def read_config():
    return json.loads((STATE / 'config.json').read_text())


def write_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.replace(path)


def managed_checkout(repo, channel, commit):
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    checkout = BUILD_ROOT / channel
    if not checkout.exists():
        run('git', 'worktree', 'add', '--detach', str(checkout), commit, cwd=repo)
        (checkout / '.surfer').mkdir(exist_ok=True)
        (checkout / '.surfer/personal-managed').touch()
    if not (checkout / '.surfer/personal-managed').exists():
        raise RuntimeError(f'Refusing to reset an unmanaged checkout: {checkout}')
    # Existing build worktrees can belong to the old snapshot repository.
    # Import the requested commit without moving their native build caches.
    run('git', 'fetch', '--no-tags', str(repo), commit, cwd=checkout)
    run('git', 'reset', '--hard', commit, cwd=checkout)
    run('git', 'clean', '-fd', cwd=checkout)
    return checkout


def snapshot_patched_files(engine):
    names = run('git', 'diff', 'HEAD', '--name-only', '-z', cwd=engine, capture=True)
    paths = {engine / name for name in names.split('\0') if name}
    # Surfer copies Zen's source into this ignored directory on every import.
    paths.update((engine / 'zen').rglob('*'))
    snapshot = {}
    for path in paths:
        if path.is_file():
            stat = path.stat()
            snapshot[path] = (path.read_bytes(), stat.st_atime_ns, stat.st_mtime_ns)
    return snapshot


def restore_unchanged_timestamps(snapshot):
    # Reapplying identical upstream patches must not invalidate native caches.
    # Changed or removed files retain their new timestamps.
    for path, (content, atime, mtime) in snapshot.items():
        if path.is_file() and path.read_bytes() == content:
            os.utime(path, ns=(atime, mtime))


def native_inputs(checkout):
    """Conservative fingerprint of sources that may affect the native binary."""
    names = run('git', 'ls-files', '--cached', '--others', '--exclude-standard',
                '-z', cwd=checkout, capture=True)
    digest = hashlib.sha256()
    for name in sorted(set(names.split('\0')) | {'mozconfig'}):
        if not name or name.startswith(('personal/', 'locales/', 'scripts/tests/',
                                       '.github/', 'configs/branding/personal/',
                                       'configs/branding/personal-nightly/')):
            continue
        path = checkout / name
        if path.suffix == '.md' or (name.startswith('src/zen/') and
                                   path.suffix in {'.js', '.mjs', '.css', '.ftl'}):
            continue
        digest.update(name.encode() + b'\0')
        digest.update(path.read_bytes() if path.is_file() else b'<removed>')
    return digest.hexdigest()


def build(checkout, channel):
    run('npm', 'ci', cwd=checkout)
    run('node', '--test', 'scripts/tests/site-search.test.mjs',
        'scripts/tests/mods-marketplace.test.mjs', cwd=checkout)
    run(sys.executable, '-m', 'unittest', 'discover', '-s', 'personal',
        '-p', 'test_*.py', cwd=checkout)
    original = (checkout / 'surfer.json').read_text()
    (checkout / 'mozconfig').write_text('ac_add_options --disable-updater\n'
                                       'mk_add_options MOZ_MAKE_FLAGS="-j8"\n')
    fingerprint = native_inputs(checkout)
    config = json.loads(original)
    title = 'Zen Personal' if channel == 'main' else 'Zen Personal Nightly'
    brand = 'personal' if channel == 'main' else 'personal-nightly'
    config['appId'] = 'app.yosofb.' + brand
    config['brands'][brand] = dict(config['brands']['release'],
                                   brandShorterName=title, brandShortName=title,
                                   brandFullName=title)
    config['updateHostname'] = 'localhost:9'
    branding = checkout / 'configs/branding' / brand
    if not branding.exists():
        shutil.copytree(checkout / 'configs/branding/release', branding)
    (checkout / 'surfer.json').write_text(json.dumps(config, indent=2) + '\n')
    try:
        marker = checkout / '.surfer/personal-engine-version'
        version = json.dumps(config['version'], sort_keys=True)
        engine = checkout / 'engine'
        if engine.exists() and (not marker.exists() or marker.read_text() != version):
            shutil.rmtree(engine)
        if not engine.exists():
            peer = BUILD_ROOT / ('nightly' if channel == 'main' else 'main')
            peer_marker = peer / '.surfer/personal-engine-version'
            if (peer / 'engine/.git').exists() and peer_marker.exists() and peer_marker.read_text() == version:
                # Copy the pristine committed source, not the peer's patched worktree.
                # No alternates or hardlinks: future engine replacement stays independent.
                run('git', 'clone', '--no-hardlinks', str(peer / 'engine'), str(engine))
                marker.write_text(version)
        if not engine.exists():
            cache = checkout / '.surfer/engine'
            cache.mkdir(parents=True, exist_ok=True)
            source_cache = Path(read_config()['sourceCache'])
            for archive in source_cache.glob('firefox-*.source.tar.xz'):
                target = cache / archive.name
                if not target.exists():
                    os.link(archive, target)
            run('npm', 'run', 'download', cwd=checkout)
            marker.write_text(version)
        snapshot = snapshot_patched_files(engine)
        run('git', 'reset', '--hard', cwd=engine)
        run('git', 'clean', '-fd', cwd=engine)
        run('npm', 'run', 'surfer', '--', 'set', 'brand', brand, cwd=checkout)
        run('npm', 'run', 'import', cwd=checkout)
        run(sys.executable, 'scripts/update_en_US_packs.py', cwd=checkout)
        restore_unchanged_timestamps(snapshot)
        run(str(engine / 'mach'), 'lint', '-l', 'eslint',
            'zen/urlbar/ZenSiteSearch.sys.mjs',
            'zen/urlbar/ZenSiteSearchRegistry.sys.mjs',
            'zen/urlbar/ZenUBSiteSearchProvider.sys.mjs',
            'zen/common/sys/ZenActorsManager.sys.mjs', cwd=engine)
        app = engine / 'obj-aarch64-apple-darwin/dist' / (title + '.app')
        native_marker = checkout / '.surfer/personal-native-inputs'
        fast = ((app / 'Contents/MacOS/zen').exists() and native_marker.exists()
                and native_marker.read_text().strip() == fingerprint)
        print('Building UI resources' if fast else 'Building native browser', flush=True)
        run('npm', 'run', 'build:ui' if fast else 'build', cwd=checkout)
        native_marker.write_text(fingerprint + '\n')
        run(str(engine / 'mach'), 'mochitest',
            'zen/tests/urlbar/browser_site_search.js',
            'zen/tests/urlbar/browser_sidebar_provider.js',
            'zen/tests/urlbar/browser_floating_urlbar.js', '--headless', cwd=engine)
        if not (app / 'Contents/MacOS/zen').exists():
            raise RuntimeError(f'Build did not produce {app}')
        return app
    finally:
        (checkout / 'surfer.json').write_text(original)


def stage_app(source, channel, commit):
    title = 'Zen Personal' if channel == 'main' else 'Zen Personal Nightly'
    # The installer only reads pending-*.app. Failed copying or signing must
    # never expose an incomplete bundle at that path.
    pending = STATE / ('incoming-' + channel + '.app')
    if pending.exists():
        shutil.rmtree(pending)
    # Development bundles contain links back to the build. Install real files.
    shutil.copytree(source, pending, symlinks=False)
    profile = STATE / ('profile' if channel == 'main' else 'nightly-profile')
    profile.mkdir(parents=True, exist_ok=True)
    wrapper = pending / 'Contents/MacOS/personal-launcher'
    wrapper.write_text('#!/bin/sh\n'
                       'export MOZ_DISABLE_SAFE_MODE_KEY=1\n'
                       'app_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n'
                       'exec "$app_dir/zen" --profile ' + shell_quote(str(profile)) + ' "$@"\n')
    wrapper.chmod(0o755)
    info = pending / 'Contents/Info.plist'
    with info.open('rb') as handle:
        data = plistlib.load(handle)
    data['CFBundleExecutable'] = 'personal-launcher'
    data['CFBundleName'] = title
    data['CFBundleDisplayName'] = title
    with info.open('wb') as handle:
        plistlib.dump(data, handle)
    distribution = pending / 'Contents/Resources/distribution'
    distribution.mkdir(exist_ok=True)
    policies = {'DisableAppUpdate': True}
    if channel == 'nightly':
        policies['DisableFirefoxAccounts'] = True
    write_json(distribution / 'policies.json', {'policies': policies})
    (pending / 'Contents/Resources/personal-commit.txt').write_text(commit + '\n')
    run('codesign', '--force', '--deep', '--sign', '-', str(pending))
    run('codesign', '--verify', '--deep', '--strict', str(pending))
    ready = STATE / ('pending-' + channel + '.app')
    if ready.exists():
        shutil.rmtree(ready)
    pending.rename(ready)
    return ready


def shell_quote(value):
    import shlex
    return shlex.quote(value)


def app_running(app):
    processes = run('ps', '-axo', 'command=', capture=True)
    return any(str(app / 'Contents/MacOS') + '/' in line for line in processes.splitlines())


def invalidate_profile_caches(channel):
    # UI-only builds can keep Firefox's native build ID. Cached chrome scripts
    # would otherwise survive an update and hide the newly installed changes.
    profile = STATE / ('profile' if channel == 'main' else 'nightly-profile')
    cache = profile / 'startupCache'
    if cache.exists():
        backup = STATE / ('previous-' + channel + '-startupCache')
        if backup.exists():
            shutil.rmtree(backup)
        cache.rename(backup)


def install_pending(channel):
    title = 'Zen Personal' if channel == 'main' else 'Zen Personal Nightly'
    pending = STATE / ('pending-' + channel + '.app')
    app = APPS / (title + '.app')
    if not pending.exists():
        return False
    if app_running(app):
        print(f'{title} update ready. Quit the app to install it.', flush=True)
        return False
    invalidate_profile_caches(channel)
    APPS.mkdir(exist_ok=True)
    backup = STATE / ('previous-' + channel + '.app')
    if backup.exists():
        shutil.rmtree(backup)
    if app.exists():
        app.rename(backup)
    try:
        pending.rename(app)
    except Exception:
        if backup.exists():
            backup.rename(app)
        raise
    run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', '-f', str(app))
    print(f'Installed {app}', flush=True)
    return True


def tick():
    config = read_config()
    repo = Path(config['repo'])
    install_pending('main')
    run('git', 'fetch', 'origin', 'main', cwd=repo)
    commit = run('git', 'rev-parse', 'origin/main', cwd=repo, capture=True).strip()
    completed = STATE / 'built-main.txt'
    if completed.exists() and completed.read_text().strip() == commit:
        return
    checkout = managed_checkout(repo, 'main', commit)
    print(f'Building main {commit}', flush=True)
    source = build(checkout, 'main')
    stage_app(source, 'main', commit)
    completed.write_text(commit + '\n')
    install_pending('main')


def refresh_nightly_profile():
    for title in ['Zen Personal', 'Zen Personal Nightly']:
        if app_running(APPS / (title + '.app')):
            raise RuntimeError(f'Quit {title} before copying its profile.')
    source = STATE / 'profile'
    target = STATE / 'nightly-profile'
    pending = STATE / 'nightly-profile-copy'
    backup = STATE / 'nightly-profile-previous'
    if not source.exists():
        raise RuntimeError('The daily profile has not been initialized.')
    if pending.exists():
        shutil.rmtree(pending)
    shutil.copytree(source, pending,
                    ignore=shutil.ignore_patterns('parent.lock', '.parentlock', 'lock'))
    if backup.exists():
        shutil.rmtree(backup)
    if target.exists():
        target.rename(backup)
    try:
        pending.rename(target)
    except Exception:
        if backup.exists():
            backup.rename(target)
        raise
    print('Nightly profile refreshed from Zen Personal.', flush=True)


def nightly():
    repo = Path(read_config()['repo'])
    commit = run('git', 'rev-parse', 'HEAD', cwd=repo, capture=True).strip()
    checkout = managed_checkout(repo, 'nightly', commit)
    patch = run('git', 'diff', '--binary', 'HEAD', cwd=repo, capture=True)
    if patch:
        subprocess.run(['git', 'apply', '-'], cwd=checkout, input=patch, text=True, check=True)
    untracked = run('git', 'ls-files', '--others', '--exclude-standard', '-z', cwd=repo, capture=True)
    for name in untracked.split('\0'):
        if name:
            target = checkout / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(repo / name, target)
    if app_running(APPS / 'Zen Personal Nightly.app'):
        raise RuntimeError('Quit Zen Personal Nightly before rebuilding it.')
    source = build(checkout, 'nightly')
    stage_app(source, 'nightly', commit + '-working-tree')
    install_pending('nightly')
    run('open', '-a', str(APPS / 'Zen Personal Nightly.app'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['tick', 'watch', 'nightly', 'status'])
    parser.add_argument('--refresh-profile', action='store_true',
                        help='Copy the closed daily profile into Nightly before testing')
    args = parser.parse_args()
    if args.refresh_profile and args.command != 'nightly':
        parser.error('--refresh-profile requires nightly')
    STATE.mkdir(parents=True, exist_ok=True)
    if args.command == 'status':
        for name in ['built-main.txt', 'pending-main.app', 'profile', 'nightly-profile']:
            path = STATE / name
            print(f'{name}: {path.read_text().strip() if path.is_file() else path.exists()}')
        return
    lock = (STATE / ('nightly.lock' if args.command == 'nightly' else 'builder.lock')).open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('A build is already running.')
    if args.command == 'watch':
        while True:
            try:
                tick()
            except Exception as error:
                print(f'Update failed; keeping installed app: {error}', flush=True)
                time.sleep(240)
            time.sleep(60)
    elif args.command == 'tick':
        tick()
    else:
        if args.refresh_profile:
            refresh_nightly_profile()
        nightly()


if __name__ == '__main__':
    main()
