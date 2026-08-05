import Crawler from "crawler";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dayjs from "dayjs";
import papa from "papaparse";
import minimist from "minimist";
import * as cheerio from "cheerio";
import { getLogger } from "../lib/tslog.js";
import { parseDateRangeCninfo } from "../lib/utils.js";

const argv = minimist(process.argv.slice(2), {
	string: ['city', 'keyword', 'date'],
	boolean: ['list'],
	default: { pageSize: 20 },
	alias: { h: 'help' },
});

const HELP = `Usage: node index.js --city <城市> --keyword <关键词> [options]

查询一线城市土地出让/成交地块详情。数据源：
  北京: 北京市规划和自然资源委员会土地市场 (JSON API)
  深圳: 深圳公共资源交易中心 (JSON API)
  上海/广州: 自然资源部中国土地市场网 landchina.mnr.gov.cn 成交公示

Options:
  --city <name>       城市: 北京/上海/广州/深圳 (必填)
  --keyword <text>    宗地编号或位置关键词 (必填)
  --date <range>      日期范围, e.g. 2026-01-01~2026-08-31 (默认: 最近一个月)
  --list              仅列出匹配结果, 不抓取详情
  --pageSize <n>      每页条数 (默认: 20)
  -h, --help          显示帮助

Examples:
  node index.js --city 北京 --keyword 京土储挂 --list
  node index.js --city 深圳 --keyword G13111-0115 --date 2026-01-01~2026-08-31
  node index.js --city 上海 --keyword 松江 --date 2026-06-01~2026-08-05`;

if (argv.help) {
	console.log(HELP);
	process.exit(0);
}

const identifier = "landinfo";
const resultDir = "./data";
const logDir = "./log";
if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const log = getLogger(identifier, path.resolve(logDir, `${identifier}_${dayjs().format("YYYY-MM-DD")}.log`));

const BJ_BASE = "https://yewu.ghzrzyw.beijing.gov.cn/zkdncms/tdgltdsc/tdzpgxm";
const SZ_BASE = "https://www.szggzy.com/cms/api/v1/trade/content";
const LANDCHINA_BASE = "https://landchina.mnr.gov.cn/land/cjgs/gpcr";

const csvHeaders = ["city", "parcelId", "location", "area", "purpose", "price", "buyer", "dealDate", "noticeType", "title", "source", "sourceUrl"];

// ---------- pure helpers ----------

const CITY_ALIASES = {
	北京: "北京", beijing: "北京", bj: "北京",
	上海: "上海", shanghai: "上海", sh: "上海",
	广州: "广州", guangzhou: "广州", gz: "广州",
	深圳: "深圳", shenzhen: "深圳", sz: "深圳",
};

export function resolveCity(s) {
	if (!s) return null;
	const key = String(s).trim().replace(/市$/, "").toLowerCase();
	return CITY_ALIASES[key] || CITY_ALIASES[String(s).trim().replace(/市$/, "")] || null;
}

export function normalizeBeijing(item) {
	return {
		city: "北京",
		parcelId: item.landid || "",
		location: item.landlocation || "",
		area: item.landtotalarea || "",
		purpose: [item.landusetype1DictText, item.landusetype2].filter(Boolean).join("/"),
		price: item.chengJiaoJinE || "",
		buyer: item.jingDeRen || "",
		dealDate: (item.chegnJiaoShiJian || item.publishTime || "").slice(0, 10),
		noticeType: item.announcetypeDictText || "",
		title: item.title || "",
		source: "北京市规划和自然资源委员会",
		sourceUrl: `${BJ_BASE}/esSearchDetail/${item.id}`,
	};
}

export function parseBeijingList(body) {
	let data;
	try { data = JSON.parse(body); } catch { return { count: 0, items: [] }; }
	if (String(data.code) !== "0" || !Array.isArray(data.data)) return { count: 0, items: [] };
	return { count: data.count || data.data.length, items: data.data };
}

export function parseShenzhenList(body) {
	let data;
	try { data = JSON.parse(body); } catch { return { total: 0, items: [] }; }
	const content = data?.data?.content;
	if (data.code !== 200 || !Array.isArray(content)) return { total: 0, items: [] };
	return { total: data.data?.totalElements ?? content.length, items: content };
}

