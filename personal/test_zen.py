# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('zen', Path(__file__).with_name('zen.py'))
zen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zen)


class UpdateTests(unittest.TestCase):
    def test_existing_build_checkout_accepts_fork_history_and_preserves_cache(self):
        root = Path(self.temp.name)
        for name in ['snapshot', 'fork']:
            repo = root / name
            repo.mkdir()
            zen.run('git', 'init', '-q', cwd=repo)
            (repo / '.gitignore').write_text('.surfer/\nengine/\n')
            (repo / 'source').write_text(name)
            zen.run('git', 'add', '.', cwd=repo)
            zen.run('git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
                    'commit', '-qm', name, cwd=repo)
        builds = root / 'builds'
        with patch.object(zen, 'BUILD_ROOT', builds):
            old = zen.run('git', 'rev-parse', 'HEAD', cwd=root / 'snapshot', capture=True).strip()
            checkout = zen.managed_checkout(root / 'snapshot', 'nightly', old)
            (checkout / 'engine').mkdir()
            cache = checkout / 'engine/cache.o'
            cache.write_text('native build cache')
            new = zen.run('git', 'rev-parse', 'HEAD', cwd=root / 'fork', capture=True).strip()
            zen.managed_checkout(root / 'fork', 'nightly', new)
            self.assertEqual((checkout / 'source').read_text(), 'fork')
            self.assertEqual(cache.read_text(), 'native build cache')
            self.assertEqual(zen.run('git', 'rev-parse', 'HEAD', cwd=checkout, capture=True).strip(), new)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.state = root / 'state'
        self.apps = root / 'apps'
        self.state.mkdir()
        self.apps.mkdir()
        for attr, value in [('STATE', self.state), ('APPS', self.apps)]:
            context = patch.object(zen, attr, value)
            context.start()
            self.addCleanup(context.stop)
        self.app = self.apps / 'Zen Personal.app'
        self.app.mkdir()
        (self.app / 'version').write_text('old')
        self.pending = self.state / 'pending-main.app'
        self.pending.mkdir()
        (self.pending / 'version').write_text('new')

    def test_running_browser_defers_install(self):
        with patch.object(zen, 'app_running', return_value=True):
            self.assertFalse(zen.install_pending('main'))
        self.assertEqual((self.app / 'version').read_text(), 'old')
        self.assertTrue(self.pending.exists())

    def test_closed_browser_installs_and_keeps_previous(self):
        with patch.object(zen, 'app_running', return_value=False), patch.object(zen, 'run'):
            self.assertTrue(zen.install_pending('main'))
        self.assertEqual((self.app / 'version').read_text(), 'new')
        self.assertEqual((self.state / 'previous-main.app/version').read_text(), 'old')
        self.assertFalse(self.pending.exists())

    def test_update_preserves_cache_while_running_and_invalidates_it_after_quit(self):
        profile = self.state / 'profile'
        cache = profile / 'startupCache'
        cache.mkdir(parents=True)
        (cache / 'scriptCache.bin').write_text('old compiled browser code')
        (profile / 'places.sqlite').write_text('browsing data')
        with patch.object(zen, 'app_running', return_value=True):
            self.assertFalse(zen.install_pending('main'))
        self.assertTrue(cache.exists())
        with patch.object(zen, 'app_running', return_value=False), patch.object(zen, 'run'):
            self.assertTrue(zen.install_pending('main'))
        self.assertFalse(cache.exists())
        self.assertEqual((self.state / 'previous-main-startupCache/scriptCache.bin').read_text(),
                         'old compiled browser code')
        self.assertEqual((profile / 'places.sqlite').read_text(), 'browsing data')

    def test_failed_replacement_restores_previous(self):
        rename = Path.rename

        def fail_pending(path, target):
            if path == self.pending:
                raise OSError('installation failed')
            return rename(path, target)

        with patch.object(zen, 'app_running', return_value=False), patch.object(Path, 'rename', fail_pending):
            with self.assertRaises(OSError):
                zen.install_pending('main')
        self.assertEqual((self.app / 'version').read_text(), 'old')
        self.assertTrue(self.pending.exists())

    def test_failed_build_does_not_mark_commit_complete(self):
        with patch.object(zen, 'read_config', return_value={'repo': '/repo'}), \
             patch.object(zen, 'install_pending'), \
             patch.object(zen, 'run', return_value='new-sha\n'), \
             patch.object(zen, 'managed_checkout'), \
             patch.object(zen, 'build', side_effect=RuntimeError('compile failed')):
            with self.assertRaises(RuntimeError):
                zen.tick()
        self.assertFalse((self.state / 'built-main.txt').exists())
        self.assertEqual((self.app / 'version').read_text(), 'old')

    def test_refresh_profile_keeps_old_test_profile_and_excludes_locks(self):
        source = self.state / 'profile'
        source.mkdir()
        (source / 'places.sqlite').write_text('daily browsing data')
        (source / '.parentlock').touch()
        target = self.state / 'nightly-profile'
        target.mkdir()
        (target / 'places.sqlite').write_text('old test data')
        with patch.object(zen, 'app_running', return_value=False):
            zen.refresh_nightly_profile()
        self.assertEqual((target / 'places.sqlite').read_text(), 'daily browsing data')
        self.assertFalse((target / '.parentlock').exists())
        self.assertEqual((self.state / 'nightly-profile-previous/places.sqlite').read_text(), 'old test data')

    def test_refresh_refuses_an_open_browser(self):
        with patch.object(zen, 'app_running', return_value=True):
            with self.assertRaises(RuntimeError):
                zen.refresh_nightly_profile()
        self.assertFalse((self.state / 'nightly-profile-copy').exists())

    def test_failed_signature_verification_keeps_previous_pending_update(self):
        import plistlib
        source = Path(self.temp.name) / 'source.app'
        (source / 'Contents/MacOS').mkdir(parents=True)
        (source / 'Contents/Resources').mkdir()
        (source / 'Contents/MacOS/zen').write_text('binary')
        with (source / 'Contents/Info.plist').open('wb') as handle:
            plistlib.dump({'CFBundleExecutable': 'zen'}, handle)
        with patch.object(zen, 'run', side_effect=[None, RuntimeError('invalid signature')]):
            with self.assertRaises(RuntimeError):
                zen.stage_app(source, 'main', 'candidate')
        self.assertEqual((self.pending / 'version').read_text(), 'new')
        self.assertEqual((self.app / 'version').read_text(), 'old')

    def test_failed_copy_never_creates_an_installable_update(self):
        import shutil
        shutil.rmtree(self.pending)
        with patch.object(zen.shutil, 'copytree', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                zen.stage_app(Path('/source.app'), 'main', 'candidate')
        self.assertFalse(self.pending.exists())
        self.assertFalse(zen.install_pending('main'))
        self.assertEqual((self.app / 'version').read_text(), 'old')

    def test_only_nightly_disables_browser_sync(self):
        import json
        import plistlib
        source = Path(self.temp.name) / 'source.app'
        (source / 'Contents/MacOS').mkdir(parents=True)
        (source / 'Contents/Resources').mkdir()
        (source / 'Contents/MacOS/zen').write_text('binary')
        with (source / 'Contents/Info.plist').open('wb') as handle:
            plistlib.dump({'CFBundleExecutable': 'zen'}, handle)
        for channel in ['main', 'nightly']:
            with patch.object(zen, 'run'):
                app = zen.stage_app(source, channel, 'candidate')
            policies = json.loads((app / 'Contents/Resources/distribution/policies.json').read_text())['policies']
            self.assertTrue(policies['DisableAppUpdate'])
            self.assertEqual(policies.get('DisableFirefoxAccounts', False), channel == 'nightly')

    def test_launcher_disables_modifier_shortcut_and_preserves_explicit_safe_mode(self):
        import plistlib
        import subprocess
        source = Path(self.temp.name) / 'launcher-test.app'
        (source / 'Contents/MacOS').mkdir(parents=True)
        (source / 'Contents/Resources').mkdir()
        binary = source / 'Contents/MacOS/zen'
        binary.write_text('#!/bin/sh\nprintf "%s\\n" "$MOZ_DISABLE_SAFE_MODE_KEY" "$@"\n')
        binary.chmod(0o755)
        with (source / 'Contents/Info.plist').open('wb') as handle:
            plistlib.dump({'CFBundleExecutable': 'zen'}, handle)
        for channel in ['main', 'nightly']:
            with patch.object(zen, 'run'):
                app = zen.stage_app(source, channel, 'candidate')
            output = subprocess.check_output(
                [str(app / 'Contents/MacOS/personal-launcher'), '--safe-mode'],
                text=True).splitlines()
            self.assertEqual(output[0], '1')
            self.assertEqual(output[-1], '--safe-mode')

    def test_patch_reimport_preserves_only_identical_file_timestamps(self):
        import os
        engine = Path(self.temp.name) / 'engine'
        engine.mkdir()
        zen.run('git', 'init', '-q', cwd=engine)
        same = engine / 'same.rs'
        changed = engine / 'changed.rs'
        removed = engine / 'removed.rs'
        (engine / '.gitignore').write_text('zen/\nobj*/\n')
        for path in [same, changed, removed]:
            path.write_text('upstream')
        zen.run('git', 'add', '.', cwd=engine)
        zen.run('git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
                'commit', '-qm', 'base', cwd=engine)
        old = 1_000_000_000
        new = 2_000_000_000
        (engine / 'zen').mkdir()
        zen_header = engine / 'zen/theme.h'
        (engine / 'obj-test').mkdir()
        (engine / 'obj-test/cache.o').write_text('compiled cache')
        for path in [same, changed, removed, zen_header]:
            path.write_text('patch')
            os.utime(path, ns=(old, old))
        snapshot = zen.snapshot_patched_files(engine)
        self.assertNotIn(engine / 'obj-test/cache.o', snapshot)
        zen.run('git', 'reset', '--hard', '-q', cwd=engine)
        same.write_text('patch')
        zen_header.write_text('patch')
        changed.write_text('new patch')
        removed.unlink()
        for path in [same, changed, zen_header]:
            os.utime(path, ns=(new, new))
        zen.restore_unchanged_timestamps(snapshot)
        self.assertEqual(same.stat().st_mtime_ns, old)
        self.assertEqual(zen_header.stat().st_mtime_ns, old)
        self.assertEqual(changed.stat().st_mtime_ns, new)
        self.assertFalse(removed.exists())

    def test_native_inputs_allow_ui_changes_but_detect_native_and_config_changes(self):
        root = Path(self.temp.name) / 'source'
        (root / 'src/zen').mkdir(parents=True)
        zen.run('git', 'init', '-q', cwd=root)
        ui = root / 'src/zen/view.mjs'
        ui.write_text('old UI')
        native = root / 'src/zen/theme.cpp'
        native.write_text('old native code')
        config = root / 'mozconfig'
        config.write_text('old config')
        zen.run('git', 'add', '.', cwd=root)
        original = zen.native_inputs(root)
        ui.write_text('new UI')
        (root / 'locales').mkdir()
        (root / 'locales/messages.ftl').write_text('new locale')
        self.assertEqual(zen.native_inputs(root), original)
        native.write_text('new native code')
        self.assertNotEqual(zen.native_inputs(root), original)
        native.write_text('old native code')
        (root / 'src/zen/new.webidl').write_text('new interface')
        self.assertNotEqual(zen.native_inputs(root), original)
        (root / 'src/zen/new.webidl').unlink()
        config.write_text('new config')
        self.assertNotEqual(zen.native_inputs(root), original)


if __name__ == '__main__':
    unittest.main()
