import Crawler from "crawler";
import fs from "fs";
import path from "path";
import { getLogger } from "../lib/tslog.js";
import dayjs from "dayjs";
import papa from "papaparse";
import minimist from "minimist";

const argv = minimist(process.argv.slice(2), {
	string: ['file', 'codes', 'year'],
	alias: { h: 'help' },
});

if (argv.help) {
	console.log(`Usage: node index.js [options]

下载港股上市公司年度报告（PDF）数据来源：hkexnews.hk（披露易）。

Options:
  --file <path>       Stock codes file (one per line, # for comments)
  --codes <list>      Stock codes, comma-separated (e.g. 00700,09988)
  --year <range>      Fiscal year range, e.g. 2020-2025 or single year 2023 (default: current year)
  -h, --help          Show this help message`);
	process.exit(0);
}

const identifier = "hkexnews";
const resultDir = "./data";
const logDir = "./log";
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format("YYYY-MM-DD")}.log`));

const STOCK_LIST_URL = "https://www1.hkexnews.hk/ncms/script/eds/activestock_sehk_c.json";
const SEARCH_URL = "https://www1.hkexnews.hk/search/titleSearchServlet.do";
const NEWS_BASE = "https://www1.hkexnews.hk";

const csvHeaders = ["code", "secName", "year", "title", "fileName", "fileSize", "downloadTime"];

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

		let startYear, endYear;
		if (argv.year) {
			const parts = argv.year.split("-");
			startYear = parseInt(parts[0], 10);
			endYear = parts.length > 1 ? parseInt(parts[1], 10) : startYear;
		} else {
			startYear = endYear = dayjs().year();
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
		log.info(`Year range: ${startYear}-${endYear}`);

		this.csvPath = path.resolve(resultDir, `${identifier}_annual_reports_${dayjs().format("YYYY-MM-DD")}.csv`);
		if (!fs.existsSync(this.csvPath)) {
			fs.writeFileSync(this.csvPath, '\ufeff' + csvHeaders.join(',') + '\n');
		}

		this.crawler.add({
			url: STOCK_LIST_URL,
			callback: this.resolveStockId,
			userParams: { stocks, startYear, endYear },
		});
	}

	resolveStockId = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		const { stocks, startYear, endYear } = res.options.userParams;

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

		const tasks = [];
		for (const stockCode of stocks) {
			const info = stockMap.get(stockCode);
			if (!info) {
				log.warn(`Stock code ${stockCode} not found in active stock list.`);
				continue;
			}

			const { stockId, secName } = info;
			const fromDate = `${startYear}0101`;
			const toDate = `${endYear + 1}1231`;
			const url = `${SEARCH_URL}?sortDir=0&sortByOptions=DateTime&category=0&market=SEHK&stockId=${stockId}&documentType=-1&fromDate=${fromDate}&toDate=${toDate}&title=&searchType=1&t1code=40000&t2Gcode=-1&t2code=40100&rowRange=100&lang=zh`;

			tasks.push({
				url,
				callback: this.queryReports,
				userParams: { stockCode, stockId, secName, startYear, endYear },
			});
		}

		if (tasks.length > 0) {
			this.crawler.add(tasks);
		}

		return done();
	};

	queryReports = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		const { stockCode, secName, startYear, endYear } = res.options.userParams;

		let data;
		try {
			data = JSON.parse(res.body);
		} catch (e) {
			log.error(`Failed to parse search response for ${stockCode}: ${e.message}`);
			return done();
		}

		let reports;
		try {
			reports = JSON.parse(data.result);
		} catch (e) {
			log.error(`Failed to parse result for ${stockCode}: ${e.message}`);
			return done();
		}

		log.info(`Found ${reports.length} annual reports for ${stockCode} (${secName})`);

		if (data.hasNextRow) {
			log.warn(`${stockCode}: more than ${data.rowRange} results, only first page processed.`);
		}

		const mainReports = reports.filter(r => {
			if (r.FILE_TYPE !== "PDF") return false;
			const yearMatch = r.TITLE.match(/(\d{4})/);
			if (!yearMatch) return false;
			const fy = parseInt(yearMatch[1], 10);
			return fy >= startYear && fy <= endYear;
		});

		log.info(`After filtering: ${mainReports.length} PDF reports for ${stockCode} (fiscal year ${startYear}-${endYear})`);

		const codeDir = path.resolve(resultDir, stockCode);
		if (!fs.existsSync(codeDir)) fs.mkdirSync(codeDir, { recursive: true });

		for (const report of mainReports) {
			const yearMatch = report.TITLE.match(/(\d{4})/);
			const year = yearMatch[1];

			const safeName = secName.replace(/[\/\\:*?"<>|]/g, "_");
			const fileName = `${year}_${safeName}_年度报告.pdf`;
			const filePath = path.resolve(codeDir, fileName);

			if (fs.existsSync(filePath)) {
				log.info(`Already exists, skipping: ${fileName}`);
				continue;
			}

			this.crawler.add({
				url: `${NEWS_BASE}${report.FILE_LINK}`,
				encoding: null,
				timeout: 120000,
				callback: this.downloadPdf,
				userParams: {
					stockCode,
					secName,
					year,
					title: report.TITLE,
					fileName,
					filePath,
				},
			});
		}

		return done();
	};

	downloadPdf = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		const { stockCode, secName, year, title, fileName, filePath } = res.options.userParams;

		if (!Buffer.isBuffer(res.body) || res.body.length < 4) {
			log.error(`Invalid response for ${fileName}: not a valid buffer (length=${res.body?.length})`);
			return done();
		}

		fs.writeFileSync(filePath, res.body);
		log.info(`Saved: ${fileName} (${(res.body.length / 1024 / 1024).toFixed(2)} MB)`);

		const row = {
			code: stockCode,
			secName,
			year,
			title,
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
