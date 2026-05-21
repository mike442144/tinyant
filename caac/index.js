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

const identifier = "caac";
const resultDir = "./data";
const logDir = "./log";
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format("YYYY-MM-DD")}.log`));

class Task {
	constructor() {
		this.crawler = new Crawler({
			maxConnections: 1,
			//http2: true,
			rejectUnauthorized: false,
			jQuery: true,
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
				//"priority": "u=1, i",
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
		
		const tasks = [{
            uri:'https://www.caac.gov.cn/XXGK/XXGK/TJSJ/index_1215.html',
			//json: {"granularity":"y10","priceMetricsType":"mcw","source":"cni","level":"three","groupIds":"all","fsMetricsNames":["roe"],"priceMetricsNames":["mc","dyr","pe_ttm","pb","ps_ttm"],"sortName":"pm.pe_ttm.cv","sortOrder":"asc","pageIndex":0,"pageSize":100},
			userParams: {
			
			},
		}];

		/* this.seen.exists(tasks[0]).then(rst => { 
			this.crawler.add(tasks.filter((item,i) => !rst[i]));
		})
		.catch(err => log.error(err)); */
		this.crawler.add(tasks);
		
	}

    detail = (err, res, done) => { 
        if (err) {
			log.error(err);
			return done();
		}

        const $ = res.$;
        const fileUrl = URL.resolve(res.url,$('div#id_tblAppendix a').attr('href'));

        this.crawler.queue([{
            url: fileUrl,
            encoding: null,
            callback: this.attachment,
			priority: 0,
            jQuery: false,
            userParams: {
                name: res.options.userParams.name,
            },
        }])

        log.info(`downloading ${res.options.userParams.name} ...`);
        
        return done();
	};

	attachment = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}
		
		fs.writeFileSync(`${path.resolve(resultDir,res.options.userParams.name)}.pdf`, res.body);
		log.info(`${res.options.userParams.name} saved.`);
		
		return done();
	};
	
	list = (err, res, done) => {
		if (err) {
			log.error(err);
			return done();
		}

		if(!res.$){
			log.error('not injected jquery.');
			return done();
		}

            
		const $ = res.$;
		
		const monthItems = $('.a_left div.n_list > ul > li > a').map((i, el) => {
			const name = $(el).text().trim();
			const link = URL.resolve(res.url,$(el).attr('href'));

			return {
				name,
				link,
			}
		}).get();

		log.info(`got ${monthItems.length} items: ${res.url}`);

		fs.appendFileSync(
			path.resolve(resultDir, `${identifier}_transport_${dayjs().format("YYYY-MM-DD")}.csv`),
			papa.unparse(monthItems, {header:false,columns:this.headers}) + "\n"
		);

		const tasks = monthItems.map(item => ({
				url: item.link,
				callback: this.detail,
                /* encoding: null,
                jQuery: false, */
                userParams: {
                    name: item.name,
			    },
		}));

        this.crawler.add(tasks);

		if(Number($('div.page > span').text().trim()) < 4){
			const pagesLink = $('div.page > a').each((i, el) => {
				if ($(el).text().trim() === '下一页'){
					this.crawler.add({
						url: URL.resolve(res.url,$(el).attr('href'))
					});
				}
			});
		}

		return done();
	};
}

const task = new Task();
task.start();