export function normalizeShenzhen(item) {
	return {
		city: "深圳",
		parcelId: item.projectCode || "",
		location: item.projectName || "",
		area: "",
		purpose: "",
		price: "",
		buyer: item.winnerName || "",
		dealDate: (item.publishTime || "").slice(0, 10),
		noticeType: item.noticeTypeName || "",
		title: item.noticeTitle || "",
		source: "深圳公共资源交易中心",
		sourceUrl: `${SZ_BASE}/detail?contentId=${item.contentId}`,
	};
}

// 深圳详情: attrs 结构化字段 + txt 正文。
// 结果公示为 "标签：值；" 键值对; 交易公告为含"宗地号"表头的表格。
export function extractShenzhenDetail(data) {
	const attrs = Object.fromEntries((data?.attrs || []).map(a => [a.attrName, a.attrValue]));
	const html = String(data?.txt || "");
	const $ = cheerio.load(html);
	const text = html.replace(/<[^>]+>/g, "");
	const pick = (...labels) => {
		const re = new RegExp(`(?:${labels.join("|")})\\s*[:：]\\s*([^；;\\n]+)`);
		return (text.match(re)?.[1] || "").trim();
	};
	const out = {
		parcelId: pick("宗地号", "宗地编号") || attrs.jygg_xmbh || "",
		location: pick("宗地位置", "地块位置", "位置") || attrs.jygg_xmmc || "",
		area: normalizeArea(pick("宗地面积", "土地面积", "出让面积", "面积")),
		purpose: pick("土地用途", "用地性质", "用途"),
		price: normalizePrice(pick("成交价", "成交金额", "成交价格", "挂牌起始价")),
		buyer: pick("竞得人", "买受人", "受让人") || attrs.jygg_jdr || "",
	};
	$("table").each((_, table) => {
		if (out.parcelId && out.area) return;
		const rows = [];
		$(table).find("tr").each((__, tr) => {
			const cells = [];
			$(tr).find("td,th").each((___, el) => cells.push($(el).text().replace(/\s+/g, "").trim()));
			rows.push(cells);
		});
		const headerIdx = rows.findIndex(cells => cells.some(c => c.includes("宗地号")));
		if (headerIdx < 0 || headerIdx + 1 >= rows.length) return;
		const header = rows[headerIdx];
		const row = rows[headerIdx + 1];
		const col = (...names) => {
			for (const name of names) {
				const i = header.findIndex(c => c.includes(name));
				if (i >= 0 && row[i]) return row[i];
			}
			return "";
		};
		out.parcelId = out.parcelId || col("宗地号");
		out.location = out.location || col("土地位置");
		out.purpose = out.purpose || col("土地用途");
		out.area = out.area || normalizeArea(col("土地面积"));
		out.price = out.price || normalizePrice(col("成交价", "挂牌起始价"));
	});
	return out;
}

// 面积归一为平方米: "1.5公顷"->15000, "31329.369平方米"->31329.369
export function normalizeArea(raw) {
	if (!raw) return "";
	const m = String(raw).replace(/,/g, "").match(/([\d.]+)\s*(公顷|万平方米|平方米|㎡|m2)?/);
	if (!m) return raw;
	const num = parseFloat(m[1]);
	if (Number.isNaN(num)) return raw;
	const unit = m[2] || "";
	const val = unit.startsWith("公顷") ? num * 10000 : num;
	return String(parseFloat(val.toFixed(3)));
}

// 价格归一为万元: "1.2亿元"->12000, "14362万元"->14362
export function normalizePrice(raw) {
	if (!raw) return "";
	const m = String(raw).replace(/,/g, "").match(/([\d.]+)\s*(亿|万)?/);
	if (!m) return raw;
	const num = parseFloat(m[1]);
	if (Number.isNaN(num)) return raw;
	const val = m[2] === "亿" ? num * 10000 : num;
	return String(parseFloat(val.toFixed(2)));
}

// landchina 列表页: <li><span>2026.08.04</span><a href="./202608/t....htm">标题</a></li>
export function parseLandchinaIndex(html) {
	const items = [];
	const re = /<li><span>(\d{4}\.\d{2}\.\d{2})<\/span><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/li>/g;
	let m;
	while ((m = re.exec(html)) !== null) {
		const url = m[2].startsWith("http") ? m[2] : `${LANDCHINA_BASE}/${m[2].replace(/^\.\//, "")}`;
		items.push({ date: m[1].replace(/\./g, "-"), title: m[3].trim(), url });
	}
	return items;
}

export function landchinaPageUrl(page) {
	return page <= 0 ? `${LANDCHINA_BASE}/index.htm` : `${LANDCHINA_BASE}/index_${page}.htm`;
}

