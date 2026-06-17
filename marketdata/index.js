import Crawler from 'crawler';
import fs from 'fs';
import path from 'path';
import { getLogger } from '../lib/tslog.js';
import dayjs from 'dayjs';
import papa from 'papaparse';
import minimist from 'minimist';
import parquet from 'parquetjs';

const argv = minimist(process.argv.slice(2), {
	string: ['codes', 'date'],
	alias: { h: 'help' },
});

if (argv.help) {
	console.log(`Usage: node index.js [options]

下载股票日K线数据。不复权 OHLCV 来自腾讯财经 (web.ifzq.gtimg.cn)，
除权除息事件来自东方财富 (datacenter-web.eastmoney.com)。
输出 CSV + Parquet 文件（Parquet 可直接用 pandas 读取）。

落盘的都是不可变数据：不复权 OHLCV + 后复权因子 (adj_factor)。
adj_factor 用"涨跌幅复权(比例复权)"自行计算：除权息日按官方除权参考价跳变，
其余日子保持不变（阶梯常数），可精确还原日收益率。adj_factor 在最早一行归一为 1.0。
任何复权口径都能由此现算（极便宜的一次乘法）：
  后复权 close = close × adj_factor
  前复权 close = close × adj_factor / adj_factor(最新一天)

Options:
  --codes <list>    Stock codes, comma-separated (e.g. sh600519,sz000001)
                    Prefix sh/sz is auto-detected if omitted
  --date <range>    Date range, e.g. 2020-01-01~2025-12-31 (default: full history)
  -h, --help        Show this help message

Examples:
  node index.js --codes sh600519
  node index.js --codes 600519,000001 --date 2020-01-01~2025-12-31

Output saved to ./data/<code>/
  <code>_kline.csv       CSV format (OHLCV unadjusted + adj_factor)
  <code>_kline.parquet   Parquet (pd.read_parquet('<code>_kline.parquet'))`);
	process.exit(0);
}

const identifier = 'marketdata';
const resultDir = './data';
const logDir = './log';
fs.mkdirSync(logDir, { recursive: true });
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format('YYYY-MM-DD')}.log`));

const CSV_COLUMNS = ['date', 'open', 'close', 'high', 'low', 'volume', 'adj_factor'];

const parquetSchema = new parquet.ParquetSchema({
	date: { type: 'UTF8' },
	open: { type: 'DOUBLE' },
	close: { type: 'DOUBLE' },
	high: { type: 'DOUBLE' },
	low: { type: 'DOUBLE' },
	volume: { type: 'DOUBLE' },
	adj_factor: { type: 'DOUBLE', optional: true },
});

function addExchangePrefix(code) {
	if (/^(sh|sz|hk)/i.test(code)) return code.toLowerCase();
	if (/^[69]/.test(code)) return 'sh' + code;
	if (/^[03]/.test(code)) return 'sz' + code;
	return code;
}

function generateSegments(from, to) {
	const segments = [];
	let start = dayjs(from);
	const end = dayjs(to);
	while (start.isBefore(end) || start.isSame(end, 'day')) {
		const segEnd = start.add(6, 'month');
		const capped = segEnd.isAfter(end) ? end : segEnd;
		segments.push([start.format('YYYY-MM-DD'), capped.format('YYYY-MM-DD')]);
		start = segEnd.add(1, 'day');
	}
	return segments;
}

// Fetch the unadjusted (day) daily series for the range. Returns [...rows].
function fetchKline(code) {
	const fromDate = argv.date ? argv.date.split('~')[0].trim() : '2000-01-01';
	const toDate = argv.date ? (argv.date.split('~')[1]?.trim() || dayjs().format('YYYY-MM-DD')) : dayjs().format('YYYY-MM-DD');

	log.info(`Fetching ${code} from ${fromDate} to ${toDate}`);

	const segments = generateSegments(fromDate, toDate);
	log.info(`Split into ${segments.length} segments (~6 months each)`);

	const allData = [];

	return new Promise((resolve) => {
		const c = new Crawler({
			maxConnections: 1,
			rateLimit: 1500,
			retries: 3,
			retryInterval: 5000,
			timeout: 20000,
			encoding: null,
			jQuery: false,
			callback: (err, res, done) => {
				if (err) {
					log.error('FAIL', res?.options?.userParams?.label, err.message);
					done();
					return;
				}
				try {
					const text = Buffer.from(res.body).toString('utf8');
					const json = JSON.parse(text);
					const stockData = json.data?.[code];
					if (json.code === 0 && stockData) {
						const dayData = stockData.day || [];
						const label = res.options.userParams.label;
						log.info(`${label} -> ${dayData.length} records`,
							dayData.length > 0 ? `(${dayData[0][0]} ~ ${dayData.at(-1)[0]})` : '');
						allData.push(...dayData);
					}
				} catch (e) {
					log.error('Parse error:', e.message);
				}
				done();
			},
		});

		c.on('drain', () => resolve(allData));

		for (const [s, e] of segments) {
			const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,${s},${e},320,`;
			c.add({ url, userParams: { label: `${s}~${e}` } });
		}
	});
}

