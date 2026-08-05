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
t('未知城市返回 null', () => assert.equal(resolveCity('杭州'), null));
t('空值返回 null', () => assert.equal(resolveCity(''), null));

console.log('normalizeArea / normalizePrice:');
t('公顷 -> 平方米', () => assert.equal(normalizeArea('1.512453公顷'), '15124.53'));
t('平方米原样保留', () => assert.equal(normalizeArea('31329.369平方米'), '31329.369'));
t('带千分位', () => assert.equal(normalizeArea('1,234平方米'), '1234'));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
