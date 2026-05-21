import Crawler from "crawler";
import fs from "fs";
import path from "path";
import { getLogger } from "../lib/tslog.js";
import dayjs from "dayjs";
import papa from "papaparse";
import {default as URL} from "url";
import {__, modify, divide, props, pick, uniqBy, prop, mergeRight} from 'ramda';

import minimist from 'minimist';

const argv = minimist(process.argv.slice(2));

const identifier = "yiche";
const resultDir = "./data";
const logDir = "./log";
const config = JSON.parse(fs.readFileSync('./config.json'));
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format("YYYY-MM-DD")}.log`));
log.settings.minLevel = 2;

class Task {
	constructor() {
		this.crawler = new Crawler({
			maxConnections: 1,
			//http2: true,
			rejectUnauthorized: false,
			//jQuery: false,
			//debug:true,
			timeout: 30000,
			rateLimit: 10000,
			//skipDuplicates: false,
			headers: {
				"user-agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
				//"priority": "u=1, i",
			},
		});
		
		this.crawler
			.on("drain", () => {
				log.info(`Task Complete.`);
			})
			.on("schedule", options => {

			});

		this.headers = ['name', 'num', 'branId', 'month'];
		this.brandData = {};
	}

	start() {
		if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });
		if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

		log.info(`start working...`);

		const brandIds = [
			309, //li
			297, //xpeng
			266, //nio
			779, //huawei
			//15, //byd
			757, //ledao
			804, //firefly
			702, //xiaomi
		];
		let month = dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
		
		if(argv.month && argv.month.match(/20\d\d-[01]?\d/)){
			month = dayjs(argv.month).startOf('month').format('YYYY-MM-DD');
		}
		
		const tasks = brandIds.map(brandId => ({
			url:`https://car.yiche.com/newcar/salesrank?brandId=${brandId}&date=${month}`,
			method:'GET',
			headers:{
				'Accept': '*/*',
				'Accept-Encoding': 'identity;q=1, *;q=0',
				'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
				'Connection': 'keep-alive',
				//'Origin': 'https://emweb.securities.eastmoney.com',
				'Range': 'bytes=0-',
				//'Referer': 'https://emweb.securities.eastmoney.com/',
				'Sec-Fetch-Dest': 'empty',
				'Sec-Fetch-Mode': 'cors',
				'Sec-Fetch-Site': 'same-site',
				'Cookie': config.cookie,
			},
			callback: this.oneBrand,
			//json: {"granularity":"y10","priceMetricsType":"mcw","source":"cni","level":"three","groupIds":"all","fsMetricsNames":["roe"],"priceMetricsNames":["mc","dyr","pe_ttm","pb","ps_ttm"],"sortName":"pm.pe_ttm.cv","sortOrder":"asc","pageIndex":0,"pageSize":100},
			userParams: {
				brandId,
				month
			},
		}));
		
		this.crawler.add(tasks);
	}

	industryList = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}
		
		log.info(res);

		if(!res.$){
			log.error('not injected jquery.');
		}
		
		
		fs.writeFileSync('/tmp/car.html', res.body);
			
		
		
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
	
	oneBrand = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		if(!res.$){
			log.error('not injected jquery.');
			return done();
		}

		const $ = res.$;
		const { brandId, month } = res.options.userParams;
		const page = res.options.userParams.page || 1;
		const urlObj = URL.parse(res.options.url, true);
		const baseUrl = res.options.url.split('?')[0];
		const queryParams = { ...urlObj.query };

		// Initialize brand data tracker
		if (!this.brandData[brandId]) {
			this.brandData[brandId] = { totalPage: 1, pagesDone: 0, items: [] };
		}

		// Extract totalPage from inline script
		const totalPageMatch = res.body.match(/totalPage\s*=\s*["']?(\d+)["']?/);
		const totalPage = totalPageMatch ? parseInt(totalPageMatch[1], 10) : 1;
		this.brandData[brandId].totalPage = totalPage;

		log.info(`Brand ${brandId} page ${page}/${totalPage}`);

		// Parse current page data
		const modelSales = $('div.rk-list-box > div.rk-item').map((i, el) => { 
			const name = $('div.rk-car-name',el).text().trim();
			const num = $('span.rk-car-num',el).text().replace(/辆/,'');

			return {
				name,
				num,
				branId: brandId,
				month,
			}
		}).get();

		this.brandData[brandId].items.push(...modelSales);
		this.brandData[brandId].pagesDone++;

		// Queue next page if exists
		if (page < totalPage) {
			const nextPage = page + 1;
			this.crawler.add({
				url: `${baseUrl}?${URL.format({ query: { ...queryParams, page: nextPage } }).replace(/^.*\?/, '')}`,
				method: 'GET',
				headers: res.options.headers,
				callback: this.oneBrand,
				userParams: { ...res.options.userParams, page: nextPage },
			});
		}

		// Write CSV when all pages are done
		if (this.brandData[brandId].pagesDone >= totalPage) {
			const allItems = this.brandData[brandId].items;
			fs.appendFileSync(
				path.resolve(resultDir, `${identifier}_modelsales_${dayjs().format("YYYY-MM-DD")}.csv`),
				papa.unparse(allItems, {header:false,columns:this.headers}) + "\n"
			);
			log.info(`Brand ${brandId} complete: ${allItems.length} items from ${totalPage} pages`);
			delete this.brandData[brandId];
		}

		return done();
	};
}

const task = new Task();
task.start();