// Fetch ex-dividend / ex-rights events from Eastmoney for the bare 6-digit code.
// Returns events sorted ascending by ex-date, each with per-share amounts.
async function fetchDividends(code) {
	const bare = code.replace(/^(sh|sz|hk)/i, '');
	const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
		+ '?reportName=RPT_SHAREBONUS_DET&columns=ALL'
		+ `&filter=(SECURITY_CODE=%22${bare}%22)`
		+ '&pageNumber=1&pageSize=500&sortColumns=EX_DIVIDEND_DATE&sortTypes=1';
	const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	const json = JSON.parse(await res.text());
	const rows = json.result?.data || [];

	const events = rows
		.filter(r => r.EX_DIVIDEND_DATE)
		.map(r => ({
			date: r.EX_DIVIDEND_DATE.slice(0, 10),
			// Eastmoney quotes per 10 shares; convert to per-share
			cash: (Number(r.PRETAX_BONUS_RMB) || 0) / 10,
			// 送股 + 转增 both dilute identically
			bonus: (Number(r.BONUS_IT_RATIO ?? ((Number(r.BONUS_RATIO) || 0) + (Number(r.IT_RATIO) || 0))) || 0) / 10,
			allot: 0,
			allotPrice: 0,
		}))
		.filter(e => e.cash > 0 || e.bonus > 0);

	log.info(`Dividends for ${bare}: ${events.length} events`);
	return events;
}

// Fetch 配股 (rights issue) events from Eastmoney's F10 分红融资 interface (pgmx array).
// Returns events with per-share allotment ratio and subscription price.
async function fetchRights(code) {
	const f10 = code.toUpperCase(); // e.g. SH600030 / SZ000001
	const url = `https://emweb.securities.eastmoney.com/PC_HSF10/BonusFinancing/PageAjax?code=${f10}`;
	const res = await fetch(url, {
		headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://emweb.securities.eastmoney.com/' },
	});
	const json = JSON.parse(await res.text());
	const rows = json.pgmx || [];

	const events = rows
		.filter(r => r.EX_DIVIDEND_DATEE && r.ISSUE_PRICE)
		.map(r => {
			// EVENT_EXPLAIN like "每10股配1.5股" -> per-share ratio 0.15
			const m = /每(\d+(?:\.\d+)?)股配(\d+(?:\.\d+)?)股/.exec(r.EVENT_EXPLAIN || '');
			const allot = m ? Number(m[2]) / Number(m[1]) : 0;
			return {
				date: r.EX_DIVIDEND_DATEE.slice(0, 10),
				cash: 0,
				bonus: 0,
				allot,
				allotPrice: Number(r.ISSUE_PRICE) || 0,
			};
		})
		.filter(e => e.allot > 0 && e.allotPrice > 0);

	log.info(`Rights issues for ${f10}: ${events.length} events`);
	return events;
}

// Merge dividend and rights events by ex-date into one map (same day can carry both).
function mergeEvents(...lists) {
	const m = new Map();
	for (const list of lists) {
		for (const e of list) {
			const cur = m.get(e.date) || { date: e.date, cash: 0, bonus: 0, allot: 0, allotPrice: 0 };
			cur.cash += e.cash;
			cur.bonus += e.bonus;
			cur.allot += e.allot;
			cur.allotPrice = e.allotPrice || cur.allotPrice;
			m.set(e.date, cur);
		}
	}
	return [...m.values()];
}

