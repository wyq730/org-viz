import csv
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('converter', ROOT / 'scripts/csv_to_json.py')
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class ConverterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'input.csv'
        self.config = {'name_column': 'label', 'abstract': [{'columns': ['city', 'kind'], 'separator': ' · '}], 'other_info': {'Notes': 'notes'}}

    def write_rows(self, rows):
        with self.path.open('w', encoding='utf-8-sig', newline='') as output:
            writer = csv.writer(output)
            writer.writerow(['id', 'boss', 'label', 'city', 'kind', 'notes'])
            writer.writerows(rows)

    def test_mapping_bom_multiline_and_missing_parent(self):
        self.write_rows([['001', '', '张三', '上海', '', 'hello, world\nnext line'], ['002', '001', 'Alice', 'Paris', 'Team', ''], ['003', 'missing', 'Orphan', '', '', '']])
        nodes = converter.convert(self.path, 'id', 'boss', self.config)
        self.assertEqual(nodes[0], {'node': '001', 'parent': '', 'name': '张三', 'abstract': ['上海'], 'other_info': {'Notes': 'hello, world\nnext line'}})
        self.assertEqual(nodes[1]['abstract'], ['Paris · Team'])
        self.assertEqual(nodes[2]['parent'], 'missing')

    def test_invalid_relationships(self):
        for rows in [
            [['1', '', 'A', '', '', ''], ['1', '', 'B', '', '', '']],
            [['', '', 'A', '', '', '']],
            [['1', '1', 'A', '', '', '']],
            [['1', '2', 'A', '', '', ''], ['2', '1', 'B', '', '', '']],
            []
        ]:
            with self.subTest(rows=rows):
                self.write_rows(rows)
                with self.assertRaises(ValueError):
                    converter.convert(self.path, 'id', 'boss', self.config)

    def test_missing_column(self):
        self.write_rows([['1', '', 'A', '', '', '']])
        with self.assertRaisesRegex(ValueError, 'Missing CSV columns'):
            converter.convert(self.path, 'absent', 'boss', self.config)

    def test_cli_failure_preserves_output(self):
        self.write_rows([['1', '1', 'A', '', '', '']])
        output = Path(self.directory.name) / 'output.json'
        output.write_text('preserve me')
        config = Path(self.directory.name) / 'config.json'
        config.write_text(json.dumps(self.config))
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/csv_to_json.py'), str(self.path), str(output), '--id-column', 'id', '--parent-id-column', 'boss', '--config', str(config)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output.read_text(), 'preserve me')

    def test_deep_chain(self):
        self.write_rows([[str(index), str(index - 1) if index else '', 'A', '', '', ''] for index in range(3000)])
        self.assertEqual(len(converter.convert(self.path, 'id', 'boss', self.config)), 3000)


if __name__ == '__main__':
    unittest.main()
