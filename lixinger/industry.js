import Crawler from "crawler";
import fs from "fs";
import path from "path";
import { getLogger } from "../lib/tslog.js";
import dayjs from "dayjs";
import papa from "papaparse";
import {default as URL} from "url";
import {props, pick, uniqBy, prop, mergeRight} from 'ramda';

const identifier = "lixinger";
const resultDir = "./data";
const logDir = "./log";
const config = JSON.parse(fs.readFileSync('./config.json'));
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format("YYYY-MM-DD")}.log`));

class Task {
	constructor() {
		this.crawler = new Crawler({
			maxConnections: 1,
			http2: true,
			rejectUnauthorized: false,
			jQuery: false,
			timeout: 30000,
			rateLimit: 15000,
			skipDuplicates: false,
			headers: {
				"user-agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
				"priority": "u=1, i",
				"cookie": config.cookie
			},
		});
		
		this.crawler
			.on("drain", () => {
				log.info(`Task Complete.`);
			})
			.on("schedule", options => {
			});

		this.headers = ['name','stockCode','stocksNum','level','exchange','tickerId','stockType','areaCode'];
	}

	start() {
		if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });
		if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

		log.info(`start working...`);

		try{
			fs.accessSync(path.resolve(resultDir, `${identifier}_industries_${dayjs().format("YYYY-MM-DD")}.csv`), fs.constants.R_OK | fs.constants.W_OK);
		}catch(e){//create file with header
			fs.writeFileSync(path.resolve(resultDir, `${identifier}_industries_${dayjs().format("YYYY-MM-DD")}.csv`), `\ufeff${this.headers}\n`);
		}
		
		try{
			fs.accessSync(path.resolve(resultDir, `${identifier}_stocks_${dayjs().format("YYYY-MM-DD")}.csv`), fs.constants.R_OK | fs.constants.W_OK);
		}catch(e){//create file with header
			fs.writeFileSync(path.resolve(resultDir, `${identifier}_stocks_${dayjs().format("YYYY-MM-DD")}.csv`), `\ufeff${[...this.headers, 'industryName','industryCode']}\n`);
		}
		
		this.crawler.add({
			url:`https://www.lixinger.com/api/ii/mix-metrics/industries/latest`,
			method:'POST',
			referer:'https://www.lixinger.com/analytics/industry/dashboard/value/cni',
			headers:{
			},
			callback: this.industryList,
			json: {"granularity":"y10","priceMetricsType":"mcw","source":"cni","level":"three","groupIds":"all","fsMetricsNames":["roe"],"priceMetricsNames":["mc","dyr","pe_ttm","pb","ps_ttm"],"sortName":"pm.pe_ttm.cv","sortOrder":"asc","pageIndex":0,"pageSize":100},
			userParams: {},
		});
	}

	industryList = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		let data = null;
		try{
			data = JSON.parse(res.body);
		}catch(e){
			log.error(e);
		}
		
		if(data.total == 0){
			log.warn('data empty');
			return done();
		}
		
		const industries = data.list.map(prop('stock')).map(pick(this.headers));

		fs.appendFileSync(
			path.resolve(resultDir, `${identifier}_industries_${dayjs().format("YYYY-MM-DD")}.csv`),
			papa.unparse(industries, {header:false,columns:this.headers}) + "\n"
		);
		
		log.info(`${industries.length} industries found.`);

		const tasks = industries.map(ind => ({
			url:`http://www.lixinger.com/api/stock/stocks/industry/${ind.exchange}/${ind.stockCode}/${ind.tickerId}`,
			callback: this.oneIndustry
		}));
		
		this.crawler.add(tasks);
		
		return done();
	};
	
	oneIndustry = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		let data = null;
		try{
			data = JSON.parse(res.body);
		}catch(e){
			log.error(e);
		}
		
		const industryName = data.name;
		const industryCode = data.stockCode;
		
		const stocks = data.constituentsWeightingList.map(pick(this.headers)).map(mergeRight({industryName,industryCode}));
		
		log.info(`industry: ${industryName}, code: ${industryCode}, stocks: ${stocks.length}`);
		if(stocks.length > 0){
			fs.appendFileSync(
				path.resolve(resultDir, `${identifier}_stocks_${dayjs().format("YYYY-MM-DD")}.csv`),
				papa.unparse(stocks, {header:false,columns: [...this.headers,'industryName','industryCode']}) + "\n"
			);
		}

		return done();
	};
}

const task = new Task();
task.start();
