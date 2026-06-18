import assert from "node:assert/strict";
import { addExchangePrefix, generateSegments, mergeEvents, computeAdjFactors }
	from "../marketdata/index.js";

let pass = 0, fail = 0;
const t = (name, fn) => {
	try { fn(); pass++; console.log(`  ok  ${name}`); }
	catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); };
};
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

console.log('addExchangePrefix:');
t('sh by leading 6', () => assert.equal(addExchangePrefix('600519'), 'sh600519'));
t('sh by leading 9 (B-share)', () => assert.equal(addExchangePrefix('900901'), 'sh900901'));
t('sz by leading 0', () => assert.equal(addExchangePrefix('000001'), 'sz000001'));
t('sz by leading 3 (ChiNext)', () => assert.equal(addExchangePrefix('300750'), 'sz300750'));
t('STAR 688 -> sh', () => assert.equal(addExchangePrefix('688981'), 'sh688981'));
t('keeps existing sh/sz prefix', () => assert.equal(addExchangePrefix('sh600519'), 'sh600519'));
t('prefix lowercased', () => assert.equal(addExchangePrefix('SH600519'), 'sh600519'));

console.log('generateSegments:');
t('half-year chunks across a 12-month range', () => {
	const s = generateSegments('2023-01-01', '2024-01-01');
	assert.equal(s.length, 2);
	assert.deepEqual(s[0], ['2023-01-01', '2023-07-01']);
	assert.deepEqual(s[1], ['2023-07-02', '2024-01-01']);
});
t('single segment when range under 6 months', () => {
	const s = generateSegments('2023-01-01', '2023-03-01');
	assert.equal(s.length, 1);
	assert.deepEqual(s[0], ['2023-01-01', '2023-03-01']);
});
t('contiguous and ascending (no gaps, no overlap)', () => {
	const s = generateSegments('2020-01-01', '2026-01-01');
	assert.ok(s.length > 8);
	for (let i = 1; i < s.length; i++) {
		const prevEnd = s[i - 1][1];
		const curStart = s[i][0];
		// next segment starts the day after the previous ends
		assert.equal(curStart, nextDay(prevEnd), `gap/overlap at ${prevEnd}`);
		assert.ok(s[i - 1][0] < s[i][0], 'not ascending');
	}
});
t('ends exactly on the requested to-date', () => {
	const s = generateSegments('2020-01-01', '2025-12-31');
	assert.equal(s.at(-1)[1], '2025-12-31');
	assert.equal(s[0][0], '2020-01-01');
});

console.log('mergeEvents:');
t('sums amounts sharing one ex-date', () => {
	const out = mergeEvents(
		[{ date: '2024-06-19', cash: 5, bonus: 0, allot: 0, allotPrice: 0 }],
		[{ date: '2024-06-19', cash: 0, bonus: 0.5, allot: 0, allotPrice: 0 }],
	);
	assert.equal(out.length, 1);
	assert.equal(out[0].date, '2024-06-19');
	assert.equal(out[0].cash, 5);
	assert.equal(out[0].bonus, 0.5);
});
t('keeps distinct ex-dates separate', () => {
	const out = mergeEvents([{ date: '2024-06-19', cash: 5, bonus: 0, allot: 0, allotPrice: 0 },
		{ date: '2025-06-19', cash: 6, bonus: 0, allot: 0, allotPrice: 0 }]);
	assert.equal(out.length, 2);
});
t('returns empty for no inputs', () => assert.equal(mergeEvents().length, 0));

console.log('computeAdjFactors:');
t('flat at 1.0 with no events', () => {
	const dates = ['2024-01-02', '2024-01-03', '2024-01-04'];
	const close = new Map([['2024-01-02', 10], ['2024-01-03', 11], ['2024-01-04', 12]]);
	const f = computeAdjFactors(dates, close, []);
	assert.equal(f.size, 3);
	for (const d of dates) approx(f.get(d), 1.0);
});
t('normalized to 1.0 on the first row', () => {
	const dates = ['2024-06-10', '2024-06-11', '2024-06-12'];
	const close = new Map([['2024-06-10', 100], ['2024-06-11', 100], ['2024-06-12', 90]]);
	const events = [{ date: '2024-06-12', cash: 10, bonus: 0, allot: 0, allotPrice: 0 }];
	const f = computeAdjFactors(dates, close, events);
	approx(f.get('2024-06-10'), 1.0);
	approx(f.get('2024-06-11'), 1.0); // ex-date is the jump day; prior stays flat
	approx(f.get('2024-06-12'), 100 / 90); // step = prevClose / (prevClose - cash)
});
t('cash dividend preserves daily returns across ex-date', () => {
	// prevClose=100, cash=10 => ex-ref=90, raw close drops to 90 the next day.
	// close*adj_factor must equalize: 100*1 == 90*(100/90) == 100.
	const dates = ['2024-06-11', '2024-06-12'];
	const close = new Map([['2024-06-11', 100], ['2024-06-12', 90]]);
	const events = [{ date: '2024-06-12', cash: 10, bonus: 0, allot: 0, allotPrice: 0 }];
	const f = computeAdjFactors(dates, close, events);
	approx(close.get('2024-06-11') * f.get('2024-06-11'),
		close.get('2024-06-12') * f.get('2024-06-12'));
});
t('送股 (stock dividend) halves price -> factor doubles', () => {
	// 10送10 = 1 share per share: ex-ref = 100 / (1 + 1) = 50, step = 2
	const dates = ['2024-06-11', '2024-06-12'];
	const close = new Map([['2024-06-11', 100], ['2024-06-12', 50]]);
	const events = [{ date: '2024-06-12', cash: 0, bonus: 1, allot: 0, allotPrice: 0 }];
	const f = computeAdjFactors(dates, close, events);
	approx(f.get('2024-06-11'), 1.0);
	approx(f.get('2024-06-12'), 2.0);
});
t('rights issue (配股) factors by ex-ref formula', () => {
	// prevClose=100, allot=0.15 @ allotPrice=25: ref=(100 - 0 + 0.15*25)/(1+0+0.15)
	//   = (100 + 3.75)/1.15 = 90.217..., step = 100/90.217 = 1.108443
	const dates = ['2024-06-11', '2024-06-12'];
	const close = new Map([['2024-06-11', 100], ['2024-06-12', 90.2174]]);
	const events = [{ date: '2024-06-12', cash: 0, bonus: 0, allot: 0.15, allotPrice: 25 }];
	const f = computeAdjFactors(dates, close, events);
	approx(f.get('2024-06-12'), 100 / ((100 + 0.15 * 25) / 1.15));
});
t('factor stays flat between events and accumulates', () => {
	const dates = ['2023-06-29', '2023-06-30', '2024-06-18', '2024-06-19'];
	const close = new Map([['2023-06-29', 100], ['2023-06-30', 90], ['2024-06-18', 90], ['2024-06-19', 81]]);
	const events = [
		{ date: '2023-06-30', cash: 10, bonus: 0, allot: 0, allotPrice: 0 },
		{ date: '2024-06-19', cash: 9, bonus: 0, allot: 0, allotPrice: 0 },
	];
	const f = computeAdjFactors(dates, close, events);
	approx(f.get('2023-06-29'), 1.0);
	approx(f.get('2023-06-30'), 100 / 90);          // ~1.111111
	approx(f.get('2024-06-18'), 100 / 90);          // held flat between events
	approx(f.get('2024-06-19'), (100 / 90) * (90 / 81)); // stepped again
});

console.log(`\n[marketdata] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

// ---- helpers ----
function nextDay(iso) {
	const d = new Date(iso + 'T00:00:00Z');
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}
