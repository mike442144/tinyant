import Crawler from 'crawler';
import fs from 'fs';
import path from 'path';
import { getLogger } from '../lib/tslog.js';
import dayjs from 'dayjs';
import papa from 'papaparse';
import minimist from 'minimist';
import parquet from 'parquetjs';

const ADJ_TYPES = { qfq: 'qfqday', hfq: 'hfqday', none: 'day' };

const argv = minimist(process.argv.slice(2), {
	string: ['codes', 'date', 'adj'],
	default: { adj: 'qfq' },
	alias: { h: 'help' },
});

if (argv.help) {
	console.log(`Usage: node index.js [options]

下载股票日K线数据，来源：腾讯财经 (web.ifzq.gtimg.cn)。
输出 CSV + Parquet 文件（Parquet 可直接用 pandas 读取）。

Options:
  --codes <list>    Stock codes, comma-separated (e.g. sh600519,sz000001)
                    Prefix sh/sz is auto-detected if omitted
  --date <range>    Date range, e.g. 2020-01-01~2025-12-31 (default: full history)
  --adj <type>      Price adjustment type (default: qfq)
                      qfq  = 前复权 (forward-adjusted)
                      hfq  = 后复权 (backward-adjusted)
                      none = 不复权 (unadjusted)
  -h, --help        Show this help message

Examples:
  node index.js --codes sh600519
  node index.js --codes 600519,000001 --date 2020-01-01~2025-12-31
  node index.js --codes sh600519 --adj hfq
  node index.js --codes sh600519 --adj none

Output saved to ./data/<code>/
  <code>_kline.csv       CSV format
  <code>_kline.parquet   Parquet (pd.read_parquet('<code>_kline.parquet'))`);
	process.exit(0);
}

const identifier = 'marketdata';
const resultDir = './data';
const logDir = './log';
fs.mkdirSync(logDir, { recursive: true });
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format('YYYY-MM-DD')}.log`));

const CSV_COLUMNS = ['date', 'open', 'close', 'high', 'low', 'volume'];

const parquetSchema = new parquet.ParquetSchema({
	date: { type: 'UTF8' },
	open: { type: 'DOUBLE' },
	close: { type: 'DOUBLE' },
	high: { type: 'DOUBLE' },
	low: { type: 'DOUBLE' },
	volume: { type: 'DOUBLE' },
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

function fetchKline(code, adj) {
	const fromDate = argv.date ? argv.date.split('~')[0].trim() : '2000-01-01';
	const toDate = argv.date ? (argv.date.split('~')[1]?.trim() || dayjs().format('YYYY-MM-DD')) : dayjs().format('YYYY-MM-DD');

	log.info(`Fetching ${code} [${adj}] from ${fromDate} to ${toDate}`);

	const segments = generateSegments(fromDate, toDate);
	log.info(`Split into ${segments.length} segments (~6 months each)`);

	const dataKey = ADJ_TYPES[adj];
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
						const dayData = stockData[dataKey] || stockData.day || [];
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

		const adjParam = adj === 'none' ? '' : adj;
		for (const [s, e] of segments) {
			const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,${s},${e},320,${adjParam}`;
			c.add({ url, userParams: { label: `${s}~${e}` } });
		}
	});
}

async function main() {
	if (!argv.codes) {
		console.log('Use --codes to specify stock codes. --help for usage.');
		process.exit(1);
	}

	const adj = argv.adj.toLowerCase();
	if (!ADJ_TYPES[adj]) {
		console.error(`Invalid --adj type: "${argv.adj}". Must be one of: qfq, hfq, none`);
		process.exit(1);
	}

	const codes = argv.codes.split(',').map(c => addExchangePrefix(c.trim()));
	const adjSuffix = adj === 'qfq' ? '' : `_${adj}`;

	for (const code of codes) {
		log.info(`=== ${code} [${adj}] ===`);
		const rawData = await fetchKline(code, adj);

		const seen = new Map();
		for (const r of rawData) seen.set(r[0], r);
		const deduped = [...seen.values()].sort((a, b) => a[0].localeCompare(b[0]));

		log.info(`Unique records: ${deduped.length}`);
		if (deduped.length === 0) {
			log.warn(`No data for ${code}, skipping`);
			continue;
		}

		log.info(`Range: ${deduped[0][0]} ~ ${deduped.at(-1)[0]}`);

		for (let i = 1; i < deduped.length; i++) {
			const diff = (new Date(deduped[i][0]) - new Date(deduped[i - 1][0])) / 86400000;
			if (diff > 15) log.warn(`Gap: ${deduped[i - 1][0]} -> ${deduped[i][0]} (${Math.round(diff)}d)`);
		}

		const outDir = path.join(resultDir, code);
		fs.mkdirSync(outDir, { recursive: true });

		const rows = deduped.map(r => ({
			date: r[0],
			open: Number(r[1]),
			close: Number(r[2]),
			high: Number(r[3]),
			low: Number(r[4]),
			volume: Number(r[5]) || 0,
		}));

		const csvPath = path.join(outDir, `${code}_kline${adjSuffix}.csv`);
		fs.writeFileSync(csvPath, papa.unparse(rows, { columns: CSV_COLUMNS }));
		log.info(`CSV: ${csvPath} (${rows.length} rows)`);

		const parquetPath = path.join(outDir, `${code}_kline${adjSuffix}.parquet`);
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
