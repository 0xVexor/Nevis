"""Validate preview installer boundaries on temporary volumes; never install an app."""
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PREINSTALL = ROOT / '.github/macos-preview-installer/preinstall'

class PreviewInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nevis-preview-test-')
        self.root = Path(self.temp.name)
        self.original = self.root / 'Applications/Nevis.app/Contents'
        self.original.mkdir(parents=True)
        (self.original / 'keep.txt').write_text('production app stays')
        self.notes = self.root / 'Users/example/vault/pages/keep.json'
        self.notes.parent.mkdir(parents=True)
        self.notes.write_text('{"title":"keep notes"}')
    def tearDown(self):
        self.assertEqual((self.original / 'keep.txt').read_text(), 'production app stays')
        self.assertEqual(self.notes.read_text(), '{"title":"keep notes"}')
        self.temp.cleanup()
    def run_preinstall(self):
        return subprocess.run(['bash', str(PREINSTALL), 'package', '/', str(self.root)], capture_output=True).returncode
    def preview(self, identifier):
        folder = self.root / 'Applications/Nevis GitHub Preview.app/Contents'
        folder.mkdir(parents=True)
        with (folder / 'Info.plist').open('wb') as f:
            plistlib.dump({'CFBundleIdentifier': identifier}, f)
    def test_fresh_preview_does_not_require_production_to_be_removed(self):
        self.assertEqual(self.run_preinstall(), 0)
    def test_upgrade_of_preview_is_allowed(self):
        self.preview('com.vexor.noviq.githubpreview')
        self.assertEqual(self.run_preinstall(), 0)
    def test_unrelated_app_is_never_replaced(self):
        self.preview('another.publisher.app')
        self.assertNotEqual(self.run_preinstall(), 0)
    def test_symlink_is_never_followed(self):
        (self.root / 'Applications/Nevis GitHub Preview.app').symlink_to(self.original.parent)
        self.assertNotEqual(self.run_preinstall(), 0)

if __name__ == '__main__':
    unittest.main()
