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

查询城市土地出让/成交地块详情。数据源：
  北京: 北京市规划和自然资源委员会土地市场 (JSON API)
  深圳: 深圳公共资源交易中心 (JSON API)
  杭州: 杭州市规划和自然资源局成交结果公示 (JCMS API, 竞得入选公示)
  成都: 成都公共资源交易中心土地交易结果 (结果一览表)
  苏州: 苏州公共资源交易中心成交公示 (市区+张家港, JSON API)
  常熟: 苏州公共资源交易平台常熟分中心成交公示 (JSON API)
  昆山: 昆山市人民政府土地成交公告 (静态页)
  太仓: 苏州公共资源交易平台太仓分中心成交公示 (JSON API)
  吴江: 江苏土地市场网 landjs.com 成交公示 (JSON API)
  其他任意城市: 自然资源部中国土地市场网 landchina.mnr.gov.cn 成交公示

Options:
  --city <name>       城市, 如 北京/上海/深圳/苏州/杭州/成都, 任意城市均可 (必填)
  --keyword <text>    宗地编号或位置关键词 (必填)
  --date <range>      日期范围, e.g. 2026-01-01~2026-08-31 (默认: 最近一个月)
  --list              仅列出匹配结果, 不抓取详情 (成都: 列出日期范围内全部结果公告)
  --pageSize <n>      每页条数 (默认: 20)
  -h, --help          显示帮助

