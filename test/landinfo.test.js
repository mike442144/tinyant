import assert from "node:assert/strict";
import {
	resolveCity,
	normalizeBeijing,
	parseBeijingList,
	parseShenzhenList,
	normalizeShenzhen,
	extractShenzhenDetail,
	normalizeArea,
	normalizePrice,
	parseLandchinaIndex,
	landchinaPageUrl,
	extractLandchinaDetail,
	hangzhouListUrl,
	parseHangzhouList,
	extractHangzhouDetail,
	parseChengduList,
	extractChengduDetail,
	suzhouListUrl,
	suzhouDetailPathUrl,
	parseSuzhouList,
	parseSuzhouDetailPath,
	normalizeDealDate,
	extractSuzhouDetail,
	kunshanPageUrl,
	parseKunshanList,
	extractKunshanDetail,
	parseLandjsList,
	normalizeLandjsParcel,
} from "../landinfo/index.js";

let pass = 0, fail = 0;
const t = (name, fn) => {
	try { fn(); pass++; console.log(`  ok  ${name}`); }
	catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); };
};

console.log('resolveCity:');
t('中文名', () => assert.equal(resolveCity('深圳'), '深圳'));
t('带"市"后缀', () => assert.equal(resolveCity('北京市'), '北京'));
t('英文别名', () => assert.equal(resolveCity('sh'), '上海'));
t('二线城市透传', () => assert.equal(resolveCity('苏州'), '苏州'));
t('带"市"后缀的二线城市', () => assert.equal(resolveCity('苏州市'), '苏州'));
t('空值返回 null', () => assert.equal(resolveCity(''), null));

console.log('normalizeArea / normalizePrice:');
t('公顷 -> 平方米', () => assert.equal(normalizeArea('1.512453公顷'), '15124.53'));
t('平方米原样保留', () => assert.equal(normalizeArea('31329.369平方米'), '31329.369'));
t('带千分位', () => assert.equal(normalizeArea('1,234平方米'), '1234'));
t('亩 -> 平方米', () => assert.equal(normalizeArea('34.3亩'), '22866.667'));
t('亿元 -> 万元', () => assert.equal(normalizePrice('1.2亿元'), '12000'));
t('万元原样保留', () => assert.equal(normalizePrice('14362万元'), '14362'));
t('空值返回空串', () => assert.equal(normalizeArea(''), ''));

console.log('parseBeijingList:');
t('正常响应', () => {
	const { count, items } = parseBeijingList(JSON.stringify({ code: '0', count: 3, data: [{ id: 'x' }] }));
	assert.equal(count, 3);
	assert.equal(items.length, 1);
});
t('非法 JSON 返回空', () => {
	const { count, items } = parseBeijingList('<html>oops</html>');
	assert.equal(count, 0);
	assert.equal(items.length, 0);
});
t('code 非 0 返回空', () => {
	const { items } = parseBeijingList(JSON.stringify({ code: '1', data: [{ id: 'x' }] }));
	assert.equal(items.length, 0);
});

console.log('normalizeBeijing:');
t('字段映射', () => {
	const row = normalizeBeijing({
		id: 'abc', landid: '京土储挂（丰）[2026]046号', landlocation: '丰台区',
		landtotalarea: '31329.369', landusetype1DictText: '商服', landusetype2: 'B4综合用地',
		chengJiaoJinE: '66000', jingDeRen: '某公司', publishTime: '2026-08-05 09:11:34',
		announcetypeDictText: '挂牌出让公告', title: '丰台某地块',
	});
	assert.equal(row.city, '北京');
	assert.equal(row.parcelId, '京土储挂（丰）[2026]046号');
	assert.equal(row.purpose, '商服/B4综合用地');
	assert.equal(row.dealDate, '2026-08-05');
	assert.ok(row.sourceUrl.includes('abc'));
});
t('缺失字段容错', () => {
	const row = normalizeBeijing({ id: 'x' });
	assert.equal(row.parcelId, '');
	assert.equal(row.dealDate, '');
});

