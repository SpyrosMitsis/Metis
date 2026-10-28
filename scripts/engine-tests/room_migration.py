#!/usr/bin/env python3
"""Check the actual 8→9 SQL against exported Room schemas and existing rows.
This is SQLite contract validation, not Android instrumentation.
"""
import json
import re
import sqlite3
from pathlib import Path
root = Path(__file__).resolve().parents[2]
schemas = root / 'android/app/schemas/com.workoutmaker.app.data.AppDatabase'
old = json.loads((schemas / '8.json').read_text())['database']['entities']
new = json.loads((schemas / '9.json').read_text())['database']['entities']
actual, expected = sqlite3.connect(':memory:'), sqlite3.connect(':memory:')
names = {'strength_workout', 'strength_set'}
for database, entities in [(actual, old), (expected, new)]:
    for entity in entities:
        if entity['tableName'] in names:
            database.execute(entity['createSql'].replace('${TABLE_NAME}', entity['tableName']))
for table in names:
    columns = actual.execute(f'pragma table_info({table})').fetchall()
    values = {row[1]: (1 if row[2] in ('INTEGER', 'REAL') else 'fixture') for row in columns if row[3] or row[5]}
    actual.execute(f'insert into {table} ({",".join(values)}) values ({",".join("?" for _ in values)})', list(values.values()))
source = (root / 'android/app/src/main/java/com/workoutmaker/app/data/Cache.kt').read_text()
block = source.split('val MIGRATION_8_9 =', 1)[1].split('@Module', 1)[0]
statements = re.findall(r'db\.execSQL\("([^"\n]+)"\)', block)
assert len(statements) == 2, 'Update this migration test when the SQL changes'
for statement in statements:
    actual.execute(statement)
for table in names:
    columns = lambda database: {row[1]: row[2:] for row in database.execute(f'pragma table_info({table})')}
    assert columns(actual) == columns(expected), f'{table} differs from Room schema 9'
    assert actual.execute(f'select count(*) from {table}').fetchone()[0] == 1
assert actual.execute('select quantityUnit from strength_set').fetchone()[0] == 'reps'
assert actual.execute('select plannedWorkoutId from strength_workout').fetchone()[0] is None
print('Room 8→9 SQLite schema/default/preservation checks passed.')
