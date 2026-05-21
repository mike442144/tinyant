import csv
import sys
import os
from collections import defaultdict

PIVOT_FILE = './data/yiche_modelsales_pivot.csv'

def load_pivot():
    """Load existing pivot CSV, return ({name: {month: num}}, [months])"""
    if not os.path.exists(PIVOT_FILE):
        return {}, []
    data = defaultdict(dict)
    with open(PIVOT_FILE, 'r') as f:
        reader = csv.reader(f)
        header = next(reader)
        months = header[1:]
        for row in reader:
            if row:
                data[row[0]] = dict(zip(months, row[1:]))
    return data, months

def load_new(source_file):
    """Load new raw CSV, return {name: {month: num}}"""
    data = defaultdict(dict)
    with open(source_file, 'r') as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 4:
                continue
            name = row[0].strip()
            num = row[1].strip().replace(',', '')
            month = row[3].strip()
            if month == '2025-04-01':
                month = '2026-04-01'
            if name and num:
                data[name][month] = num
    return data

def merge_and_save(pivot_data, pivot_months, new_data):
    new_months = sorted(set(m for months in new_data.values() for m in months))
    # Deduplicate: only add months not already in pivot
    extra_months = [m for m in new_months if m not in pivot_months]
    if not extra_months:
        print("No new months found.")
        return

    all_months = pivot_months + extra_months
    all_names = sorted(set(list(pivot_data.keys()) + list(new_data.keys())))

    with open(PIVOT_FILE, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['车型'] + all_months)
        for name in all_names:
            row_vals = {}
            row_vals.update(pivot_data.get(name, {}))
            row_vals.update(new_data.get(name, {}))
            row = [name] + [row_vals.get(m, '') for m in all_months]
            writer.writerow(row)

    print(f"Updated pivot: {len(all_names)} models x {len(all_months)} months")
    print(f"New columns added: {extra_months}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python pivot.py <source_csv_path>")
        sys.exit(1)

    source = sys.argv[1]
    pivot_data, pivot_months = load_pivot()
    new_data = load_new(source)
    merge_and_save(pivot_data, pivot_months, new_data)
