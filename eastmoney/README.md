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