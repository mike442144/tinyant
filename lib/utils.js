import dayjs from "dayjs";

export function parseDateRangeCninfo(dateStr) {
	if (!dateStr) {
		const today = dayjs().format("YYYY-MM-DD");
		const monthAgo = dayjs().subtract(1, 'month').format("YYYY-MM-DD");
		return { from: monthAgo, to: today };
	}
	const parts = dateStr.split(/[~]/).map(p => p.trim()).filter(Boolean);
	if (parts.length >= 2) return { from: parts[0], to: parts[parts.length - 1] };
	const single = parts[0] || dateStr.trim();
	return { from: single, to: single };
}

export function parseDateRangeHkex(dateStr) {
	if (!dateStr) {
		const today = dayjs().format("YYYYMMDD");
		const monthAgo = dayjs().subtract(1, 'month').format("YYYYMMDD");
		return { from: monthAgo, to: today };
	}
	const isoMatch = dateStr.match(/(\d{4}-\d{2}-\d{2})\s*[~-]\s*(\d{4}-\d{2}-\d{2})/);
	if (isoMatch) {
		return { from: isoMatch[1].replace(/-/g, ''), to: isoMatch[2].replace(/-/g, '') };
	}
	const parts = dateStr.split(/[~-]/).map(p => p.replace(/[^\d]/g, '')).filter(Boolean);
	if (parts.length >= 2) return { from: parts[0], to: parts[1] };
	return { from: parts[0], to: parts[0] };
}

export function sanitizeFilename(s) {
	return s.replace(/[\/\\:*?"<>|\n\r]/g, "_").slice(0, 60);
}

export function extractFiscalYearCn(title) {
	return title.match(/(\d{4})\s*年/)?.[1];
}

const CN_DIGITS = { '零': '0', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };

export function extractFiscalYearHk(title) {
	const cnMatch = title.match(/[零一二三四五六七八九]{4}/);
	if (cnMatch) {
		return [...cnMatch[0]].map(c => CN_DIGITS[c]).join('');
	}
	return title.match(/(\d{4})/)?.[1];
}
