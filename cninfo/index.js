import Crawler from "crawler";
import fs from "fs";
import path from "path";
import { getLogger } from "../lib/tslog.js";
import dayjs from "dayjs";
import papa from "papaparse";
import minimist from "minimist";

const argv = minimist(process.argv.slice(2), {
	string: ['file', 'codes', 'year', 'date', 'category', 'keyword'],
	boolean: ['annual', 'list', 'pdf-only'],
	default: { count: 30 },
	alias: { h: 'help' },
});

if (argv.help) {
	console.log(`Usage: node index.js [options]

下载A股上市公司公告/年度报告（PDF）数据来源：巨潮资讯网。

Options:
  --file <path>       Stock codes file (one per line, # for comments)
  --codes <list>      Stock codes, comma-separated

  Annual report mode:
  --annual            Download annual reports (年度报告) only
  --year <range>      Fiscal year range, e.g. 2020-2025 or single year 2023

  General announcement mode:
  --date <range>      Date range, e.g. 2025-01-01~2025-06-30 (default: last month)
  --category <code>   Category filter. Common codes:
                        category_ndbg_szsh   = 年度报告
                        category_bndbg_szsh  = 半年度报告
                        category_yjdbg_szsh  = 一季度报告
                        category_sjdbg_szsh  = 三季度报告
                        category_rcgg_szsh   = 日常公告
  --keyword <text>    Title keyword search

  Common:
  --pdf-only          Only download PDF files (skip HTML)
  --list              List results without downloading
  --count <n>         Max results per stock (default: 30, max: 500)
  -h, --help          Show this help message

Examples:
  node index.js --codes 600519 --annual --year 2020-2025
  node index.js --codes 600519 --keyword 分红 --pdf-only
  node index.js --codes 600519 --category category_rcgg_szsh --list`);
	process.exit(0);
}

