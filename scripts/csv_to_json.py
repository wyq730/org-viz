#!/usr/bin/env python3
"""Convert CSV records into the generic organization viewer format."""
import argparse
import csv
import json
import os
from pathlib import Path
import sys
import tempfile


def convert(input_path, id_column, parent_id_column, config):
    required = {id_column, parent_id_column, config['name_column']}
    for line in config.get('abstract', []):
        required.update(line['columns'])
    required.update(config.get('other_info', {}).values())
    with Path(input_path).open(encoding='utf-8-sig', newline='') as source:
        reader = csv.DictReader(source)
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError('Missing CSV columns: ' + ', '.join(sorted(missing)))
        nodes = []
        identifiers = set()
        for row in reader:
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f'CSV line {reader.line_num}: column count does not match header')
            identifier = row[id_column].strip()
            if not identifier or identifier in identifiers:
                raise ValueError(f'CSV line {reader.line_num}: empty or duplicate ID {identifier!r}')
            identifiers.add(identifier)
            abstract = []
            for line in config.get('abstract', []):
                values = [row[column].strip() for column in line['columns'] if row[column].strip()]
                if values:
                    abstract.append(line.get('separator', ', ').join(values))
            nodes.append({'node': identifier, 'name': row[config['name_column']],
                          'parent': row[parent_id_column].strip(), 'abstract': abstract,
                          'other_info': {label: row[column] for label, column in config.get('other_info', {}).items()}})
    if not nodes:
        raise ValueError('CSV contains no records')
    parents = {node['node']: node['parent'] for node in nodes}
    completed = set()
    for identifier in parents:
        path = set()
        current = identifier
        while current in parents and current not in completed:
            if current in path:
                raise ValueError(f'Cycle detected at ID {current!r}')
            path.add(current)
            current = parents[current]
        completed.update(path)
    return nodes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--id-column', required=True)
    parser.add_argument('--parent-id-column', required=True)
    parser.add_argument('--config', type=Path, required=True)
    arguments = parser.parse_args()
    temporary = None
    try:
        if arguments.input.resolve() == arguments.output.resolve() or arguments.config.resolve() == arguments.output.resolve():
            raise ValueError('Output must differ from input and config')
        config = json.loads(arguments.config.read_text(encoding='utf-8-sig'))
        nodes = convert(arguments.input, arguments.id_column, arguments.parent_id_column, config)
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=arguments.output.parent, delete=False) as target:
            temporary = Path(target.name)
            json.dump(nodes, target, ensure_ascii=False, indent=2)
            target.write('\n')
        os.replace(temporary, arguments.output)
        identifiers = {node['node'] for node in nodes}
        missing = sum(bool(node['parent']) and node['parent'] not in identifiers for node in nodes)
        roots = sum(not node['parent'] or node['parent'] not in identifiers for node in nodes)
        print(f'{len(nodes)} nodes, {roots} roots, {missing} missing-parent references -> {arguments.output}')
    except (ValueError, OSError, KeyError, TypeError) as error:
        if temporary and temporary.exists():
            temporary.unlink()
        parser.exit(1, f'Error: {error}\n')


if __name__ == '__main__':
    main()
