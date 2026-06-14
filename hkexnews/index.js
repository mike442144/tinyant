import Crawler from "crawler";
import fs from "fs";
import path from "path";
import { getLogger } from "../lib/tslog.js";
import dayjs from "dayjs";
import papa from "papaparse";
import minimist from "minimist";
import { parseDateRangeHkex, sanitizeFilename, extractFiscalYearHk } from "../lib/utils.js";

const argv = minimist(process.argv.slice(2), {
	string: ['file', 'codes', 'date', 'year', 'category', 'keyword'],
	boolean: ['annual', 'list', 'pdf-only'],
	default: { count: 30 },
	alias: { h: 'help' },
});

if (argv.help) {
	console.log(`Usage: node index.js [options]

下载港股上市公司公告/年度报告（PDF）数据来源：hkexnews.hk（披露易）。

Options:
  --file <path>       Stock codes file (one per line, # for comments)
  --codes <list>      Stock codes, comma-separated (e.g. 00700,09988)

  Annual report mode:
  --annual            Download annual reports (年度报告) only
  --year <range>      Fiscal year range, e.g. 2020-2025 or single year 2023

  General announcement mode:
  --date <range>      Date range, e.g. 20250101-20250630 (default: last month)
  --category <code>   Tier 1 category code. Common codes:
                        10000 = 公告及通告    40000 = 财务报表/ESG
                        20000 = 通函          50000 = 翌日披露报表
                        30000 = 上市文件      51500 = 月报表
  --keyword <text>    Title keyword search

  Common:
  --pdf-only          Only download PDF files (skip HTML)
  --list              List results without downloading
  --count <n>         Max results per stock (default: 30, max: 1000)
  -h, --help          Show this help message

Examples:
  node index.js --codes 00700 --annual --year 2020-2025
  node index.js --codes 00700 --category 10000 --list
  node index.js --codes 00700 --keyword 業績 --pdf-only`);
	process.exit(0);
}

