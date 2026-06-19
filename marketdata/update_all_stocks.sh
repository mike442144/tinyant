#!/bin/bash
# update_all_stocks.sh - 全量更新 A 股日 K 线数据
#
# 数据源:
#   K线数据: 新浪财经 (money.finance.sina.com.cn)
#     - 不复权日 K 线, datalen=10000 (覆盖 ~40 年)
#     - 含退市股历史数据
#     - 不含北交所 (920xxx)
#
#   除权除息: 东方财富 (datacenter-web.eastmoney.com)
#     - RPT_SHAREBONUS_DET: 现金分红 + 送转股
#     - F10 BonusFinancing: 配股 (rights issue)
#
#   股票列表:
#     沪深全量: 新浪 Market_Center.getHQNodeData (sh_a + sz_a)
#     中证2000: 东方财富 RPT_INDEX_TS_COMPONENT (TYPE=13)
#     中证1000: 东方财富 RPT_INDEX_TS_COMPONENT (TYPE=7)
#     退市股:   扫描代码段 + 新浪 API 探测
#
# 输出:
#   data/<code>/<code>_kline.csv     - CSV (date,open,close,high,low,volume,adj_factor)
#   data/<code>/<code>_kline.parquet - Parquet (同上 schema)
#
# adj_factor: 涨跌幅复权 (比例复权), 首行归一为 1.0
#   后复权 close = close × adj_factor
#   前复权 close = close × adj_factor / adj_factor(最新)
#
# 用法:
#   bash update_all_stocks.sh              # 增量更新 (默认)
#   bash update_all_stocks.sh --full       # 全量更新 (忽略已有, 重新下载)
#   bash update_all_stocks.sh --codes-only # 只更新股票列表, 不下载
#
# 依赖: node (npm install), python3

set -euo pipefail
cd "$(dirname "$0")"

FORCE_FLAG=""
CODES_ONLY=false
if [[ "${1:-}" == "--full" ]]; then
    FORCE_FLAG="--force"
    echo "=== 全量更新模式 (--force) ==="
elif [[ "${1:-}" == "--codes-only" ]]; then
    CODES_ONLY=true
    echo "=== 仅更新股票列表 ==="
else
    echo "=== 增量更新模式 ==="
fi

SKIP_FILE="csi2000_skip.txt"
ALL_SHSZ_FILE="all_shsz_codes.txt"
DELISTED_FILE="delisted_codes.txt"

# ─── Step 1: 获取沪深全量股票列表 ─────────────────────────────
echo ""
echo "=== Step 1: 获取沪深全量股票列表 (新浪) ==="
python3 -c "
import json, urllib.request

all_codes = []
for node in ['sh_a', 'sz_a']:
    page = 1
    while True:
        url = f'http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page={page}&num=100&sort=symbol&asc=1&node={node}'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            if not data:
                break
            for r in data:
                sym = r.get('symbol', '')
                if sym.startswith('sh') or sym.startswith('sz'):
                    all_codes.append(sym[2:])
            if len(data) < 100:
                break
            page += 1

with open('$ALL_SHSZ_FILE', 'w') as f:
    f.write(','.join(all_codes))
print(f'沪深 A 股: {len(all_codes)} 只 -> $ALL_SHSZ_FILE')
"

# ─── Step 2: 扫描退市股 ──────────────────────────────────────
echo ""
echo "=== Step 2: 扫描退市股 (新浪 API 探测) ==="
python3 -c "
import json, urllib.request, os

our_stocks = set()
if os.path.exists('data'):
    for d in os.listdir('data'):
        if os.path.isdir(os.path.join('data', d)):
            code = d[2:] if d.startswith(('sh', 'sz')) else d
            our_stocks.add(code)

# 从 all_shsz_codes.txt 也加入
if os.path.exists('$ALL_SHSZ_FILE'):
    with open('$ALL_SHSZ_FILE') as f:
        our_stocks.update(f.read().strip().split(','))

ranges = [
    ('sz', 1, 1000), ('sz', 1001, 2000), ('sz', 2001, 3000),
    ('sh', 600001, 601000), ('sh', 601001, 602000), ('sh', 603001, 604000),
]

delisted = []
for prefix, start, end in ranges:
    for i in range(start, end):
        code = f'{i:06d}'
        if code in our_stocks:
            continue
        symbol = f'{prefix}{code}'
        url = f'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol={symbol}&scale=240&ma=no&datalen=2'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read())
                if isinstance(data, list) and len(data) > 0:
                    delisted.append(code)
        except:
            pass
    print(f'  扫描 {prefix} {start:06d}-{end:06d}: 累计发现 {len(delisted)} 只')

with open('$DELISTED_FILE', 'w') as f:
    f.write(','.join(delisted))
print(f'退市股: {len(delisted)} 只 -> $DELISTED_FILE')
"

if $CODES_ONLY; then
    echo ""
    echo "=== 股票列表更新完成 ==="
    echo "  沪深 A 股: $ALL_SHSZ_FILE"
    echo "  退市股:    $DELISTED_FILE"
    exit 0
fi

# ─── Step 3: 合并列表, 过滤北交所 ──────────────────────────────
echo ""
echo "=== Step 3: 合并列表, 过滤北交所 (920xxx) ==="
python3 -c "
codes = set()
for f in ['$ALL_SHSZ_FILE', '$DELISTED_FILE']:
    try:
        with open(f) as fh:
            codes.update(c for c in fh.read().strip().split(',') if c and not c.startswith('920'))
    except:
        pass
merged = sorted(codes)
with open('_merged_codes.txt', 'w') as f:
    f.write(','.join(merged))
print(f'合并后: {len(merged)} 只 (已过滤北交所)')
"

# ─── Step 4: 下载 K 线 + 除权除息 ─────────────────────────────
echo ""
echo "=== Step 4: 下载 K 线 + 计算复权因子 (新浪 + 东方财富) ==="
echo "  数据源: 新浪 K 线 + 东方财富分红配股"
echo "  并发: 1, 无 rate limit"
echo "  增量: 已有 CSV 的股票只下载增量, 到昨天的秒跳"
echo ""

node index.js --codes "$(cat _merged_codes.txt)" $FORCE_FLAG

rm -f _merged_codes.txt

# ─── Step 5: 汇总 ────────────────────────────────────────────
echo ""
echo "=== 完成 ==="
echo -n "数据目录: "; ls data/ | wc -l
echo -n "CSV 文件: "; find data/ -name "*_kline.csv" | wc -l
echo -n "Parquet:  "; find data/ -name "*_kline.parquet" | wc -l
echo -n "磁盘占用: "; du -sh data/ | cut -f1
echo ""
echo "跳过列表: $SKIP_FILE ($(wc -l < $SKIP_FILE 2>/dev/null || echo 0) 只, 北交所)"
echo ""
echo "Python 测试:"
echo "  .venv/bin/python ../test/marketdata_parquet.test.py"