const identifier = "cninfo";
const resultDir = "./data";
const logDir = "./log";
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format("YYYY-MM-DD")}.log`));

const TOP_SEARCH_URL = "http://www.cninfo.com.cn/new/information/topSearch/query";
const QUERY_URL = "http://www.cninfo.com.cn/new/hisAnnouncement/query";
const STATIC_BASE = "http://static.cninfo.com.cn/";

const FILTER_KEYWORDS = ["摘要", "英文", "更正", "补充", "已取消"];
const csvHeaders = ["code", "secName", "date", "title", "fileType", "fileName", "fileSize", "downloadTime"];

function parseDateRange(dateStr) {
	if (!dateStr) {
		const today = dayjs().format("YYYY-MM-DD");
		const monthAgo = dayjs().subtract(1, 'month').format("YYYY-MM-DD");
		return { from: monthAgo, to: today };
	}
	const parts = dateStr.split(/[~]/).map(p => p.trim()).filter(Boolean);
	if (parts.length >= 2) return { from: parts[0], to: parts[parts.length - 1] };
	const single = parts[0] || dateStr.trim();
	return { from: single, to: single };
}

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

		const isAnnual = argv.annual;
		let startYear, endYear, dateFrom, dateTo;

		if (isAnnual) {
			if (argv.year) {
				const parts = argv.year.split("-");
				startYear = parseInt(parts[0], 10);
				endYear = parts.length > 1 ? parseInt(parts[1], 10) : startYear;
			} else {
				startYear = endYear = dayjs().year();
			}
			dateFrom = `${startYear}-01-01`;
			dateTo = `${endYear + 1}-12-31`;
			log.info(`Annual report mode: fiscal year ${startYear}-${endYear}`);
		} else {
			const range = parseDateRange(argv.date);
			dateFrom = range.from;
			dateTo = range.to;
			log.info(`Date range: ${dateFrom} ~ ${dateTo}`);
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

		if (isAnnual && !argv.list) {
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

		if (!isAnnual) {
			if (argv.category) log.info(`Category filter: ${argv.category}`);
			if (argv.keyword) log.info(`Keyword filter: ${argv.keyword}`);
		}
		if (argv['pdf-only']) log.info(`PDF only mode enabled`);

		this.csvPath = path.resolve(resultDir, `${identifier}_${isAnnual ? 'annual_reports_' : ''}${dayjs().format("YYYY-MM-DD")}.csv`);
		if (!argv.list && !fs.existsSync(this.csvPath)) {
			fs.writeFileSync(this.csvPath, '\ufeff' + csvHeaders.join(',') + '\n');
		}

		const tasks = stocks.map(stockCode => ({
			url: TOP_SEARCH_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Origin': 'http://www.cninfo.com.cn',
				'Referer': 'http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/search',
			},
			body: `keyWord=${stockCode}&maxSecNum=10&maxListNum=5`,
			callback: this.resolveOrg,
			userParams: { stockCode, startYear, endYear, dateFrom, dateTo },
		}));

		this.crawler.add(tasks);
	}

	resolveOrg = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		const { stockCode, startYear, endYear, dateFrom, dateTo } = res.options.userParams;

		let data;
		try {
			data = JSON.parse(res.body);
		} catch (e) {
			log.error(`Failed to parse topSearch response for ${stockCode}: ${e.message}`);
			return done();
		}

		const matches = Array.isArray(data) ? data : (data.keyWordList || []);
		const match = matches.find(m => m.code === stockCode && m.category === "A股");

		if (!match) {
			log.warn(`No A-share match for ${stockCode}. Candidates: ${JSON.stringify(matches.map(m => ({ code: m.code, category: m.category })))}`);
			return done();
		}

		const { orgId, zwjc: secName } = match;
		const exchange = (stockCode[0] === "0" || stockCode[0] === "3") ? "szse" : "sse";

		log.info(`Resolved ${stockCode} -> orgId=${orgId}, name=${secName}, exchange=${exchange}`);

		const isAnnual = argv.annual;
		const category = isAnnual ? "category_ndbg_szsh" : (argv.category || "");
		const count = Math.min(parseInt(argv.count, 10) || 30, 500);
		const keyword = argv.keyword || '';

		const bodyParts = [
			`stock=${stockCode},${orgId}`,
			"tabName=fulltext",
			"pageNum=1",
			`pageSize=${count}`,
			`column=${exchange}`,
			`seDate=${dateFrom}~${dateTo}`,
		];
		if (category) bodyParts.push(`category=${category}`);
		if (keyword) bodyParts.push(`searchkey=${encodeURIComponent(keyword)}`);

		this.crawler.add({
			url: QUERY_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Origin': 'http://www.cninfo.com.cn',
				'Referer': 'http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/search',
			},
			body: bodyParts.join("&"),
			callback: this.queryReports,
			userParams: { stockCode, orgId, secName, exchange, startYear, endYear },
		});

		return done();
	};

	queryReports = (err, res, done) => {
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
			log.error(`Failed to parse query response for ${stockCode}: ${e.message}`);
			return done();
		}

		const announcements = data.announcements || [];
		log.info(`Found ${announcements.length} announcements for ${stockCode} (${secName})`);

		if (data.hasMore && data.totalpages > 1) {
			log.warn(`${stockCode}: ${data.totalpages} pages of results, only page 1 processed. Use --count to increase.`);
		}

		let filtered;
		if (isAnnual) {
			filtered = announcements.filter(a => {
				const title = a.announcementTitle || "";
				if (FILTER_KEYWORDS.some(kw => title.includes(kw))) return false;
				const yearMatch = title.match(/(\d{4})\s*年/);
				if (!yearMatch) return false;
				const fy = parseInt(yearMatch[1], 10);
				return fy >= startYear && fy <= endYear;
			});
			log.info(`After annual filter: ${filtered.length} main reports for ${stockCode} (fiscal year ${startYear}-${endYear})`);
		} else {
			filtered = announcements;
			if (argv['pdf-only']) {
				filtered = filtered.filter(a => (a.adjunctType || "").toLowerCase() === "pdf");
				log.info(`After PDF filter: ${filtered.length} results for ${stockCode}`);
			}
		}

		if (argv.list) {
			for (const a of filtered) {
				const date = a.announcementTime ? dayjs(a.announcementTime).format("YYYY-MM-DD") : '';
				const type = a.adjunctType || 'PDF';
				console.log(`${stockCode}\t${date}\t${type}\t${a.announcementTitle}`);
			}
			return done();
		}

		const codeDir = path.resolve(resultDir, stockCode);
		if (!fs.existsSync(codeDir)) fs.mkdirSync(codeDir, { recursive: true });

		for (const a of filtered) {
			let fileName;
			let year;
			const date = a.announcementTime ? dayjs(a.announcementTime).format("YYYY-MM-DD") : 'unknown';
			const title = a.announcementTitle || '';
			const fileType = a.adjunctType || 'PDF';

			if (isAnnual) {
				const yearMatch = title.match(/(\d{4})\s*年/);
				year = yearMatch ? yearMatch[1] : "unknown";
				const safeName = secName.replace(/[\/\\:*?"<>|]/g, "_");
				fileName = `${year}_${safeName}_年度报告.pdf`;
			} else {
				const ext = fileType.toLowerCase() === "pdf" ? "pdf" : "htm";
				const safeTitle = title.replace(/[\/\\:*?"<>|\n\r]/g, "_").slice(0, 60);
				fileName = `${date}_${safeTitle}.${ext}`;
			}
			const filePath = path.resolve(codeDir, fileName);

			if (fs.existsSync(filePath)) {
				log.info(`Already exists, skipping: ${fileName}`);
				continue;
			}

			this.crawler.add({
				url: `${STATIC_BASE}${a.adjunctUrl}`,
				encoding: null,
				timeout: 120000,
				callback: this.downloadFile,
				userParams: {
					stockCode,
					secName,
					date: isAnnual ? year : date,
					title,
					fileType,
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
			log.error(`Invalid response for ${fileName}: not a valid buffer (length=${res.body?.length})`);
			return done();
		}

		fs.writeFileSync(filePath, res.body);
		log.info(`Saved: ${fileName} (${(res.body.length / 1024 / 1024).toFixed(2)} MB)`);

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