console.log('parseShenzhenList / normalizeShenzhen:');
t('正常响应', () => {
	const body = JSON.stringify({ code: 200, data: { totalElements: 5, content: [{ contentId: 1, noticeTitle: 't', publishTime: '2026-08-05 15:05:29', projectCode: '深土[2026]-[047]', winnerName: 'W' }] } });
	const { total, items } = parseShenzhenList(body);
	assert.equal(total, 5);
	const row = normalizeShenzhen(items[0]);
	assert.equal(row.parcelId, '深土[2026]-[047]');
	assert.equal(row.buyer, 'W');
	assert.equal(row.dealDate, '2026-08-05');
});
t('非法 code 返回空', () => {
	assert.equal(parseShenzhenList(JSON.stringify({ code: 500 })).items.length, 0);
});

console.log('extractShenzhenDetail:');
t('结果公示键值对格式', () => {
	const data = {
		attrs: [{ attrName: 'jygg_jdr', attrValue: '沃尔公司' }],
		txt: '<p><strong>宗地号：</strong><span>G13111-0115；</span></p><p><strong>竞得人：</strong><span>沃尔公司；</span></p><p><strong>土地用途：</strong><span>普通工业用地；</span></p>',
	};
	const d = extractShenzhenDetail(data);
	assert.equal(d.parcelId, 'G13111-0115');
	assert.equal(d.purpose, '普通工业用地');
	assert.equal(d.buyer, '沃尔公司');
});
t('交易公告表格格式', () => {
	const data = {
		attrs: [],
		txt: '<table><tr><th>宗地号</th><th>土地 位置</th><th>土地 用途</th><th>土地面积（平方米）</th><th>挂牌起始价（人民币、万元）</th></tr><tr><td>G13111-0115</td><td>坪山区龙田街道</td><td>普通工业用地</td><td>2322.65</td><td>715</td></tr></table>',
	};
	const d = extractShenzhenDetail(data);
	assert.equal(d.parcelId, 'G13111-0115');
	assert.equal(d.location, '坪山区龙田街道');
	assert.equal(d.area, '2322.65');
	assert.equal(d.price, '715');
});
t('空数据容错', () => {
	const d = extractShenzhenDetail(null);
	assert.equal(d.parcelId, '');
});

console.log('landchina:');
t('分页 URL', () => {
	assert.equal(landchinaPageUrl(0), 'https://landchina.mnr.gov.cn/land/cjgs/gpcr/index.htm');
	assert.equal(landchinaPageUrl(3), 'https://landchina.mnr.gov.cn/land/cjgs/gpcr/index_3.htm');
});
t('列表解析', () => {
	const html = '<li><span>2026.08.04</span><a href="./202608/t20260805_10287110.htm" target="_blank">广州市规划和自然资源局国有土地使用权招拍挂出让成交公示</a></li>';
	const items = parseLandchinaIndex(html);
	assert.equal(items.length, 1);
	assert.equal(items[0].date, '2026-08-04');
	assert.equal(items[0].url, 'https://landchina.mnr.gov.cn/land/cjgs/gpcr/202608/t20260805_10287110.htm');
});
t('详情表格解析', () => {
	const html = '<table><tr><td>宗地编号：</td><td>&nbsp;2010-A20-A</td></tr><tr><td>宗地总面积：</td><td>&nbsp;1.512453公顷</td></tr><tr><td>宗地坐落：</td><td>&nbsp;市区人民路南侧</td></tr><tr><td>土地用途：</td><td>&nbsp;普通商品住房用地(二类)</td></tr><tr><td>成交价：</td><td>&nbsp;14362万元</td></tr><tr><td>受让单位：</td><td>&nbsp;绿城房地产集团有限公司</td></tr></table>';
	const parcels = extractLandchinaDetail(html);
	assert.equal(parcels.length, 1);
	assert.equal(parcels[0].parcelId, '2010-A20-A');
	assert.equal(parcels[0].area, '15124.53');
	assert.equal(parcels[0].price, '14362');
	assert.equal(parcels[0].buyer, '绿城房地产集团有限公司');
});
t('多地块表格', () => {
	const html = '<table><tr><td>宗地编号：</td><td>A1</td></tr></table><table><tr><td>宗地编号：</td><td>A2</td></tr></table>';
	assert.equal(extractLandchinaDetail(html).length, 2);
});
t('无地块表格返回空', () => {
	assert.equal(extractLandchinaDetail('<table><tr><td>无关内容</td></tr></table>').length, 0);
});

