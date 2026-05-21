import Crawler from "crawler";
import fs from "fs";
import path from "path";
import { getLogger } from "../lib/tslog.js";
import dayjs from "dayjs";
import papa from "papaparse";
import {default as URL} from "url";
import {__, modify, divide, props, pick, uniqBy, prop, mergeRight} from 'ramda';

import minimist from 'minimist';

const argv = minimist(process.argv.slice(2), {
	string: ['file', 'codes'],
	default: { period: 'q', count: 4 },
	alias: { h: 'help' },
});

if (argv.help) {
	console.log(`Usage: node index.js [options]

Options:
  --file <path>       Stock codes file (one per line, # for comments)
  --codes <list>      Stock codes, comma-separated
  --period <q|y>      Report period: q=quarterly (default), y=yearly
  --count <n>         Number of reports to fetch (default: 4)
  -h, --help          Show this help message`);
	process.exit(0);
}

const identifier = "eastmoney";
const resultDir = "./data";
const logDir = "./log";
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format("YYYY-MM-DD")}.log`));

class Task {
	constructor() {
		this.crawler = new Crawler({
			maxConnections: 1,
			//http2: true,
			rejectUnauthorized: false,
			jQuery: false,
			//debug:true,
			timeout: 30000,
			rateLimit: 10000,
			//skipDuplicates: false,
			headers: {
				"user-agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
				//"priority": "u=1, i",
				//"cookie": 'jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2NmJlYzY0MzYxNjZhMmRmM2YyYzQzMzYiLCJpYXQiOjE3MjM3Nzg2MjgsImV4cCI6MTc0OTY5ODYyOH0.8QqXfG3HEKP1Xn5KEw4SiY7mbnS0hgr7tFQZpqtcqpc'
			},
		});

		this.crawler
			.on("drain", () => {
				log.info(`Task Complete.`);
			})
			.on("schedule", options => {
			});

		this.headers = ['SECUCODE','SECURITY_CODE','SECURITY_NAME_ABBR','REPORT_TYPE','REPORT_YEAR', 'REPORT_DATE', 'KCFJCXSYJLR','TOTALOPERATEREVE','GROSS_PROFIT', 'PARENTNETPROFIT', 'DEDU_PARENT_PROFIT'];
	}

	start() {
		if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });
		if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

		log.info(`start working...`);

		// try{
		// 	fs.accessSync(path.resolve(resultDir, `${identifier}_industries_${dayjs().format("YYYY-MM-DD")}.csv`), fs.constants.R_OK | fs.constants.W_OK);
		// }catch(e){//create file with header
		// 	fs.writeFileSync(path.resolve(resultDir, `${identifier}_industries_${dayjs().format("YYYY-MM-DD")}.csv`), `\ufeff${this.headers}\n`);
		// }

		// try{
		// 	fs.accessSync(path.resolve(resultDir, `${identifier}_stocks_${dayjs().format("YYYY-MM-DD")}.csv`), fs.constants.R_OK | fs.constants.W_OK);
		// }catch(e){//create file with header
		// 	fs.writeFileSync(path.resolve(resultDir, `${identifier}_stocks_${dayjs().format("YYYY-MM-DD")}.csv`), `\ufeff${[...this.headers, 'industryName','industryCode']}\n`);
		// }

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

		const tasks = stocks.map(stockCode => {
			const secucode = `${stockCode}.${stockCode[0]=="0"||stockCode[0]=="3"?"SZ":"SH"}`;
			const periodFilter = argv.period === 'y'
				? `(REPORT_TYPE%3D%22%E5%B9%B4%E6%8A%A5%22)`
				: '';
			const filter = `(SECUCODE%3D%22${secucode}%22)${periodFilter}`;
			const url = argv.period === 'y'
				? `https://datacenter.eastmoney.com/securities/api/data/get?type=RPT_F10_FINANCE_MAINFINADATA&sty=APP_F10_MAINFINADATA&quoteColumns=&filter=${filter}&p=1&ps=${argv.count}&sr=-1&st=REPORT_DATE&source=HSF10&client=PC&v=03766301272986985`
				: `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_QTR_MAINFINADATA&columns=ALL&quoteColumns=&filter=${filter}&pageNumber=1&pageSize=${argv.count}&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC&v=09714690248405493`;

			return {
			url,
			method:'GET',
			headers:{
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
			//json: {"granularity":"y10","priceMetricsType":"mcw","source":"cni","level":"three","groupIds":"all","fsMetricsNames":["roe"],"priceMetricsNames":["mc","dyr","pe_ttm","pb","ps_ttm"],"sortName":"pm.pe_ttm.cv","sortOrder":"asc","pageIndex":0,"pageSize":100},
			userParams: {
				stockCode
			},
		};
		});

		this.crawler.add(tasks);
	}

	industryList = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		//log.info(res);

		let data = null;
		try{
			data = JSON.parse(res.body);
		}catch(e){
			log.error(e);
		}

		fs.writeFileSync('/tmp/eastmoney.report.json', res.body);



		// const industries = data.list.map(prop('stock')).map(pick(this.headers));

		// fs.appendFileSync(
		// 	path.resolve(resultDir, `${identifier}_industries_${dayjs().format("YYYY-MM-DD")}.csv`),
		// 	papa.unparse(industries, {header:false,columns:this.headers}) + "\n"
		// );

		// log.info(`${industries.length} industries found.`);

		// const tasks = industries.map(ind => ({
		// 	url:`http://www.lixinger.com/api/stock/stocks/industry/${ind.exchange}/${ind.stockCode}/${ind.tickerId}`,
		// 	callback: this.oneIndustry
		// }));

		// this.crawler.add(tasks);

		return done();
	};

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

		if(!body.success){
			log.error(body.message);
			return done();
		}

		const mn = divide(__, 1000000);
		const datapoints = body.result.data
			  .map(pick(this.headers))
			  .map(modify('KCFJCXSYJLR', mn))
			  .map(modify('TOTALOPERATEREVE', mn))
			  .map(modify('GROSS_PROFIT',mn))
			  .map(modify('PARENTNETPROFIT',mn))
			  .map(modify('DEDU_PARENT_PROFIT',mn))
		;

		const {stockCode} = res.options.userParams;

		log.info(`stock: ${stockCode}, count: ${datapoints.length}`);

		if(body.result.count > 0){
			const csvPath = path.resolve(resultDir, `${identifier}_finance_${dayjs().format("YYYY-MM-DD")}.csv`);
			if (!fs.existsSync(csvPath)){
				fs.writeFileSync(csvPath, '\ufeff' + this.headers.join(',') + '\n');
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