const identifier = "hkexnews_ann";
const resultDir = "./data";
const logDir = "./log";
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format("YYYY-MM-DD")}.log`));

const STOCK_LIST_URL = "https://www1.hkexnews.hk/ncms/script/eds/activestock_sehk_c.json";
const SEARCH_URL = "https://www1.hkexnews.hk/search/titleSearchServlet.do";
const NEWS_BASE = "https://www1.hkexnews.hk";

const csvHeaders = ["code", "secName", "date", "title", "fileType", "fileName", "fileSize", "downloadTime"];

class Task {
	constructor() {
		this.crawler = new Crawler({
			maxConnections: 1,
			rejectUnauthorized: false,
			jQuery: false,
			timeout: 30000,
			rateLimit: 10000,
			headers: {
				"user-agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
				"Accept": "application/json, text/plain, */*",
				"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
			},
		});

		this.crawler
			.on("drain", () => {
				log.info(`Task Complete.`);
			})
			.on("schedule", options => {
			});
	}

	start() {
		if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });
		if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

		let from, to, startYear, endYear;
		if (argv.annual) {
			if (argv.year) {
				const parts = argv.year.split("-");
				startYear = parseInt(parts[0], 10);
				endYear = parts.length > 1 ? parseInt(parts[1], 10) : startYear;
			} else {
				startYear = endYear = dayjs().year();
			}
			from = `${startYear}0101`;
			to = `${endYear + 1}1231`;
			log.info(`Annual report mode: fiscal year ${startYear}-${endYear}`);
		} else {
			const range = parseDateRangeHkex(argv.date);
			from = range.from;
			to = range.to;
			log.info(`Date range: ${from}-${to}`);
		}

		let stocks = [];
		if (argv.file) {
			stocks = fs.readFileSync(argv.file, 'utf-8')
				.split(/\r?\n/)
				.map(s => s.trim())
				.filter(s => s && !s.startsWith('#'));
		} else if (argv.codes) {
			stocks = argv.codes.split(',').map(s => s.trim()).filter(Boolean);
		} else {
			log.error('Please provide stock codes via --file <path> or --codes <code1,code2,...>');
			process.exit(1);
		}
		log.info(`Stock codes loaded: ${stocks.join(', ')}`);

		if (argv.annual && !argv.list) {
			const pendingStocks = stocks.filter(stockCode => {
				const codeDir = path.resolve(resultDir, stockCode);
				const files = fs.existsSync(codeDir) ? fs.readdirSync(codeDir) : [];
				for (let y = startYear; y <= endYear; y++) {
					if (!files.some(f => f.startsWith(`${y}_`) && f.endsWith("_年度报告.pdf"))) return true;
				}
				log.info(`${stockCode}: all years ${startYear}-${endYear} already downloaded, skipping.`);
				return false;
			});
			if (pendingStocks.length === 0) {
				log.info(`All stocks already downloaded. Nothing to do.`);
				return;
			}
			stocks = pendingStocks;
			log.info(`Pending stocks: ${stocks.join(', ')}`);
		}

		if (!argv.annual) {
			if (argv.category) log.info(`Category filter: ${argv.category}`);
			if (argv.keyword) log.info(`Keyword filter: ${argv.keyword}`);
		}
		if (argv['pdf-only']) log.info(`PDF only mode enabled`);

		this.csvPath = path.resolve(resultDir, `${identifier}_${dayjs().format("YYYY-MM-DD")}.csv`);
		if (!argv.list && !fs.existsSync(this.csvPath)) {
			fs.writeFileSync(this.csvPath, '\ufeff' + csvHeaders.join(',') + '\n');
		}

		this.crawler.add({
			url: STOCK_LIST_URL,
			callback: this.resolveStockId,
			userParams: { stocks, from, to, startYear, endYear },
		});
	}

	resolveStockId = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		const { stocks, from, to, startYear, endYear } = res.options.userParams;

		let stockList;
		try {
			stockList = JSON.parse(res.body);
		} catch (e) {
			log.error(`Failed to parse stock list: ${e.message}`);
			return done();
		}

		const stockMap = new Map();
		for (const item of stockList) {
			stockMap.set(item.c, { stockId: item.i, secName: item.n });
		}

		const isAnnual = argv.annual;
		const t1code = isAnnual ? '40000' : (argv.category || '');
		const t2code = isAnnual ? '40100' : '';
		const title = argv.keyword || '';
		const count = Math.min(parseInt(argv.count, 10) || 30, 1000);

		const tasks = [];
		for (const stockCode of stocks) {
			const info = stockMap.get(stockCode);
			if (!info) {
				log.warn(`Stock code ${stockCode} not found in active stock list.`);
				continue;
			}

			const { stockId, secName } = info;
			const params = [
				'sortDir=0',
				'sortByOptions=DateTime',
				'category=0',
				'market=SEHK',
				`stockId=${stockId}`,
				'documentType=-1',
				`fromDate=${from}`,
				`toDate=${to}`,
				`title=${encodeURIComponent(title)}`,
				`searchType=${isAnnual ? '1' : '0'}`,
				`rowRange=${count}`,
				'lang=zh',
			];
			if (t1code) params.push(`t1code=${t1code}`);
			if (t2code) params.push(`t2code=${t2code}`);

			tasks.push({
				url: `${SEARCH_URL}?${params.join('&')}`,
				callback: this.queryResults,
				userParams: { stockCode, secName, from, to, startYear, endYear },
			});
		}

		if (tasks.length > 0) {
			this.crawler.add(tasks);
		}

		return done();
	};

	queryResults = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		const { stockCode, secName, startYear, endYear } = res.options.userParams;
		const isAnnual = argv.annual;

		let data;
		try {
			data = JSON.parse(res.body);
		} catch (e) {
			log.error(`Failed to parse response for ${stockCode}: ${e.message}`);
			return done();
		}

		let results;
		try {
			results = JSON.parse(data.result) || [];
		} catch (e) {
			log.error(`Failed to parse result for ${stockCode}: ${e.message}`);
			return done();
		}

		log.info(`Found ${results.length} results for ${stockCode} (${secName})`);

		if (data.hasNextRow) {
			log.warn(`${stockCode}: more than ${data.rowRange} results. Use --count to increase or narrow the date range.`);
		}

		if (isAnnual) {
			results = results.filter(r => {
				if (r.FILE_TYPE !== "PDF") return false;
				const fy = extractFiscalYearHk(r.TITLE);
				if (!fy) return false;
				const fyNum = parseInt(fy, 10);
				return fyNum >= startYear && fyNum <= endYear;
			});
			log.info(`After annual filter: ${results.length} reports for ${stockCode} (fiscal year ${startYear}-${endYear})`);
		} else if (argv['pdf-only']) {
			results = results.filter(r => r.FILE_TYPE === "PDF");
			log.info(`After PDF filter: ${results.length} results for ${stockCode}`);
		}

		if (argv.list) {
			for (const r of results) {
				const date = r.DATE_TIME?.split(' ')[0] || '';
				console.log(`${stockCode}\t${date}\t${r.FILE_TYPE}\t${r.TITLE}`);
			}
			return done();
		}

		const codeDir = path.resolve(resultDir, stockCode);
		if (!fs.existsSync(codeDir)) fs.mkdirSync(codeDir, { recursive: true });

		for (const r of results) {
			let fileName;
			let date;
			if (isAnnual) {
				const year = extractFiscalYearHk(r.TITLE) || "unknown";
				date = year;
				fileName = `${year}_${sanitizeFilename(secName)}_年度报告.pdf`;
			} else {
				date = r.DATE_TIME?.split(' ')[0]?.replace(/\//g, '') || 'unknown';
				const ext = r.FILE_TYPE === "PDF" ? "pdf" : "htm";
				fileName = `${date}_${sanitizeFilename(r.TITLE)}.${ext}`;
			}
			const filePath = path.resolve(codeDir, fileName);

			if (fs.existsSync(filePath)) {
				log.info(`Already exists, skipping: ${fileName}`);
				continue;
			}

			this.crawler.add({
				url: `${NEWS_BASE}${r.FILE_LINK}`,
				encoding: null,
				timeout: 120000,
				callback: this.downloadFile,
				userParams: {
					stockCode,
					secName,
					date,
					title: r.TITLE,
					fileType: r.FILE_TYPE,
					fileName,
					filePath,
				},
			});
		}

		return done();
	};

	downloadFile = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		const { stockCode, secName, date, title, fileType, fileName, filePath } = res.options.userParams;

		if (!Buffer.isBuffer(res.body) || res.body.length < 4) {
			log.error(`Invalid response for ${fileName}: not a valid buffer`);
			return done();
		}

		fs.writeFileSync(filePath, res.body);
		log.info(`Saved: ${fileName} (${(res.body.length / 1024).toFixed(0)} KB)`);

		const row = {
			code: stockCode,
			secName,
			date,
			title,
			fileType,
			fileName,
			fileSize: res.body.length,
			downloadTime: dayjs().format("YYYY-MM-DD HH:mm:ss"),
		};
		fs.appendFileSync(
			this.csvPath,
			papa.unparse([row], { header: false, columns: csvHeaders }) + "\n"
		);

		return done();
	};
}

const task = new Task();
task.start();
