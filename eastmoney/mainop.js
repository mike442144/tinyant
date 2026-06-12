import Crawler from "crawler";
import fs from "fs";
import path from "path";
import { getLogger } from "../lib/tslog.js";
import dayjs from "dayjs";
import papa from "papaparse";
import {__, modify, divide, pick} from 'ramda';

import minimist from 'minimist';

const argv = minimist(process.argv.slice(2), {
	string: ['file', 'codes', 'date'],
	default: { count: 200 },
	alias: { h: 'help' },
});

if (argv.help) {
	console.log(`Usage: node mainop.js [options]

获取上市公司主营构成（按行业/按产品/按地区）数据。

Options:
  --file <path>       Stock codes file (one per line, # for comments)
  --codes <list>      Stock codes, comma-separated
  --date <list>       Report date(s), comma-separated, e.g. 2024-12-31.
                      Omit to fetch all available periods.
  --count <n>         Page size (max rows per request, default: 200)
  -h, --help          Show this help message`);
	process.exit(0);
}

const identifier = "eastmoney";
const resultDir = "./data";
const logDir = "./log";
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format("YYYY-MM-DD")}.log`));

// 主营构成分类：1=按行业，2=按产品，3=按地区
const MAINOP_TYPE_NAMES = { '1': '按行业', '2': '按产品', '3': '按地区' };

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
			},
		});

		this.crawler
			.on("drain", () => {
				log.info(`Task Complete.`);
			})
			.on("schedule", options => {
			});

		this.headers = ['SECUCODE','SECURITY_CODE','REPORT_DATE','MAINOP_TYPE','MAINOP_TYPE_NAME','ITEM_NAME','MAIN_BUSINESS_INCOME','MBI_RATIO','MAIN_BUSINESS_COST','MBC_RATIO','MAIN_BUSINESS_RPOFIT','MBR_RATIO','GROSS_RPOFIT_RATIO','RANK'];
	}

	start() {
		if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });
		if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

		log.info(`start working...`);

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

		const dates = argv.date
			? argv.date.split(',').map(s => s.trim()).filter(Boolean)
			: [null];

		const columns = 'SECUCODE,SECURITY_CODE,REPORT_DATE,MAINOP_TYPE,ITEM_NAME,MAIN_BUSINESS_INCOME,MBI_RATIO,MAIN_BUSINESS_COST,MBC_RATIO,MAIN_BUSINESS_RPOFIT,MBR_RATIO,GROSS_RPOFIT_RATIO,RANK';

		const tasks = [];
		for (const stockCode of stocks) {
			const secucode = `${stockCode}.${stockCode[0]=="0"||stockCode[0]=="3"?"SZ":"SH"}`;
			for (const date of dates) {
				const dateFilter = date ? `(REPORT_DATE%3D%27${date}%27)` : '';
				const filter = `(SECUCODE%3D%22${secucode}%22)${dateFilter}`;
				const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FN_MAINOP&columns=${encodeURIComponent(columns)}&quoteColumns=&filter=${filter}&pageNumber=1&pageSize=${argv.count}&sortTypes=-1%2C1%2C1&sortColumns=REPORT_DATE%2CMAINOP_TYPE%2CRANK&source=HSF10&client=PC&v=04517092374215784`;

				tasks.push({
					url,
					method: 'GET',
					headers: {
						'Accept': '*/*',
						'Accept-Encoding': 'identity;q=1, *;q=0',
						'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
						'Connection': 'keep-alive',
						'Origin': 'https://emweb.securities.eastmoney.com',
						'Range': 'bytes=0-',
						'Referer': 'https://emweb.securities.eastmoney.com/',
						'Sec-Fetch-Dest': 'empty',
						'Sec-Fetch-Mode': 'cors',
						'Sec-Fetch-Site': 'same-site',
					},
					callback: this.oneStock,
					userParams: {
						stockCode,
						date,
					},
				});
			}
		}

		this.crawler.add(tasks);
	}

	oneStock = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		let body = null;
		try{
			body = JSON.parse(res.body);
		}catch(e){
			log.error(e);
			return done();
		}

		const {stockCode, date} = res.options.userParams;

		if(!body.success){
			log.error(`stock: ${stockCode}${date ? `, date: ${date}` : ''}, ${body.message}`);
			return done();
		}

		const mn = divide(__, 1000000);
		const datapoints = body.result.data
			  .map(pick(this.headers))
			  .map(row => ({...row, MAINOP_TYPE_NAME: MAINOP_TYPE_NAMES[row.MAINOP_TYPE] || row.MAINOP_TYPE}))
			  .map(modify('MAIN_BUSINESS_INCOME', mn))
			  .map(modify('MAIN_BUSINESS_COST', mn))
			  .map(modify('MAIN_BUSINESS_RPOFIT', mn))
		;

		log.info(`stock: ${stockCode}${date ? `, date: ${date}` : ''}, count: ${datapoints.length}`);

		if(datapoints.length > 0){
			const csvPath = path.resolve(resultDir, `${identifier}_mainop_${dayjs().format("YYYY-MM-DD")}.csv`);
			if (!fs.existsSync(csvPath)){
				fs.writeFileSync(csvPath, '﻿' + this.headers.join(',') + '\n');
			}
			fs.appendFileSync(
				csvPath,
				papa.unparse(datapoints, {header:false,columns: this.headers}) + "\n"
			);
		}

		return done();
	};
}

const task = new Task();
task.start();