Examples:
  node index.js --city 北京 --keyword 京土储挂 --list
  node index.js --city 深圳 --keyword G13111-0115 --date 2026-01-01~2026-08-31
  node index.js --city 杭州 --keyword 杭政储出 --date 2026-06-01~2026-08-05 --list
  node index.js --city 成都 --keyword CH05 --date 2026-07-01~2026-08-05
  node index.js --city 上海 --keyword 松江 --date 2026-06-01~2026-08-05
  node index.js --city 苏州 --keyword 工业园区 --date 2026-07-01~2026-08-05`;

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
const HZ_BASE = "https://ghzy.hangzhou.gov.cn";
// 成交结果栏目 pageId (政务公开>公告公示>房地产(土地)市场>成交结果)
const HZ_PAGE_ID = "1228962705";
const CD_BASE = "https://www.cdggzy.com/sitenew/notice/LandTrade";
const SZGGZY_BASE = "https://ggzy.suzhou.gov.cn/EpointWebBuilder/JyxxSearchAction.action";
const SZGGZY_SITEGUID = "7eb5f7f1-9041-43ad-8e13-8fcb82ea831a";
// 苏州交易平台成交公示栏目: 苏州市区(含张家港) / 常熟分中心 / 太仓分中心
const SZ_CATEGORIES = { 苏州: "003005004", 常熟: "003014004", 太仓: "003027002" };
const KS_BASE = "https://www.ks.gov.cn/kss/cjgg";
// 江苏土地市场网: 吴江成交数据 (区划码 320584), 响应含全字段无需详情页
const LANDJS_URL = "http://www.landjs.com/tAfficheParcel/searchBargainParcel";
const WUJIANG_XZQDM = "320584";

const csvHeaders = ["city", "parcelId", "location", "area", "purpose", "price", "buyer", "dealDate", "noticeType", "title", "source", "sourceUrl"];

// ---------- pure helpers ----------

const CITY_ALIASES = {
	北京: "北京", beijing: "北京", bj: "北京",
	上海: "上海", shanghai: "上海", sh: "上海",
	广州: "广州", guangzhou: "广州", gz: "广州",
	深圳: "深圳", shenzhen: "深圳", sz: "深圳",
	杭州: "杭州", hangzhou: "杭州", hz: "杭州",
	成都: "成都", chengdu: "成都", cd: "成都",
	苏州: "苏州", suzhou: "苏州",
	常熟: "常熟", changshu: "常熟",
	昆山: "昆山", kunshan: "昆山",
	太仓: "太仓", taicang: "太仓",
	吴江: "吴江", wujiang: "吴江",
};

// 北京/深圳/杭州/成都/苏州/常熟/昆山/太仓/吴江走本地数据源, 其余任意城市走 landchina 全国成交公示
export function resolveCity(s) {
	if (!s) return null;
	const trimmed = String(s).trim().replace(/市$/, "");
	if (!trimmed) return null;
	return CITY_ALIASES[trimmed.toLowerCase()] || CITY_ALIASES[trimmed] || trimmed;
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

// 面积归一为平方米: "1.5公顷"->15000, "31329.369平方米"->31329.369, "34.3亩"->22866.667
export function normalizeArea(raw) {
	if (!raw) return "";
	const m = String(raw).replace(/,/g, "").match(/([\d.]+)\s*(公顷|万平方米|平方米|㎡|m2|亩)?/);
	if (!m) return raw;
	const num = parseFloat(m[1]);
	if (Number.isNaN(num)) return raw;
	const unit = m[2] || "";
	const val = unit.startsWith("公顷") ? num * 10000 : unit === "亩" ? (num * 10000) / 15 : num;
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

// ---------- 杭州: 规自局 JCMS API ----------

export function hangzhouListUrl(page, pageSize = 15) {
	const paramJson = encodeURIComponent(JSON.stringify({ pageNo: page, pageSize }));
	const tagId = encodeURIComponent("当前栏目list");
	return `${HZ_BASE}/api-gateway/jpaas-publish-server/front/page/build/unit?parseType=bulidstatic&webId=3390&tplSetId=gNNXQnJhGbgHJoFMLtgED&pageType=column&tagId=${tagId}&editType=null&pageId=${HZ_PAGE_ID}&paramJson=${paramJson}`;
}

// 响应 {success, data:{html}}, html 内为 <li>[日期]<a href>标题</a></li>, 总数在 count="N" 属性
export function parseHangzhouList(body) {
	let data;
	try { data = JSON.parse(body); } catch { return { count: 0, items: [] }; }
	const html = String(data?.data?.html || "");
	if (!html || html.includes("模版内容不能为空")) return { count: 0, items: [] };
	const items = [];
	const re = /<li><span[^>]*>\[?(\d{4}-\d{2}-\d{2})\]?<\/span><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/li>/g;
	let m;
	while ((m = re.exec(html)) !== null) {
		const url = m[2].startsWith("http") ? m[2] : `${HZ_BASE}${m[2]}`;
		items.push({ date: m[1], title: m[3].replace(/<[^>]+>/g, "").trim(), url });
	}
	const countMatch = html.match(/count="(\d+)"/);
	return { count: countMatch ? parseInt(countMatch[1], 10) : items.length, items };
}

// 详情页地块表: 地块编号|地块名称|用地性质|土地面积(亩)|容积率|成交价(万元)|竞得入选人, 末行为合计
export function extractHangzhouDetail(html) {
	const $ = cheerio.load(html);
	const parcels = [];
	$("table").each((_, table) => {
		const rows = [];
		$(table).find("tr").each((__, tr) => {
			const cells = [];
			$(tr).find("td,th").each((___, el) => cells.push($(el).text().replace(/\s+/g, " ").trim()));
			rows.push(cells);
		});
		if (!rows.some(cells => cells.some(c => c.includes("地块编号")))) return;
		for (const cells of rows) {
			const id = cells[0] || "";
			if (!id || id === "地块编号" || id.startsWith("合计") || cells.length < 7) continue;
			parcels.push({
				parcelId: id,
				location: cells[1] || "",
				purpose: cells[2] || "",
				area: cells[3] ? normalizeArea(`${cells[3]}亩`) : "",
				price: normalizePrice(cells[5] || ""),
				buyer: cells[6] || "",
			});
		}
	});
	return parcels;
}

// ---------- 成都: 公共资源交易中心 ----------

// ASP.NET 列表页: div.list-row 条目 + 隐藏字段, 翻页靠 POST 表单改 PageIndex
export function parseChengduList(html) {
	const form = {};
	for (const name of ["__VIEWSTATE", "TotalRecords", "PageSize", "PageIndex", "displaytypeval", "displaystateval", "dealaddressval"]) {
		const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
		if (m) form[name] = m[1];
	}
	const $ = cheerio.load(html);
	const items = [];
	$(".list-row").each((_, row) => {
		const titleEl = $(row).find(".list-item-title");
		if (titleEl.length === 0) return;
		const title = String(titleEl.attr("title") || titleEl.text()).trim();
		const idMatch = String(titleEl.attr("onclick") || "").match(/id=([0-9a-fA-F-]+)/);
		const dateMatch = $(row).text().match(/(\d{4}-\d{2}-\d{2})/);
		items.push({
			region: ($(row).find(".list-item").first().text() || "").replace(/[【】\s]/g, ""),
			title,
			url: idMatch ? `${CD_BASE}/LandNoticeContent.aspx?id=${idMatch[1]}` : "",
			date: dateMatch ? dateMatch[1] : "",
		});
	});
	return { form, items };
}

// 结果一览表: 序号|宗地编号|宗地位置|净用地面积|起始价|成交价|竞得人。
// 成交价常为单价(元/平方米), 有面积时换算为总价万元
export function extractChengduDetail(html) {
	const $ = cheerio.load(html);
	const parcels = [];
	$("table").each((_, table) => {
		const rows = [];
		$(table).find("tr").each((__, tr) => {
			const cells = [];
			$(tr).find("td,th").each((___, el) => cells.push($(el).text().replace(/\s+/g, " ").trim()));
			rows.push(cells);
		});
		const headerIdx = rows.findIndex(cells => cells.some(c => c.includes("宗地编号")));
		if (headerIdx < 0) return;
		const header = rows[headerIdx];
		const colIdx = (...names) => header.findIndex(c => names.some(n => c.includes(n)));
		const iId = colIdx("宗地编号");
		const iLoc = colIdx("宗地位置", "位置");
		const iArea = colIdx("面积");
		const iPrice = colIdx("成交价");
		const iBuyer = colIdx("竞得人");
		for (const cells of rows.slice(headerIdx + 1)) {
			if (iId < 0 || !cells[iId]) continue;
			const area = normalizeArea(cells[iArea] || "");
			const priceRaw = cells[iPrice] || "";
			const unitMatch = priceRaw.replace(/,/g, "").match(/([\d.]+)\s*元\/平方米/);
			const price = unitMatch && area
				? String(parseFloat((parseFloat(unitMatch[1]) * parseFloat(area) / 10000).toFixed(2)))
				: normalizePrice(priceRaw);
			parcels.push({
				parcelId: cells[iId],
				location: iLoc >= 0 ? cells[iLoc] || "" : "",
				area,
				purpose: "",
				price,
				buyer: iBuyer >= 0 ? cells[iBuyer] || "" : "",
			});
		}
	});
	return parcels;
}

// ---------- 苏州/常熟: 公共资源交易平台 JSON API ----------

export function suzhouListUrl(categorynum, page, pageSize = 20) {
	return `${SZGGZY_BASE}?cmd=getList1&pageIndex=${page}&pageSize=${pageSize}&categorynum=${categorynum}`;
}

// getDetailPath 必须带 pageIndex 参数, 否则返回验证码错误
export function suzhouDetailPathUrl(categorynum, infoid) {
	return `${SZGGZY_BASE}?cmd=getDetailPath&categorynum=${categorynum}&infoid=${infoid}&siteguid=${SZGGZY_SITEGUID}&pageIndex=0`;
}

// 响应 {custom: "<JSON字符串>"}, custom 需二次 JSON.parse
export function parseSuzhouList(body) {
	let data;
	try { data = JSON.parse(body); } catch { return { total: 0, items: [] }; }
	let custom;
	try { custom = JSON.parse(data?.custom); } catch { return { total: 0, items: [] }; }
	if (!Array.isArray(custom?.Table)) return { total: 0, items: [] };
	return { total: custom.TotalCount ?? custom.Table.length, items: custom.Table };
}

export function parseSuzhouDetailPath(body) {
	let data;
	try { data = JSON.parse(body); } catch { return null; }
	const p = String(data?.custom || "");
	return p.startsWith("/") ? p : null;
}

// 竞得单位常粘连 18 位统一社会信用代码, 去掉
function cleanBuyer(s) {
	return String(s || "").replace(/[0-9A-Z]{18}$/, "").trim();
}

// "2026.3.18" / "2026-04-29 10:34:00.0" -> "2026-03-18"
export function normalizeDealDate(raw) {
	const m = String(raw || "").match(/(\d{4})[.-](\d{1,2})[.-](\d{1,2})/);
	if (!m) return "";
	return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

// 详情表格两种格式: 市区为键值对(地块编号|值|土地位置|值|...), 常熟为列式(表头行+数据行)
export function extractSuzhouDetail(html) {
	const KEYS = ["地块编号", "宗地编号", "土地位置", "地块位置", "出让面积（平方米）", "出让面积（㎡）", "面积（㎡）", "土地用途", "规划用途", "用途", "竞得价（万元）", "成交价（万元）", "竞得单位", "竞得人", "成交人", "成交时间", "成交日期"];
	const $ = cheerio.load(html);
	const parcels = [];
	$("table").each((_, table) => {
		if ($(table).find("table").length > 0) return; // 跳过外层包裹表格, 只解析最内层
		const rows = [];
		$(table).find("tr").each((__, tr) => {
			const cells = [];
			$(tr).find("td,th").each((___, el) => cells.push($(el).text().replace(/\s+/g, "").trim()));
			rows.push(cells);
		});
		if (!rows.flat().includes("地块编号") && !rows.flat().includes("宗地编号")) return;
		const headerIdx = rows.findIndex(cells => cells.includes("地块编号") || cells.includes("宗地编号"));
		const header = rows[headerIdx];
		const keyCount = header.filter(c => KEYS.includes(c)).length;
		if (keyCount >= 3) {
			// 列式表格
			const col = (...names) => header.findIndex(c => names.includes(c));
			const iId = col("地块编号", "宗地编号");
			const iLoc = col("土地位置", "地块位置");
			const iArea = col("出让面积（平方米）", "面积（㎡）");
			const iPur = col("土地用途", "用途");
			const iPrice = col("竞得价（万元）", "成交价（万元）");
			const iBuyer = col("竞得单位", "竞得人", "成交人");
			const iDate = col("成交时间", "成交日期");
			for (const cells of rows.slice(headerIdx + 1)) {
				if (iId < 0 || !cells[iId]) continue;
				parcels.push({
					parcelId: cells[iId],
					location: iLoc >= 0 ? cells[iLoc] || "" : "",
					area: normalizeArea(cells[iArea] || ""),
					purpose: iPur >= 0 ? cells[iPur] || "" : "",
					price: normalizePrice(cells[iPrice] || ""),
					buyer: cleanBuyer(iBuyer >= 0 ? cells[iBuyer] || "" : ""),
					dealDate: normalizeDealDate(iDate >= 0 ? cells[iDate] : ""),
				});
			}
		} else {
			// 键值对表格
			const flat = rows.flat();
			const map = {};
			for (let i = 0; i + 1 < flat.length; i++) {
				if (KEYS.includes(flat[i])) map[flat[i]] = flat[i + 1];
			}
			const parcelId = map["地块编号"] || map["宗地编号"] || "";
			if (!parcelId) return;
			parcels.push({
				parcelId,
				location: map["土地位置"] || map["地块位置"] || "",
				area: normalizeArea(map["出让面积（平方米）"] || map["出让面积（㎡）"] || map["面积（㎡）"] || ""),
				purpose: map["土地用途"] || map["规划用途"] || map["用途"] || "",
				price: normalizePrice(map["竞得价（万元）"] || map["成交价（万元）"] || ""),
				buyer: cleanBuyer(map["竞得单位"] || map["竞得人"] || map["成交人"] || ""),
				dealDate: normalizeDealDate(map["成交时间"] || map["成交日期"] || ""),
			});
		}
	});
	// 外层包裹表格会导致同一地块重复解析, 按编号去重
	const seen = new Set();
	return parcels.filter(p => !seen.has(p.parcelId) && seen.add(p.parcelId));
}

// ---------- 昆山: 市政府土地成交公告静态页 ----------

export function kunshanPageUrl(page) {
	return page <= 1 ? `${KS_BASE}/common_list.shtml` : `${KS_BASE}/common_list_${page}.shtml`;
}

// createPageHTML('page_div',22,1,'common_list','shtml',325) 给出总页数
export function parseKunshanList(html) {
	const items = [];
	const re = /<a href="(\/kss\/cjgg\/\d{6}\/[^"]+)"[^>]*title="([^"]+)"[\s\S]*?<span class="time">\s*(\d{4}-\d{2}-\d{2})/g;
	let m;
	while ((m = re.exec(html)) !== null) {
		items.push({ title: m[2].trim(), url: `${KS_BASE.replace(/\/kss\/cjgg$/, "")}${m[1]}`, date: m[3] });
	}
	const pgMatch = html.match(/createPageHTML\([^,]*,\s*(\d+)/);
	return { pageCount: pgMatch ? parseInt(pgMatch[1], 10) : 1, items };
}

// 列式表格: (地块编号|序号)|地块位置|土地面积(M2)|用途|出让年限|起始总价(万元)|竞得价(万元)|竞得人
export function extractKunshanDetail(html) {
	const $ = cheerio.load(html);
	const parcels = [];
	$("table").each((_, table) => {
		const rows = [];
		$(table).find("tr").each((__, tr) => {
			const cells = [];
			$(tr).find("td,th").each((___, el) => cells.push($(el).text().replace(/\s+/g, "").trim()));
			rows.push(cells);
		});
		const headerIdx = rows.findIndex(cells => cells.some(c => c.includes("地块位置")) && cells.some(c => c.includes("竞得人")));
		if (headerIdx < 0) return;
		const header = rows[headerIdx];
		const colIdx = (...names) => header.findIndex(c => names.some(n => c.includes(n)));
		const iId = colIdx("地块编号");
		const iLoc = colIdx("地块位置", "位置");
		const iArea = colIdx("面积");
		const iPur = colIdx("用途");
		const iPrice = colIdx("竞得价");
		const iBuyer = colIdx("竞得人");
		for (const cells of rows.slice(headerIdx + 1)) {
			const parcelId = iId >= 0 ? cells[iId] || "" : cells[0] || "";
			if (!parcelId) continue;
			parcels.push({
				parcelId,
				location: iLoc >= 0 ? cells[iLoc] || "" : "",
				area: normalizeArea(cells[iArea] || ""),
				purpose: iPur >= 0 ? cells[iPur] || "" : "",
				price: normalizePrice(cells[iPrice] || ""),
				buyer: cleanBuyer(iBuyer >= 0 ? cells[iBuyer] || "" : ""),
			});
		}
	});
	return parcels;
}

// ---------- 吴江: 江苏土地市场网 landjs.com ----------

// 响应 {total, totalPages, bargainParcelList:[...]}, 含全字段无需详情页
export function parseLandjsList(body) {
	let data;
	try { data = JSON.parse(body); } catch { return { total: 0, items: [] }; }
	if (!Array.isArray(data?.bargainParcelList)) return { total: 0, items: [] };
	return { total: data.total ?? data.bargainParcelList.length, items: data.bargainParcelList };
}

// price=0 多为划拨/协议类; bargainDate 为毫秒时间戳
export function normalizeLandjsParcel(item) {
	const ts = Number(item.bargainDate);
	return {
		parcelId: item.parcelNo || "",
		location: item.landPosition || "",
		area: item.remiseArea ? String(item.remiseArea) : "",
		purpose: item.landUse || "",
		price: item.price != null ? String(item.price) : "",
		buyer: item.alienee || "",
		dealDate: Number.isFinite(ts) && ts > 0 ? dayjs(ts).format("YYYY-MM-DD") : "",
		noticeType: item.remiseType ? `${item.remiseType}出让成交公示` : "成交公示",
		title: item.afficheNo || "",
		source: "江苏土地市场网",
		sourceUrl: `${LANDJS_URL.replace(/\/tAfficheParcel\/.*/, "")}/`,
	};
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
			log.error("请通过 --city 提供城市名, 如 北京/深圳/苏州");
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
		else if (city === "杭州") this.fetchHangzhouPage(1);
		else if (city === "成都") this.fetchChengduForm();
		else if (SZ_CATEGORIES[city]) this.fetchSuzhouPage(1, SZ_CATEGORIES[city]);
		else if (city === "昆山") this.fetchKunshanPage(1);
		else if (city === "吴江") this.fetchLandjsPage(1);
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

	// ---- 其他城市 (landchina 全国成交公示) ----
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
				for (const item of items) {
					if (!item.title.includes(this.city)) continue;
					this.crawler.add({
						url: item.url,
						callback: (e2, r2, d2) => {
							if (e2) { log.error(e2); return d2(); }
							const text = item.title + String(r2.body).replace(/<[^>]+>/g, "");
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

	// ---- 杭州 (规自局成交结果公示, 竞得入选) ----
	fetchHangzhouPage(page) {
		this.crawler.add({
			url: hangzhouListUrl(page, this.pageSize),
			callback: (err, res, done) => {
				if (err) { log.error(err); return done(); }
				const { count, items } = parseHangzhouList(res.body);
				if (items.length === 0) {
					log.info(`杭州: page ${page} 无内容, 停止翻页`);
					return done();
				}
				const latest = items[0].date;
				const oldest = items[items.length - 1].date;
				log.info(`杭州: page ${page}, ${items.length} items (${oldest} ~ ${latest}), total ${count}`);
				for (const item of items) {
					if (item.date < this.dateFrom.slice(0, 10) || item.date > this.dateTo.slice(0, 10)) continue;
					if (argv.list && !item.title.includes(this.keyword)) continue;
					const base = {
						city: "杭州",
						dealDate: item.date,
						noticeType: "竞得入选公示",
						title: item.title,
						source: "杭州市规划和自然资源局",
						sourceUrl: item.url,
					};
					if (argv.list) {
						this.writeRows([{ parcelId: "", location: "", area: "", purpose: "", price: "", buyer: "", ...base }]);
						continue;
					}
					this.crawler.add({
						url: item.url,
						callback: (e2, r2, d2) => {
							if (e2) { log.error(e2); return d2(); }
							const text = item.title + String(r2.body).replace(/<[^>]+>/g, "");
							if (!text.includes(this.keyword)) return d2();
							const parcels = extractHangzhouDetail(r2.body);
							if (parcels.length === 0) {
								log.warn(`杭州: ${item.url} 命中关键词但未解析出地块表格`);
								return d2();
							}
							this.writeRows(parcels.map(p => ({ ...p, ...base })));
							return d2();
						},
					});
				}
				if (oldest >= this.dateFrom && page * this.pageSize < count) this.fetchHangzhouPage(page + 1);
				return done();
			},
		});
	}

	// ---- 成都 (公共资源交易中心结果一览表, ASP.NET postback 翻页) ----
	// 首页 GET 仅用于获取 VIEWSTATE 等隐藏字段: 服务端默认 PageSize=10,
	// 后续统一 POST 指定 PageSize, 避免页大小不一致导致翻页漏数据
	fetchChengduForm() {
		this.crawler.add({
			url: `${CD_BASE}/List.aspx`,
			callback: (err, res, done) => {
				if (err) { log.error(err); return done(); }
				const { form } = parseChengduList(res.body);
				if (!form.__VIEWSTATE) {
					log.error("成都: 列表页未返回 VIEWSTATE, 站点可能已改版");
					return done();
				}
				this.fetchChengduPage(1, { ...form, btnChangePage: "" });
				return done();
			},
		});
	}

	fetchChengduPage(page, form) {
		if (page > 20) {
			log.warn("成都: 已达 20 页上限, 建议缩小日期范围");
			return;
		}
		this.crawler.add({
			url: `${CD_BASE}/List.aspx`,
			method: "POST",
			form: { ...form, PageIndex: String(page), PageSize: String(this.pageSize) },
			headers: { "Referer": `${CD_BASE}/List.aspx` },
			callback: (err, res, done) => {
				if (err) { log.error(err); return done(); }
				const { form: nextForm, items } = parseChengduList(res.body);
				if (items.length === 0) {
					log.info(`成都: page ${page} 无内容, 停止翻页`);
					return done();
				}
				const latest = items[0].date;
				const oldest = items[items.length - 1].date;
				log.info(`成都: page ${page}, ${items.length} items (${oldest} ~ ${latest}), total ${nextForm.TotalRecords || "?"}`);
				for (const item of items) {
					if (!item.title.includes("结果一览表")) continue;
					if (item.date < this.dateFrom.slice(0, 10) || item.date > this.dateTo.slice(0, 10)) continue;
					const base = {
						city: "成都",
						dealDate: item.date,
						noticeType: item.title.includes("拍卖") ? "拍卖会成交结果" : "挂牌会结果",
						title: item.region ? `【${item.region}】${item.title}` : item.title,
						source: "成都市公共资源交易服务中心",
						sourceUrl: item.url,
					};
					if (argv.list) {
						this.writeRows([{ parcelId: "", location: "", area: "", purpose: "", price: "", buyer: "", ...base }]);
						continue;
					}
					this.crawler.add({
						url: item.url,
						callback: (e2, r2, d2) => {
							if (e2) { log.error(e2); return d2(); }
							const text = String(r2.body).replace(/<[^>]+>/g, "");
							if (!text.includes(this.keyword)) return d2();
							const parcels = extractChengduDetail(r2.body);
							if (parcels.length === 0) {
								log.warn(`成都: ${item.url} 命中关键词但未解析出地块表格`);
								return d2();
							}
							this.writeRows(parcels.map(p => ({ ...p, ...base })));
							return d2();
						},
					});
				}
				const total = parseInt(nextForm.TotalRecords, 10) || 0;
				if (oldest >= this.dateFrom && page * this.pageSize < total) {
					this.fetchChengduPage(page + 1, { ...nextForm, btnChangePage: "" });
				}
				return done();
			},
		});
	}

	// ---- 苏州/常熟/太仓 (交易平台 JSON API: 列表 -> getDetailPath -> 静态详情) ----
	// 服务端 pageIndex>=10 强制验证码; pageSize>1 的二级索引滞后, 会漏最新记录。
	// 两段式: pageSize=1 扫前 9 页(最新记录), 未达日期下限时切 pageSize=10 深翻, infoid 去重
	fetchSuzhouPage(page, categorynum, pageSize = 1) {
		if (page > 9) {
			if (pageSize === 1 && !this.szDateCovered) {
				log.info("苏州: 切换深页翻页 pageSize=10");
				this.fetchSuzhouPage(1, categorynum, 10);
			} else if (pageSize === 10) {
				log.warn("苏州: 已达 pageIndex 上限, 更早记录受验证码限制无法获取, 建议缩小日期范围");
			}
			return;
		}
		const fetchList = (attempt) => this.crawler.add({
			url: suzhouListUrl(categorynum, page, pageSize),
			callback: (err, res, done) => {
				if (err) { log.error(err); return done(); }
				const { total, items } = parseSuzhouList(res.body);
				if (items.length === 0) {
					if (attempt < 5) {
						log.warn(`苏州: page ${page} 列表为空, 重试 ${attempt + 1}/5`);
						fetchList(attempt + 1);
					} else {
						log.info(`苏州: page ${page} 无内容, 停止翻页`);
					}
					return done();
				}
				const latest = items[0].postdate;
				const oldest = items[items.length - 1].postdate;
				log.info(`苏州: page ${page} (size ${pageSize}), ${items.length} items (${oldest} ~ ${latest}), total ${total}`);
				this.suzhouSeen ??= new Set();
				for (const item of items) {
					if (this.suzhouSeen.has(item.infoid)) continue;
					this.suzhouSeen.add(item.infoid);
					const date = (item.postdate || "").slice(0, 10);
					if (date < this.dateFrom.slice(0, 10) || date > this.dateTo.slice(0, 10)) continue;
					if (argv.list && !item.title.includes(this.keyword)) continue;
					const base = {
						city: this.city,
						noticeType: "成交公示",
						title: item.title,
						source: "苏州市公共资源交易中心",
					};
					if (argv.list) {
						this.writeRows([{ parcelId: "", location: "", area: "", purpose: "", price: "", buyer: "", dealDate: date, ...base, sourceUrl: "" }]);
						continue;
					}
					this.crawler.add({
						url: suzhouDetailPathUrl(categorynum, item.infoid),
						callback: (e2, r2, d2) => {
							if (e2) { log.error(e2); return d2(); }
							const detailPath = parseSuzhouDetailPath(r2.body);
							if (!detailPath) {
								log.warn(`苏州: ${item.infoid} 未返回详情路径`);
								return d2();
							}
							const detailUrl = `https://ggzy.suzhou.gov.cn${detailPath}`;
							const fetchDetail = (att) => this.crawler.add({
								url: detailUrl,
								callback: (e3, r3, d3) => {
									if (e3) { log.error(e3); return d3(); }
									if (String(r3.body).includes("502 Bad Gateway")) {
										if (att < 3) {
											log.warn(`苏州: ${detailUrl} 被 WAF 拦截, 重试 ${att + 1}/3`);
											fetchDetail(att + 1);
										} else {
											log.error(`苏州: ${detailUrl} 重试 3 次仍被 WAF 拦截, 跳过`);
										}
										return d3();
									}
									const text = item.title + String(r3.body).replace(/<[^>]+>/g, "");
									if (!text.includes(this.keyword)) return d3();
									const parcels = extractSuzhouDetail(r3.body);
									if (parcels.length === 0) {
										log.warn(`苏州: ${detailUrl} 命中关键词但未解析出地块表格`);
										return d3();
									}
									this.writeRows(parcels.map(p => ({
										...p,
										dealDate: p.dealDate || date,
										...base,
										sourceUrl: detailUrl,
									})));
									return d3();
								},
							});
							fetchDetail(1);
							return d2();
						},
					});
				}
				if (oldest < this.dateFrom) this.szDateCovered = true;
				if (oldest >= this.dateFrom && page * pageSize < total) this.fetchSuzhouPage(page + 1, categorynum, pageSize);
				return done();
			},
		});
		fetchList(1);
	}

	// ---- 昆山 (市政府土地成交公告静态页) ----
	fetchKunshanPage(page) {
		this.crawler.add({
			url: kunshanPageUrl(page),
			callback: (err, res, done) => {
				if (err) { log.error(err); return done(); }
				const { pageCount, items } = parseKunshanList(res.body);
				if (items.length === 0) {
					log.info(`昆山: page ${page} 无内容, 停止翻页`);
					return done();
				}
				const latest = items[0].date;
				const oldest = items[items.length - 1].date;
				log.info(`昆山: page ${page}, ${items.length} items (${oldest} ~ ${latest}), pages ${pageCount}`);
				for (const item of items) {
					if (item.date < this.dateFrom.slice(0, 10) || item.date > this.dateTo.slice(0, 10)) continue;
					if (argv.list && !item.title.includes(this.keyword)) continue;
					const base = {
						city: "昆山",
						dealDate: item.date,
						noticeType: "挂牌成交公告",
						title: item.title,
						source: "昆山市人民政府",
						sourceUrl: item.url,
					};
					if (argv.list) {
						this.writeRows([{ parcelId: "", location: "", area: "", purpose: "", price: "", buyer: "", ...base }]);
						continue;
					}
					this.crawler.add({
						url: item.url,
						callback: (e2, r2, d2) => {
							if (e2) { log.error(e2); return d2(); }
							const text = item.title + String(r2.body).replace(/<[^>]+>/g, "");
							if (!text.includes(this.keyword)) return d2();
							const parcels = extractKunshanDetail(r2.body);
							if (parcels.length === 0) {
								log.warn(`昆山: ${item.url} 命中关键词但未解析出地块表格`);
								return d2();
							}
							this.writeRows(parcels.map(p => ({ ...p, ...base })));
							return d2();
						},
					});
				}
				if (oldest >= this.dateFrom && page < pageCount) this.fetchKunshanPage(page + 1);
				return done();
			},
		});
	}

	// ---- 吴江 (江苏土地市场网, 按成交日期服务端过滤, 响应含全字段) ----
	fetchLandjsPage(page) {
		this.crawler.add({
			url: LANDJS_URL,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				index: page,
				size: this.pageSize,
				xzqDm: WUJIANG_XZQDM,
				bargainTimeFrom: this.dateFrom.slice(0, 10),
				bargainTimeTo: this.dateTo.slice(0, 10),
			}),
			callback: (err, res, done) => {
				if (err) { log.error(err); return done(); }
				const { total, items } = parseLandjsList(res.body);
				if (items.length === 0) {
					if (page === 1) log.warn(`吴江: 日期范围内无成交记录`);
					return done();
				}
				log.info(`吴江: page ${page}, ${items.length} items, total ${total}`);
				const kw = this.keyword;
				const matched = items.filter(it => [it.parcelNo, it.landPosition, it.alienee, it.afficheNo].some(f => f && f.includes(kw)));
				if (page === 1 && matched.length === 0 && argv.list) log.warn(`吴江: 未找到关键词 "${kw}" 的匹配`);
				this.writeRows(matched.map(it => ({ city: "吴江", ...normalizeLandjsParcel(it) })));
				if (page * this.pageSize < total) this.fetchLandjsPage(page + 1);
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
