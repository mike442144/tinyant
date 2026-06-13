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

下载A股上市公司年度报告（PDF）数据来源：巨潮资讯网。

Options:
  --file <path>       Stock codes file (one per line, # for comments)
  --codes <list>      Stock codes, comma-separated
  --year <range>      Fiscal year range, e.g. 2020-2025 or single year 2023 (default: current year)
  -h, --help          Show this help message`);
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
			userParams: { stockCode, startYear, endYear },
		}));

		this.crawler.add(tasks);
	}

	resolveOrg = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		const { stockCode, startYear, endYear } = res.options.userParams;

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

		this.crawler.add({
			url: QUERY_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Origin': 'http://www.cninfo.com.cn',
				'Referer': 'http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/search',
			},
			body: [
				`stock=${stockCode},${orgId}`,
				"tabName=fulltext",
				"category=category_ndbg_szsh",
				"pageNum=1",
				"pageSize=30",
				`column=${exchange}`,
				`seDate=${startYear}-01-01~${endYear + 1}-12-31`,
			].join("&"),
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
			log.warn(`${stockCode}: ${data.totalpages} pages of results, only page 1 processed.`);
		}

		const mainReports = announcements.filter(a => {
			const title = a.announcementTitle || "";
			if (FILTER_KEYWORDS.some(kw => title.includes(kw))) return false;
			const yearMatch = title.match(/(\d{4})\s*年/);
			if (!yearMatch) return false;
			const fy = parseInt(yearMatch[1], 10);
			return fy >= startYear && fy <= endYear;
		});

		log.info(`After filtering: ${mainReports.length} main reports for ${stockCode} (fiscal year ${startYear}-${endYear})`);

		const codeDir = path.resolve(resultDir, stockCode);
		if (!fs.existsSync(codeDir)) fs.mkdirSync(codeDir, { recursive: true });

		for (const report of mainReports) {
			const yearMatch = report.announcementTitle.match(/(\d{4})\s*年/);
			const year = yearMatch ? yearMatch[1] : "unknown";

			const safeName = secName.replace(/[\/\\:*?"<>|]/g, "_");
			const fileName = `${year}_${safeName}_年度报告.pdf`;
			const filePath = path.resolve(codeDir, fileName);

			if (fs.existsSync(filePath)) {
				log.info(`Already exists, skipping: ${fileName}`);
				continue;
			}

			this.crawler.add({
				url: `${STATIC_BASE}${report.adjunctUrl}`,
				encoding: null,
				timeout: 120000,
				callback: this.downloadPdf,
				userParams: {
					stockCode,
					secName,
					year,
					title: report.announcementTitle,
					fileName,
					filePath,
					adjunctSize: report.adjunctSize,
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