// landchina 详情页: 每个地块一张表, 单元格成对出现 "宗地编号：" / 值
export function extractLandchinaDetail(html) {
	const $ = cheerio.load(html);
	const parcels = [];
	$("table").each((_, table) => {
		const cells = $(table).find("td,th").map((__, el) => $(el).text().replace(/\s+/g, " ").trim()).get();
		const map = {};
		for (let i = 0; i + 1 < cells.length; i++) {
			if (cells[i].endsWith("：") || cells[i].endsWith(":")) {
				map[cells[i].replace(/[：:]$/, "")] = cells[i + 1].replace(/^[\s\u00a0]+/, "");
			}
		}
		const parcelId = map["宗地编号"] || map["地块编号"] || "";
		if (!parcelId) return;
		parcels.push({
			parcelId,
			location: map["宗地坐落"] || map["土地坐落"] || "",
			area: normalizeArea(map["宗地总面积"] || map["土地面积"] || map["面积"] || ""),
			purpose: map["土地用途"] || map["用途"] || "",
			price: normalizePrice(map["成交价"] || map["成交价格"] || ""),
			buyer: map["受让单位"] || map["受让人"] || map["竞得人"] || "",
		});
	});
	return parcels;
}

// ---------- crawler task ----------

class Task {
	constructor() {
		this.crawler = new Crawler({
			maxConnections: 1,
			rejectUnauthorized: false,
			jQuery: false,
			timeout: 30000,
			rateLimit: 3000,
			headers: {
				"user-agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
				"Accept": "application/json, text/html, */*",
				"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
			},
		});
		this.crawler.on("drain", () => log.info("Task Complete."));
	}

	start() {
		const city = resolveCity(argv.city);
		if (!city) {
			log.error(`未知城市: ${argv.city || "(空)"}，支持 北京/上海/广州/深圳`);
			console.log(HELP);
			process.exit(1);
		}
		if (!argv.keyword) {
			log.error("请通过 --keyword 提供宗地编号或位置关键词");
			process.exit(1);
		}
		this.city = city;
		this.keyword = argv.keyword.trim();
		this.pageSize = parseInt(argv.pageSize, 10) || 20;
		const range = parseDateRangeCninfo(argv.date);
		this.dateFrom = range.from;
		this.dateTo = range.to;
		log.info(`City: ${city}, keyword: ${this.keyword}, date: ${this.dateFrom} ~ ${this.dateTo}${argv.list ? ", list-only" : ""}`);

		this.csvPath = path.resolve(resultDir, `${identifier}_${city}_${dayjs().format("YYYY-MM-DD")}.csv`);
		if (!argv.list && !fs.existsSync(this.csvPath)) {
			fs.writeFileSync(this.csvPath, '\ufeff' + csvHeaders.join(',') + '\n');
		}

		if (city === "北京") this.fetchBeijingPage(1);
		else if (city === "深圳") this.fetchShenzhenPage(0);
		else this.fetchLandchinaPage(0);
	}

	writeRows(rows) {
		for (const row of rows) {
			if (argv.list) {
				console.log([row.city, row.parcelId, row.dealDate, row.noticeType, row.price ? `${row.price}万元` : "", row.buyer, row.title].join("\t"));
				continue;
			}
			fs.appendFileSync(this.csvPath, papa.unparse([row], { header: false, columns: csvHeaders }) + "\n");
			log.info(`Saved: ${row.parcelId} ${row.title}`);
		}
	}

	// ---- 北京 ----
	fetchBeijingPage(page) {
		const url = `${BJ_BASE}/esSearchList?page=${page}&limit=${this.pageSize}&announcetype=&county=&gjz=${encodeURIComponent(this.keyword)}`;
		this.crawler.add({
			url,
			callback: (err, res, done) => {
				if (err) { log.error(err); return done(); }
				const { count, items } = parseBeijingList(res.body);
				if (page === 1 && items.length === 0) {
					log.warn(`北京: 未找到关键词 "${this.keyword}" 的匹配`);
					return done();
				}
				const rows = items
					.map(normalizeBeijing)
					.filter(r => r.dealDate >= this.dateFrom.slice(0, 10) && r.dealDate <= this.dateTo.slice(0, 10));
				log.info(`北京: page ${page}, ${items.length} items (${rows.length} in date range), total ${count}`);
				this.writeRows(rows);
				const oldest = items[items.length - 1].publishTime || "";
				if (items.length === this.pageSize && page * this.pageSize < count && oldest.slice(0, 10) >= this.dateFrom) this.fetchBeijingPage(page + 1);
				return done();
			},
		});
	}