// Proportional (涨跌幅复权) back-adjustment factor, normalized to 1.0 on the first row.
// On each ex-date the factor steps by prevClose / 除权参考价; otherwise it is held flat,
// so raw_close * adj_factor exactly preserves daily returns.
// 除权参考价 = (prevClose - cash + allot*allotPrice) / (1 + bonus + allot)
//   cash       每股现金分红
//   bonus      每股送转股数
//   allot      每股配股数 (rights issue ratio)
//   allotPrice 配股价
function computeAdjFactors(dates, closeByDate, events) {
	const evByDate = new Map(events.map(e => [e.date, e]));
	const factors = new Map();
	let factor = 1;
	for (let i = 0; i < dates.length; i++) {
		const date = dates[i];
		const ev = evByDate.get(date);
		if (ev && i > 0) {
			const prevClose = closeByDate.get(dates[i - 1]);
			const ref = (prevClose - ev.cash + ev.allot * ev.allotPrice) / (1 + ev.bonus + ev.allot);
			if (ref > 0) {
				const step = prevClose / ref;
				factor *= step;
				log.info(`ex-date ${date}: cash=${ev.cash} bonus=${ev.bonus} allot=${ev.allot}@${ev.allotPrice} -> factor x${step.toFixed(6)} = ${factor.toFixed(6)}`);
			}
		}
		factors.set(date, factor);
	}
	return factors;
}

async function main() {
	if (!argv.codes) {
		console.log('Use --codes to specify stock codes. --help for usage.');
		process.exit(1);
	}

	const codes = argv.codes.split(',').map(c => addExchangePrefix(c.trim()));

	const dedupeByDate = (arr) => {
		const m = new Map();
		for (const r of arr) m.set(r[0], r);
		return m;
	};

	for (const code of codes) {
		log.info(`=== ${code} ===`);
		const [raw, divs, rights] = await Promise.all([fetchKline(code), fetchDividends(code), fetchRights(code)]);
		const events = mergeEvents(divs, rights);

		const rawMap = dedupeByDate(raw);
		const dates = [...rawMap.keys()].sort((a, b) => a.localeCompare(b));

		log.info(`Unique records: ${dates.length}`);
		if (dates.length === 0) {
			log.warn(`No data for ${code}, skipping`);
			continue;
		}

		log.info(`Range: ${dates[0]} ~ ${dates.at(-1)}`);

		for (let i = 1; i < dates.length; i++) {
			const diff = (new Date(dates[i]) - new Date(dates[i - 1])) / 86400000;
			if (diff > 15) log.warn(`Gap: ${dates[i - 1]} -> ${dates[i]} (${Math.round(diff)}d)`);
		}

		const outDir = path.join(resultDir, code);
		fs.mkdirSync(outDir, { recursive: true });

		const closeByDate = new Map(dates.map(d => [d, Number(rawMap.get(d)[2])]));
		const factors = computeAdjFactors(dates, closeByDate, events);

		const rows = dates.map(date => {
			const r = rawMap.get(date);
			return {
				date,
				open: Number(r[1]),
				close: Number(r[2]),
				high: Number(r[3]),
				low: Number(r[4]),
				volume: Number(r[5]) || 0,
				adj_factor: Number(factors.get(date).toFixed(6)),
			};
		});

		const csvPath = path.join(outDir, `${code}_kline.csv`);
		fs.writeFileSync(csvPath, papa.unparse(rows, { columns: CSV_COLUMNS, newline: '\n' }) + '\n');
		log.info(`CSV: ${csvPath} (${rows.length} rows)`);

		const parquetPath = path.join(outDir, `${code}_kline.parquet`);
		const writer = await parquet.ParquetWriter.openFile(parquetSchema, parquetPath);
		for (const row of rows) await writer.appendRow(row);
		await writer.close();
		log.info(`Parquet: ${parquetPath} (${rows.length} rows)`);
	}

	log.info('All done!');
}

main().catch(e => {
	log.error(e);
	process.exit(1);
});
