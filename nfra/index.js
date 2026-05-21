import Crawler from "crawler";
import fs from "fs";
import path from "path";
import { getLogger } from "../lib/tslog.js";
import dayjs from "dayjs";
import papa from "papaparse";
import {default as URL} from "url";
import {__, modify, divide, props, pick, uniqBy, prop, mergeRight} from 'ramda';

import minimist from 'minimist';

/* const pkg = await import('seenreq');
const seenreq = pkg.default(); */

const argv = minimist(process.argv.slice(2));

const identifier = "nfra";
const resultDir = "./data";
const logDir = "./log";
const config = JSON.parse(fs.readFileSync('./config.json'));
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
				'Accept': '*/*',
				'Accept-Encoding': 'identity;q=1, *;q=0',
				'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
				'Connection': 'keep-alive',
				'Range': 'bytes=0-',
				'Sec-Fetch-Dest': 'empty',
				'Sec-Fetch-Mode': 'cors',
				'Sec-Fetch-Site': 'same-site',
				"user-agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
				"Cookie": config.cookie,
			},
			callback: this.list,
		});
		
		this.crawler
			.on("drain", () => {
				log.info(`Task Complete.`);
				//this.seen.dispose();
			})
			.on("schedule", options => {
			});

		this.headers = ['name', 'link'];
		/* this.seen = new seenreq();
		this.seen.initialize(); */
	}

	start() {
		if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });
		if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

		log.info(`start working...`);
		let pageIndex = 17;// hard code here.
		let pageSize = 18;
		let itemId = 954;

		const tasks = [{
			uri:`https://www.nfra.gov.cn/cbircweb/DocInfo/SelectDocByItemIdAndChild?itemId=${itemId}&pageSize=${pageSize}&pageIndex=${pageIndex}`,
			//uri:'https://www.nfra.gov.cn/cn/view/pages/ItemList.html?itemPId=953&itemId=954&itemUrl=ItemListRightList.html&itemName=%E7%BB%9F%E8%AE%A1%E4%BF%A1%E6%81%AF&itemsubPId=954',
			isJson: true,
			userParams: {
				pageIndex,
				pageSize,
				itemId,
			},
		}];

		/* this.seen.exists(tasks[0]).then(rst => { 
			this.crawler.add(tasks.filter((item,i) => !rst[i]));
		})
		.catch(err => log.error(err)); */
		this.crawler.add(tasks);
		
	}

	attachment = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}
		
		let ext = 'pdf';
		if(res.headers['content-type'].match(/pdf/)){
			ext = 'pdf';
		}else if(res.headers['content-type'].match(/excel/)){
			ext = 'xlsx';
		}

		fs.writeFileSync(`${path.resolve(resultDir,res.options.userParams.name)}.${ext}`, res.body);
		log.info(`${res.options.userParams.name}.${ext} saved.`);
		
		return done();
	};
	
	detail = (err, res, done) => { 
		if (err) {
			log.error(err);
			return done();
		}

		if(res.body.rptCode != 200){ 
			log.error(`${res.url} error: ${res.body.msg}`);
			return done();
		}

		const attachment = res.body.data.attachmentInfoVOList[0];
		if(!attachment){
			log.error(`${res.url} no attachment.`);
			return done();
		}

		this.crawler.add({
				uri:URL.resolve(res.url, attachment.urlOtherName),
				priority: 0,
				encoding: null,
				callback: this.attachment,
				userParams: res.options.userParams,
			});

		done();
	};

	list = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		if(res.body.rptCode != 200){ 
			log.error(`${res.url} error: ${res.body.msg}`);
			return done();
		}
		//log.info(res.body); 
		const items = res.body.data.rows.filter(row => /(保险业|财产保险公司|人身险公司)经营情况表/.test(row.docTitle)).map(row => {
			return {
				name: row.docTitle,
				id: row.docId,
				link: URL.resolve(res.url,row.pdfFileUrl),
			}
		})

		log.info(`got ${items.length} items: ${res.url}`);
/* 
		fs.appendFileSync(
			path.resolve(resultDir, `${identifier}_transport_${dayjs().format("YYYY-MM-DD")}.csv`),
			papa.unparse(monthItems, {header:false,columns:this.headers}) + "\n"
		); */

		const tasks = items.map(item => ({
				url: `https://www.nfra.gov.cn/cn/static/data/DocInfo/SelectByDocId/data_docId=${item.id}.json`,
				callback: this.detail,
				priority: 0,
				isJson: true,
                userParams: {
					name: item.name,
			    },
		}));

        this.crawler.add(tasks);
		let {pageIndex, pageSize, itemId} = res.options.userParams;

		if(res.options.userParams.pageIndex < 20){ // this is hard code...
			this.crawler.add({
				uri:`https://www.nfra.gov.cn/cbircweb/DocInfo/SelectDocByItemIdAndChild?itemId=${itemId}&pageSize=${pageSize}&pageIndex=${++pageIndex}`,
				isJson: true,
				userParams: {
					pageIndex,
					pageSize,
					itemId,
				},
			});
		}

		return done();
	};
}

const task = new Task();
task.start();