	// ---- 深圳 ----
	fetchShenzhenPage(page, { clientFilter = false } = {}) {
		// 服务端 title 过滤是完整短语匹配, 关键词命中失败时退回客户端过滤
		this.crawler.add({
			url: `${SZ_BASE}/page`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				channelId: 2852,
				title: clientFilter ? null : this.keyword,
				releaseTimeBegin: this.dateFrom,
				releaseTimeEnd: dayjs(this.dateTo).add(1, "day").format("YYYY-MM-DD"),
				page,
				size: this.pageSize,
			}),
			callback: (err, res, done) => {
				if (err) { log.error(err); return done(); }
				const { total, items } = parseShenzhenList(res.body);
				if (page === 0 && !clientFilter && total === 0) {
					log.info("深圳: 服务端无匹配, 改用客户端过滤重扫");
					this.fetchShenzhenPage(0, { clientFilter: true });
					return done();
				}
				if (page === 0 && items.length === 0) {
					log.warn(`深圳: 未找到关键词 "${this.keyword}" 的匹配`);
					return done();
				}
				const kw = this.keyword;
				const matched = clientFilter
					? items.filter(it => [it.noticeTitle, it.projectName, it.projectCode, it.winnerName].some(f => f && f.includes(kw)))
					: items;
				log.info(`深圳: page ${page}, ${items.length} items (${matched.length} matched${clientFilter ? ", client filter" : ""}), total ${total}`);
				for (const item of matched) {
					const base = normalizeShenzhen(item);
					if (argv.list) {
						this.writeRows([base]);
					} else {
						this.crawler.add({
							url: `${SZ_BASE}/detail?contentId=${item.contentId}`,
							callback: (e2, r2, d2) => {
								if (e2) { log.error(e2); return d2(); }
								let data;
								try { data = JSON.parse(r2.body); } catch { data = null; }
								const detail = data?.code === 200 ? extractShenzhenDetail(data.data) : {};
								this.writeRows([{ ...base, ...Object.fromEntries(Object.entries(detail).filter(([, v]) => v)) }]);
								return d2();
							},
						});
					}
				}
				const morePages = items.length === this.pageSize && (page + 1) * this.pageSize < total && (!clientFilter || page < 29);
				if (clientFilter && !morePages && page >= 29) log.warn("深圳: 客户端过滤扫描已达 30 页上限, 建议缩小日期范围");
				if (morePages) this.fetchShenzhenPage(page + 1, { clientFilter });
				return done();
			},
		});
	}

	// ---- 上海/广州 (landchina) ----
	fetchLandchinaPage(page) {
		this.crawler.add({
			url: landchinaPageUrl(page),
			callback: (err, res, done) => {
				if (err) { log.error(err); return done(); }
				const items = parseLandchinaIndex(res.body);
				if (items.length === 0) {
					log.info(`landchina: page ${page} 无内容, 停止翻页`);
					return done();
				}
				const latest = items[0].date;
				const oldest = items[items.length - 1].date;
				log.info(`landchina: page ${page}, ${items.length} items (${oldest} ~ ${latest})`);
				const cityKey = `${this.city}市`;
				for (const item of items) {
					if (!item.title.includes(cityKey) && !item.title.includes(this.keyword)) continue;
					this.crawler.add({
						url: item.url,
						callback: (e2, r2, d2) => {
							if (e2) { log.error(e2); return d2(); }
							const text = String(r2.body).replace(/<[^>]+>/g, "");
							if (!text.includes(this.keyword)) return d2();
							const parcels = extractLandchinaDetail(r2.body);
							if (parcels.length === 0) {
								log.warn(`landchina: ${item.url} 命中关键词但未解析出地块表格`);
								return d2();
							}
							this.writeRows(parcels.map(p => ({
								city: this.city,
								...p,
								dealDate: item.date,
								noticeType: "挂牌出让成交公示",
								title: item.title,
								source: "中国土地市场网(自然资源部)",
								sourceUrl: item.url,
							})));
							return d2();
						},
					});
				}
				if (oldest >= this.dateFrom && page < 119) this.fetchLandchinaPage(page + 1);
				else if (oldest >= this.dateFrom) log.warn("landchina: 已达 120 页上限, 建议缩小日期范围");
				return done();
			},
		});
	}
}

const isMainEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainEntry) {
	const task = new Task();
	task.start();
}
