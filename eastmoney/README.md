# EastMoney Financial Data Crawler

这是一个用于从东方财富网爬取上市公司财务数据的Node.js脚本。

## 功能特点

- 支持获取上市公司年度/季度财务报告数据
- 包含扣非净利润、营业总收入、毛利润、归母净利润等关键财务指标
- 数据单位：百万元（除以1,000,000转换）
- 自动保存CSV格式数据文件和日志

## 安装依赖

```bash
npm install
```

需要的依赖包已在`package.json`中定义：
- crawler: 网络爬虫库
- dayjs: 日期处理
- papaparse: CSV解析
- ramda: 函数式编程工具库
- minimist: 命令行参数解析

## 使用方法

### 基本命令

```bash
node index.js [options]
```

### 参数说明

| 参数 | 别名 | 说明 | 默认值 |
|------|------|------|--------|
| `--file <path>` | - | 股票代码文件路径（每行一个代码，#开头为注释） | - |
| `--codes <list>` | - | 股票代码列表，逗号分隔 | - |
| `--period <q\|y>` | - | 报告周期：q=季度报告，y=年度报告 | q |
| `--count <n>` | - | 获取报告数量 | 4 |
| `-h, --help` | - | 显示帮助信息 | - |

### 使用示例

**获取单个股票最近20年年度财务数据：**
```bash
node index.js --codes 600079 --period y --count 20
```

**获取多个股票最近4个季度财务数据：**
```bash
node index.js --codes 600079,000001 --period q --count 4
```

**从文件读取股票代码列表：**
```bash
# 创建stocks.txt文件，内容如下：
# 600079
# 000001
# 600519

node index.js --file stocks.txt --period y --count 10
```

## 输出文件

### 数据文件
- 路径：`./data/`
- 格式：`eastmoney_finance_YYYY-MM-DD.csv`
- 编码：UTF-8 with BOM（支持Excel直接打开中文）

### 日志文件  
- 路径：`./log/`
- 格式：`eastmoney_YYYY-MM-DD.log`

## 数据字段说明

CSV文件包含以下字段：

| 字段名 | 说明 |
|--------|------|
| SECUCODE | 证券代码（带交易所后缀） |
| SECURITY_CODE | 证券代码 |
| SECURITY_NAME_ABBR | 证券简称 |
| REPORT_TYPE | 报告类型（年报/季报） |
| REPORT_YEAR | 报告年份 |
| REPORT_DATE | 报告日期 |
| KCFJCXSYJLR | 扣除非经常性损益后的净利润 |
| TOTALOPERATEREVE | 营业总收入 |
| GROSS_PROFIT | 毛利润 |
| PARENTNETPROFIT | 归属于母公司股东的净利润 |
| DEDU_PARENT_PROFIT | 扣除非经常性损益后的归属于母公司股东净利润 |

## 注意事项

1. **请求频率限制**：脚本已设置10秒请求间隔，避免被网站封禁
2. **数据准确性**：数据来源于东方财富网，仅供参考
3. **股票代码格式**：支持A股6位数字代码，自动识别SH/SZ交易所
4. **错误处理**：如遇网络错误或数据解析失败，会在日志中记录

## 示例输出

运行 `node index.js --codes 600079 --period y --count 20` 后：

- 数据保存到：`./data/eastmoney_finance_2026-06-09.csv`
- 日志保存到：`./log/eastmoney_2026-06-09.log`

CSV文件内容示例：
```csv
SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_TYPE,REPORT_YEAR,REPORT_DATE,KCFJCXSYJLR,TOTALOPERATEREVE,GROSS_PROFIT,PARENTNETPROFIT,DEDU_PARENT_PROFIT
600079.SH,600079,ST人福,年报,2025,2025-12-31 00:00:00,1762.40487057,23962.01016464,,1855.33443396,
```

所有金额数据单位均为百万元。

---

# 主营构成数据爬取（mainop.js）

`mainop.js` 用于爬取上市公司的**主营构成**数据，包括按行业、按产品、按地区三个维度的营收/成本/利润构成。

## 使用方法

```bash
node mainop.js [options]
```

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--file <path>` | 股票代码文件路径（每行一个代码，#开头为注释） | - |
| `--codes <list>` | 股票代码列表，逗号分隔 | - |
| `--date <list>` | 报告日期，逗号分隔（如 `2024-12-31`）。省略则获取全部可用期次 | - |
| `--count <n>` | 单次请求返回的最大行数 | 200 |
| `-h, --help` | 显示帮助信息 | - |

### 使用示例

**获取单个股票指定期次的主营构成：**
```bash
node mainop.js --codes 600079 --date 2024-12-31
```

**获取多个期次：**
```bash
node mainop.js --codes 600079 --date 2024-12-31,2023-12-31
```

**获取全部可用期次（不指定日期）：**
```bash
node mainop.js --codes 600079
```

## 输出文件

- 路径：`./data/`
- 格式：`eastmoney_mainop_YYYY-MM-DD.csv`
- 编码：UTF-8 with BOM

## 数据字段说明

| 字段名 | 说明 |
|--------|------|
| SECUCODE | 证券代码（带交易所后缀） |
| SECURITY_CODE | 证券代码 |
| REPORT_DATE | 报告日期 |
| MAINOP_TYPE | 构成分类代码（1=按行业，2=按产品，3=按地区） |
| MAINOP_TYPE_NAME | 构成分类名称（脚本派生字段） |
| ITEM_NAME | 项目名称（如制造业、医疗器械、国内等） |
| MAIN_BUSINESS_INCOME | 主营收入（单位：百万元） |
| MBI_RATIO | 收入占比 |
| MAIN_BUSINESS_COST | 主营成本（单位：百万元） |
| MBC_RATIO | 成本占比 |
| MAIN_BUSINESS_RPOFIT | 主营利润（单位：百万元） |
| MBR_RATIO | 利润占比 |
| GROSS_RPOFIT_RATIO | 毛利率 |
| RANK | 同分类下的排序 |

金额字段（收入/成本/利润）单位为百万元；占比与毛利率为小数（如 0.56 表示 56%）。