console.log('hangzhou:');
t('别名', () => {
	assert.equal(resolveCity('hz'), '杭州');
	assert.equal(resolveCity('cd'), '成都');
});
t('列表 URL 含分页参数', () => {
	const url = hangzhouListUrl(2, 15);
	assert.ok(url.includes('pageId=1228962705'));
	assert.ok(decodeURIComponent(url).includes('"pageNo":2'));
});
t('列表解析', () => {
	const body = JSON.stringify({ success: true, data: { html: '<div count="544" pageNo="1"><li><span class="fr">[2026-07-28]</span><a title="杭政储出[2026]55-56号地块挂牌出让竞得入选情况表" href="/col/col1228962705/art/2026/art_d113.html">杭政储出[2026]55-56号地块挂牌出让竞得入选情况表</a></li></div>' } });
	const { count, items } = parseHangzhouList(body);
	assert.equal(count, 544);
	assert.equal(items.length, 1);
	assert.equal(items[0].date, '2026-07-28');
	assert.ok(items[0].url.startsWith('https://ghzy.hangzhou.gov.cn/col/'));
});
t('列表非法响应返回空', () => {
	assert.equal(parseHangzhouList('<html>').items.length, 0);
	assert.equal(parseHangzhouList(JSON.stringify({ data: { html: '模版内容不能为空！' } })).items.length, 0);
});
t('详情表格解析(亩换算+跳过合计)', () => {
	const html = `<table>
		<tr><th>地块编号</th><th>地块名称</th><th>用地性质</th><th>土地面积（亩）</th><th>容积率</th><th>成交价</th><th>竞得入选人</th></tr>
		<tr><th>总价(万元)</th></tr>
		<tr><td>杭政储出[2026]55号</td><td>上城区（长睦单元JG0203-03地块）</td><td>住宅（设配套公建）用地</td><td>34.3</td><td>1.8</td><td>56561</td><td>杭州滨盟房地产开发有限公司</td></tr>
		<tr><td>杭政储出[2026]56号</td><td>拱墅区（康桥单元GS120103-10地块）</td><td>住宅（设配套公建）用地</td><td>59.9</td><td>2.0</td><td>181047</td><td>杭州滨曼房地产开发有限公司</td></tr>
		<tr><td>合计</td><td>94.2</td><td></td><td>237608</td><td></td></tr>
	</table>`;
	const parcels = extractHangzhouDetail(html);
	assert.equal(parcels.length, 2);
	assert.equal(parcels[0].parcelId, '杭政储出[2026]55号');
	assert.equal(parcels[0].area, '22866.667');
	assert.equal(parcels[0].price, '56561');
	assert.equal(parcels[1].buyer, '杭州滨曼房地产开发有限公司');
});
t('详情无地块表格返回空', () => {
	assert.equal(extractHangzhouDetail('<table><tr><td>无关</td></tr></table>').length, 0);
});

