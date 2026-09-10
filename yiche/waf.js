// 瑞数 WAF (tws2_) JS 挑战求解：car.yiche.com 翻页/cookie过期时返回4KB挑战页，
// 页面计算 document.cookie = `${pfs}${asu}=` + base64(rc4(KEY, `${pts}:${asu}`)) 后 reload。
// KEY 硬编码在混淆脚本里（'tg09It3*9h'），WAF 升级换 KEY 时需从挑战页重新提取。
const KEY = "tg09It3*9h";

export const isChallenge = body =>
	typeof body === "string" && body.includes("_xvasu") && !body.includes("rk-list-box");

function rc4(key, data) {
	const S = Array.from({ length: 256 }, (_, i) => i);
	let j = 0;
	for (let i = 0; i < 256; i++) {
		j = (j + S[i] + key.charCodeAt(i % key.length)) % 256;
		[S[i], S[j]] = [S[j], S[i]];
	}
	let i = 0;
	j = 0;
	const out = Buffer.alloc(data.length);
	for (let k = 0; k < data.length; k++) {
		i = (i + 1) % 256;
		j = (j + S[i]) % 256;
		[S[i], S[j]] = [S[j], S[i]];
		out[k] = data.charCodeAt(k) ^ S[(S[i] + S[j]) % 256];
	}
	return out;
}

export function solveTws2(body, currentCookie) {
	const asu = body.match(/var _xvasu = (\d+);/)?.[1];
	const pfs = body.match(/var _xvpfs = "([^"]+)";/)?.[1];
	const pts = body.match(/var _xvpts = ([\d.]+);/)?.[1];
	if (!asu || !pfs || !pts) throw new Error("waf: cannot parse challenge vars");
	const value = rc4(KEY, `${pts}:${asu}`).toString("base64");
	const others = String(currentCookie || "").split(/;\s*/).filter(c => c && !c.startsWith(pfs));
	return `${pfs}${asu}=${value}${others.length ? "; " + others.join("; ") : ""}`;
}
