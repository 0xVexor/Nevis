"""Exercise installer scripts against temporary volumes; never install on this Mac."""
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / '.github/macos-installer'


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nevis-installer-')
        self.root = Path(self.temp.name)
        self.notes = self.root / 'Users/example/notes/keep.txt'
        self.notes.parent.mkdir(parents=True)
        self.notes.write_text('keep notes')

    def tearDown(self):
        self.assertEqual(self.notes.read_text(), 'keep notes')
        self.temp.cleanup()

    def app(self, name, identifier='com.vexor.noviq'):
        app = self.root / 'Applications' / f'{name}.app'
        contents = app / 'Contents'
        (contents / 'MacOS').mkdir(parents=True)
        (contents / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': identifier, 'CFBundleShortVersionString': '1.0.1',
            'CFBundleVersion': '1.0.1', 'CFBundlePackageType': 'APPL', 'CFBundleExecutable': name,
        }))
        binary = contents / 'MacOS' / name
        binary.write_text('#!/bin/sh\nexit 0\n')
        binary.chmod(0o755)
        return app

    def run_script(self, name):
        return subprocess.run(['bash', str(SCRIPTS / name), '', '', str(self.root)], capture_output=True)

    def test_replaces_legacy_bundle_and_keeps_notes(self):
        legacy = self.app('Noviq')
        current = self.app('Nevis')
        self.assertEqual(self.run_script('preinstall').returncode, 0)
        self.assertEqual(self.run_script('postinstall').returncode, 0)
        self.assertFalse(legacy.exists())
        self.assertTrue(current.exists())

    def test_missing_replacement_keeps_legacy(self):
        legacy = self.app('Noviq')
        self.assertNotEqual(self.run_script('postinstall').returncode, 0)
        self.assertTrue(legacy.exists())

    def test_unrelated_application_is_never_deleted(self):
        legacy = self.app('Noviq', 'org.example.other')
        self.app('Nevis')
        self.assertNotEqual(self.run_script('preinstall').returncode, 0)
        self.assertEqual(self.run_script('postinstall').returncode, 0)
        self.assertTrue(legacy.exists())

    def test_symlink_is_not_replaced(self):
        app = self.app('Elsewhere')
        (self.root / 'Applications/Nevis.app').symlink_to(app, target_is_directory=True)
        self.assertNotEqual(self.run_script('preinstall').returncode, 0)
        self.assertTrue(app.exists())

    def test_builds_fixed_location_package(self):
        app = self.app('Nevis')
        package = self.root / 'Nevis.pkg'
        subprocess.run(['bash', str(REPO / '.github/scripts/build-macos-installer.sh'), str(app), str(package)], check=True, capture_output=True)
        expanded = self.root / 'expanded'
        subprocess.run(['/usr/sbin/pkgutil', '--expand', str(package), str(expanded)], check=True, capture_output=True)
        info = (expanded / 'PackageInfo').read_text()
        self.assertIn('com.vexor.noviq.installer', info)
        xml = ET.fromstring(info)
        self.assertEqual(xml.attrib['relocatable'], 'false')
        self.assertEqual(list(xml.find('relocate')), [])
        self.assertEqual(xml.attrib['install-location'], '/')
        self.assertIn('preinstall', info)
        self.assertIn('postinstall', info)


if __name__ == '__main__':
    unittest.main()
