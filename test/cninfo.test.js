import assert from "node:assert/strict";
import { parseDateRangeCninfo, sanitizeFilename, extractFiscalYearCn } from "../lib/utils.js";

let pass = 0, fail = 0;
const t = (name, fn) => {
	try { fn(); pass++; console.log(`  ok  ${name}`); }
	catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
};

console.log('parseDateRangeCninfo:');
t('tilde separator', () => {
	const r = parseDateRangeCninfo('2024-01-01~2024-12-31');
	assert.equal(r.from, '2024-01-01');
	assert.equal(r.to, '2024-12-31');
});
t('single date', () => {
	const r = parseDateRangeCninfo('2024-06-15');
	assert.equal(r.from, '2024-06-15');
	assert.equal(r.to, '2024-06-15');
});
t('empty defaults to last month', () => {
	const r = parseDateRangeCninfo('');
	assert.match(r.from, /^\d{4}-\d{2}-\d{2}$/);
	assert.match(r.to, /^\d{4}-\d{2}-\d{2}$/);
});
t('trims whitespace', () => {
	const r = parseDateRangeCninfo('  2024-01-01 ~ 2024-12-31  ');
	assert.equal(r.from, '2024-01-01');
	assert.equal(r.to, '2024-12-31');
});

console.log('sanitizeFilename:');
t('replaces illegal chars', () => {
	assert.equal(sanitizeFilename('a/b\\c:d*e?f'), 'a_b_c_d_e_f');
});
t('truncates at 60 chars', () => {
	assert.equal(sanitizeFilename('x'.repeat(80)).length, 60);
});
t('strips newlines', () => {
	assert.equal(sanitizeFilename('title\nwith\rbreaks'), 'title_with_breaks');
});

console.log('extractFiscalYearCn:');
t('matches "2023年年度报告"', () => assert.equal(extractFiscalYearCn('2023年年度报告'), '2023'));
t('matches "贵州茅台2024年中期"', () => assert.equal(extractFiscalYearCn('贵州茅台2024年中期'), '2024'));
t('returns undefined when no year', () => assert.equal(extractFiscalYearCn('分红公告'), undefined));

console.log(`\n[cninfo] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
