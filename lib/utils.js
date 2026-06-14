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

export function extractFiscalYearHk(title) {
	return title.match(/(\d{4})/)?.[1];
}
