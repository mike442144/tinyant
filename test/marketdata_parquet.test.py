#!/usr/bin/env python3
"""Test reading and processing marketdata parquet files."""

import os
import re
import sys
import pyarrow.parquet as pq

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'marketdata', 'data')
SAMPLE_CODE = 'sz000001'

passed = 0
failed = 0


def t(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print(f'  ok - {name}')
    except AssertionError as e:
        failed += 1
        print(f'  FAIL - {name}: {e}')


def approx(a, b, eps=1e-6):
    assert abs(a - b) < eps, f'expected {a} ~= {b} (eps={eps})'


def load_table(code=SAMPLE_CODE):
    path = os.path.join(DATA_DIR, code, f'{code}_kline.parquet')
    return pq.read_table(path)


def rows(table):
    cols = {c: [table.column(c)[i].as_py() for i in range(table.num_rows)]
            for c in table.column_names}
    return cols


EXPECTED_COLUMNS = ['date', 'open', 'close', 'high', 'low', 'volume', 'adj_factor']
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


# --- schema ---

def test_schema_columns():
    table = load_table()
    assert table.column_names == EXPECTED_COLUMNS, \
        f'columns: {table.column_names} != {EXPECTED_COLUMNS}'

t('schema has expected columns', test_schema_columns)


def test_schema_types():
    table = load_table()
    schema = table.schema
    type_map = {f.name: str(f.type) for f in schema}
    assert type_map['date'] == 'string', f'date type: {type_map["date"]}'
    for col in ['open', 'close', 'high', 'low', 'volume', 'adj_factor']:
        assert type_map[col] == 'double', f'{col} type: {type_map[col]}'

t('schema has correct types', test_schema_types)


# --- data integrity ---

def test_dates_sorted():
    data = rows(load_table())
    dates = data['date']
    for i in range(1, len(dates)):
        assert dates[i] > dates[i - 1], \
            f'dates not sorted at index {i}: {dates[i-1]} >= {dates[i]}'

t('dates are sorted ascending', test_dates_sorted)


def test_date_format():
    data = rows(load_table())
    for d in data['date']:
        assert DATE_RE.match(d), f'invalid date format: {d}'

t('all dates match YYYY-MM-DD format', test_date_format)


def test_ohlc_positive():
    data = rows(load_table())
    for col in ['open', 'close', 'high', 'low']:
        for i, v in enumerate(data[col]):
            assert v > 0, f'{col}[{i}] = {v} is not positive'

t('OHLC values are all positive', test_ohlc_positive)


def test_high_low_consistency():
    data = rows(load_table())
    for i in range(len(data['date'])):
        h, l, o, c = data['high'][i], data['low'][i], data['open'][i], data['close'][i]
        assert h >= o, f'row {i}: high {h} < open {o}'
        assert h >= c, f'row {i}: high {h} < close {c}'
        assert l <= o, f'row {i}: low {l} > open {o}'
        assert l <= c, f'row {i}: low {l} > close {c}'

t('high >= max(open,close) and low <= min(open,close)', test_high_low_consistency)


def test_volume_non_negative():
    data = rows(load_table())
    for i, v in enumerate(data['volume']):
        assert v >= 0, f'volume[{i}] = {v} is negative'

t('volume is non-negative', test_volume_non_negative)


# --- adj_factor ---

def test_adj_factor_first_is_one():
    data = rows(load_table())
    approx(data['adj_factor'][0], 1.0)

t('adj_factor starts at 1.0', test_adj_factor_first_is_one)


def test_adj_factor_positive():
    data = rows(load_table())
    for i, v in enumerate(data['adj_factor']):
        assert v is not None, f'adj_factor[{i}] is null'
        assert v > 0, f'adj_factor[{i}] = {v} is not positive'

t('all adj_factor values are positive', test_adj_factor_positive)


def test_adj_factor_step_function():
    data = rows(load_table())
    changes = 0
    adj = data['adj_factor']
    for i in range(1, len(adj)):
        if adj[i] != adj[i - 1]:
            changes += 1
    assert changes > 0, 'adj_factor never changes (no corporate actions found)'
    assert changes < len(adj) * 0.1, \
        f'adj_factor changes too often ({changes}/{len(adj)}), expected step function'

t('adj_factor is a step function (changes on ex-dates only)', test_adj_factor_step_function)


# --- adjusted price computation ---

def test_adjusted_close():
    data = rows(load_table())
    n = len(data['date'])
    adj_close = [data['close'][i] * data['adj_factor'][i] for i in range(n)]
    for v in adj_close:
        assert v > 0, f'adjusted close {v} is not positive'
    first, last = adj_close[0], adj_close[-1]
    assert last < first * 100, \
        f'adjusted close grew unreasonably: {first} -> {last}'

t('adjusted close prices are valid', test_adjusted_close)


def test_daily_returns_bounded():
    data = rows(load_table())
    adj_close = [data['close'][i] * data['adj_factor'][i] for i in range(len(data['date']))]
    for i in range(1, len(adj_close)):
        if adj_close[i - 1] == 0:
            continue
        ret = (adj_close[i] - adj_close[i - 1]) / adj_close[i - 1]
        assert abs(ret) < 0.22, \
            f'daily return at {data["date"][i]} = {ret:.4f} exceeds +/-22% limit'

t('daily returns from adjusted close are within +/-22% (A-share limit)', test_daily_returns_bounded)


# --- summary ---

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