console.log('chengdu:');
t('列表解析(条目+隐藏字段)', () => {
	const html = `<form>
		<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="/wEPDwUKMTI0" />
		<input type="hidden" name="TotalRecords" id="TotalRecords" value="5519" />
		<input type="hidden" name="PageSize" id="PageSize" value="10" />
		<input type="hidden" name="PageIndex" id="PageIndex" value="1" />
		<div class="list-row">
			<div class="list-item">【市本级】</div>
			<div class="list-item list-item-title" title=" 拍卖会成交结果一览表(2026年08月04日)" onclick="javascript:window.open('/sitenew/notice/LandTrade/LandNoticeContent.aspx?id=189aea35')">拍卖会成交结果一览表(2026年08月04日)</div>
			<div class="list-item"></div>
			<div class="list-item">2026-08-04</div>
		</div>
	</form>`;
	const { form, items } = parseChengduList(html);
	assert.equal(form.TotalRecords, '5519');
	assert.ok(form.__VIEWSTATE.startsWith('/wEP'));
	assert.equal(items.length, 1);
	assert.equal(items[0].region, '市本级');
	assert.equal(items[0].date, '2026-08-04');
	assert.ok(items[0].url.includes('id=189aea35'));
});
t('详情表格解析(单价换算总价)', () => {
	const html = `<table>
		<tr><th>序号</th><th>宗地编号</th><th>宗地位置</th><th>净用地面积</th><th>起始价</th><th>成交价</th><th>竞得人</th></tr>
		<tr><td>1</td><td>CH05(070102):2026-017</td><td>成华区跳蹬河街道崔家店路411号</td><td>16366.65平方米，合24.55亩</td><td>14800元/平方米</td><td>14800元/平方米</td><td>成都成华优创城市更新建设有限责任公司</td></tr>
	</table>`;
	const parcels = extractChengduDetail(html);
	assert.equal(parcels.length, 1);
	assert.equal(parcels[0].parcelId, 'CH05(070102):2026-017');
	assert.equal(parcels[0].area, '16366.65');
	assert.equal(parcels[0].price, '24222.64');
	assert.equal(parcels[0].buyer, '成都成华优创城市更新建设有限责任公司');
});
t('详情总价格式走 normalizePrice', () => {
	const html = `<table>
		<tr><th>宗地编号</th><th>宗地位置</th><th>净用地面积</th><th>成交价</th><th>竞得人</th></tr>
		<tr><td>CZ2026-01</td><td>武侯区</td><td>2公顷</td><td>3.5亿元</td><td>某公司</td></tr>
	</table>`;
	const parcels = extractChengduDetail(html);
	assert.equal(parcels[0].price, '35000');
});
t('详情无宗地表格返回空', () => {
	assert.equal(extractChengduDetail('<table><tr><td>无关</td></tr></table>').length, 0);
});

