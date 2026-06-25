import assert from "node:assert/strict";
import { parseDateRangeHkex, sanitizeFilename, extractFiscalYearHk } from "../lib/utils.js";

let pass = 0, fail = 0;
const t = (name, fn) => {
	try { fn(); pass++; console.log(`  ok  ${name}`); }
	catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
};

console.log('parseDateRangeHkex:');
t('compact hyphen separator', () => {
	const r = parseDateRangeHkex('20250101-20250630');
	assert.equal(r.from, '20250101');
	assert.equal(r.to, '20250630');
});
t('tilde separator', () => {
	const r = parseDateRangeHkex('20250101~20250630');
	assert.equal(r.from, '20250101');
	assert.equal(r.to, '20250630');
});
t('ISO input with hyphens', () => {
	const r = parseDateRangeHkex('2025-01-01~2025-06-30');
	assert.equal(r.from, '20250101');
	assert.equal(r.to, '20250630');
});
t('ISO input with hyphen separator', () => {
	const r = parseDateRangeHkex('2025-01-01-2025-06-30');
	assert.equal(r.from, '20250101');
	assert.equal(r.to, '20250630');
});
t('single compact date', () => {
	const r = parseDateRangeHkex('20250615');
	assert.equal(r.from, '20250615');
	assert.equal(r.to, '20250615');
});
t('empty defaults to last month', () => {
	const r = parseDateRangeHkex('');
	assert.match(r.from, /^\d{8}$/);
	assert.match(r.to, /^\d{8}$/);
});

console.log('sanitizeFilename:');
t('replaces illegal chars (CJK)', () => {
	assert.equal(sanitizeFilename('業績公告:2024/05'), '業績公告_2024_05');
});
t('truncates at 60 chars', () => {
	assert.equal(sanitizeFilename('業'.repeat(80)).length, 60);
});

console.log('extractFiscalYearHk:');
t('matches "2024 年報"', () => assert.equal(extractFiscalYearHk('2024 年報'), '2024'));
t('matches "ANNUAL REPORT 2024"', () => assert.equal(extractFiscalYearHk('ANNUAL REPORT 2024'), '2024'));
t('matches "騰訊控股2023年度報告"', () => assert.equal(extractFiscalYearHk('騰訊控股2023年度報告'), '2023'));
t('matches Chinese numerals "二零二五年年度報告"', () => assert.equal(extractFiscalYearHk('二零二五年年度報告'), '2025'));
t('matches Chinese numerals "二零二零年年度報告"', () => assert.equal(extractFiscalYearHk('二零二零年年度報告'), '2020'));
t('matches Chinese numerals "二零一八年年度報告"', () => assert.equal(extractFiscalYearHk('二零一八年年度報告'), '2018'));
t('returns undefined when no digits', () => assert.equal(extractFiscalYearHk('公告'), undefined));

console.log(`\n[hkexnews] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