console.log('suzhou:');
t('别名', () => {
	assert.equal(resolveCity('苏州市'), '苏州');
	assert.equal(resolveCity('常熟市'), '常熟');
	assert.equal(resolveCity('kunshan'), '昆山');
	assert.equal(resolveCity('太仓市'), '太仓');
	assert.equal(resolveCity('wujiang'), '吴江');
});
t('列表 URL', () => {
	assert.ok(suzhouListUrl('003005004', 2, 20).includes('cmd=getList1&pageIndex=2&pageSize=20&categorynum=003005004'));
});
t('详情路径 URL 带 pageIndex', () => {
	assert.ok(suzhouDetailPathUrl('003014004', 'abc').includes('cmd=getDetailPath&categorynum=003014004&infoid=abc'));
	assert.ok(suzhouDetailPathUrl('003014004', 'abc').includes('pageIndex=0'));
});
t('列表解析(custom 二次解析)', () => {
	const body = JSON.stringify({ custom: JSON.stringify({ TotalCount: 1413, Table: [{ infoid: 'x', city: '苏州市区', postdate: '2026-04-29', title: '苏地2026-WG-Z06号地块成交公示' }] }) });
	const { total, items } = parseSuzhouList(body);
	assert.equal(total, 1413);
	assert.equal(items.length, 1);
	assert.equal(items[0].infoid, 'x');
});
t('列表非法响应返回空', () => {
	assert.equal(parseSuzhouList('<html>').items.length, 0);
	assert.equal(parseSuzhouList(JSON.stringify({ custom: '{}' })).items.length, 0);
});
t('详情路径解析', () => {
	assert.equal(parseSuzhouDetailPath(JSON.stringify({ custom: '/jyxx/003005/003005004/20260617/abc.html' })), '/jyxx/003005/003005004/20260617/abc.html');
	assert.equal(parseSuzhouDetailPath(JSON.stringify({ custom: '验证码验证失败！' })), null);
});
t('成交日期归一', () => {
	assert.equal(normalizeDealDate('2026-04-29 10:34:00.0'), '2026-04-29');
	assert.equal(normalizeDealDate('2026.3.18'), '2026-03-18');
	assert.equal(normalizeDealDate(''), '');
});
t('市区详情(键值对+信用代码剥离)', () => {
	const html = '<table><tr><td>地块编号</td><td>苏地2026-WG-Z06号</td><td>土地位置</td><td>相城区望亭镇</td></tr><tr><td>出让面积（平方米）</td><td>47494</td><td>竞得价（万元）</td><td>33911</td></tr><tr><td>竞得单位</td><td>中亿丰物产（苏州）集团有限公司9132058559862639X9</td><td>成交时间</td><td>2026-04-29 10:34:00.0</td></tr></table>';
	const parcels = extractSuzhouDetail(html);
	assert.equal(parcels.length, 1);
	assert.equal(parcels[0].parcelId, '苏地2026-WG-Z06号');
	assert.equal(parcels[0].area, '47494');
	assert.equal(parcels[0].price, '33911');
	assert.equal(parcels[0].buyer, '中亿丰物产（苏州）集团有限公司');
	assert.equal(parcels[0].dealDate, '2026-04-29');
});
t('常熟详情(列式表格+表头含空格)', () => {
	const html = '<table><tr><th>地块编号</th><th>地 块 位 置</th><th>面积（㎡）</th><th>用途</th><th>成交价（万元）</th><th>成交人</th><th>成交日期</th></tr><tr><td>2026G009</td><td>支塘镇规划西外环路以东</td><td>22025</td><td>工业</td><td>1321.5</td><td>苏州通成化妆品包装有限公司</td><td>2026.3.18</td></tr></table>';
	const parcels = extractSuzhouDetail(html);
	assert.equal(parcels.length, 1);
	assert.equal(parcels[0].parcelId, '2026G009');
	assert.equal(parcels[0].location, '支塘镇规划西外环路以东');
	assert.equal(parcels[0].dealDate, '2026-03-18');
});
t('嵌套表格不重复解析', () => {
	const inner = '<table><tr><td>地块编号</td><td>A1</td><td>土地位置</td><td>X</td></tr></table>';
	const parcels = extractSuzhouDetail(`<table><tr><td>${inner}</td></tr></table>`);
	assert.equal(parcels.length, 1);
});

console.log('kunshan:');
t('分页 URL', () => {
	assert.equal(kunshanPageUrl(1), 'https://www.ks.gov.cn/kss/cjgg/common_list.shtml');
	assert.equal(kunshanPageUrl(3), 'https://www.ks.gov.cn/kss/cjgg/common_list_3.shtml');
});
t('列表解析(忽略栏目导航链接)', () => {
	const html = `<a href="/kss/cjgg/common_list.shtml" title="土地成交公告">土地成交公告</a>
	<li><h4><a href="/kss/cjgg/202607/a959.shtml" title="开发区南浜路南侧等3宗地块的挂牌成交公告（昆地网[2026]住挂字3号）" target="_blank">开发区南浜路南侧等3宗地块的挂牌成交公告（昆地网[2026]住挂字3号）</a><span class="time">2026-07-16</span></h4></li>
	createPageHTML('page_div',22, 1,'common_list','shtml',325)`;
	const { pageCount, items } = parseKunshanList(html);
	assert.equal(pageCount, 22);
	assert.equal(items.length, 1);
	assert.equal(items[0].date, '2026-07-16');
	assert.ok(items[0].url.endsWith('a959.shtml'));
});
t('详情列式表格解析', () => {
	const html = '<table><tr><th>序号</th><th>地块位置</th><th>土地面积(M2)</th><th>用途</th><th>起始总价（万元）</th><th>竞得价（万元）</th><th>竞得人</th></tr><tr><td>昆地网[2026]住挂字3号</td><td>开发区南浜路南侧、顺帆北路西侧</td><td>39745</td><td>住宅</td><td>50677</td><td>57297</td><td>昆山市悦茂置业有限公司</td></tr></table>';
	const parcels = extractKunshanDetail(html);
	assert.equal(parcels.length, 1);
	assert.equal(parcels[0].parcelId, '昆地网[2026]住挂字3号');
	assert.equal(parcels[0].area, '39745');
	assert.equal(parcels[0].price, '57297');
	assert.equal(parcels[0].buyer, '昆山市悦茂置业有限公司');
});
t('详情无表格返回空', () => {
	assert.equal(extractKunshanDetail('<table><tr><td>无关</td></tr></table>').length, 0);
});
t('太仓详情键名(出让面积（㎡）/规划用途)', () => {
	const html = '<table><tr><td>地块编号</td><td>2026-WG-13-2</td><td>土地位置</td><td>沙溪镇沙南公路南、翁家泾西</td></tr><tr><td>出让面积（㎡）</td><td>1483.5</td><td>规划用途</td><td>排水用地</td><td>竞得价（万元）</td><td>67</td></tr><tr><td>竞得单位</td><td>太仓市沙溪镇集体资产经营有限公司</td><td>成交时间</td><td>2026-07-22</td></tr></table>';
	const parcels = extractSuzhouDetail(html);
	assert.equal(parcels.length, 1);
	assert.equal(parcels[0].parcelId, '2026-WG-13-2');
	assert.equal(parcels[0].area, '1483.5');
	assert.equal(parcels[0].purpose, '排水用地');
	assert.equal(parcels[0].price, '67');
	assert.equal(parcels[0].dealDate, '2026-07-22');
});

console.log('wujiang:');
t('列表解析', () => {
	const body = JSON.stringify({ total: 39, totalPages: 2, bargainParcelList: [{ parcelNo: 'WJ-J-2026-003', bargainDate: 1750867200000 }] });
	const { total, items } = parseLandjsList(body);
	assert.equal(total, 39);
	assert.equal(items.length, 1);
});
t('列表非法响应返回空', () => {
	assert.equal(parseLandjsList('<html>').items.length, 0);
});
t('地块归一化(时间戳/字段映射)', () => {
	const row = normalizeLandjsParcel({
		parcelNo: 'WJ-G-2026-021', landPosition: '平望镇南粤路以南', remiseArea: 26033.55,
		landUse: '工业', price: 9664.45935, alienee: '苏州平望漂染有限公司',
		bargainDate: 1750867200000, remiseType: '挂牌', afficheNo: '吴地网挂[2026]8号',
	});
	assert.equal(row.parcelId, 'WJ-G-2026-021');
	assert.equal(row.area, '26033.55');
	assert.equal(row.price, '9664.45935');
	assert.equal(row.noticeType, '挂牌出让成交公示');
	assert.equal(row.title, '吴地网挂[2026]8号');
	assert.match(row.dealDate, /^\d{4}-\d{2}-\d{2}$/);
	assert.ok(row.sourceUrl.startsWith('http://www.landjs.com'));
});
t('缺失时间戳容错', () => {
	const row = normalizeLandjsParcel({ parcelNo: 'X', bargainDate: null });
	assert.equal(row.dealDate, '');
	assert.equal(row.noticeType, '成交公示');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
