// Hyperliquid 시그널 스캐너 — GitHub Actions용
// Node 20+ (fetch 내장), 외부 의존성 없음.
// 로직은 계산기 HTML의 백테스트/스캐너 탭과 동일:
//   봉 마감 기준 RSI 극단 + 최근 60일 펀딩비 백분위 극단 → 반전 베팅 시그널
// 중복 알림 방지 (2중):
//   1) "직전 봉에는 조건이 없었고 이번 봉에 새로 발생"했을 때만 알림 (봉 단위)
//   2) signals.log에 알림 보낸 봉을 기록 — 같은 봉 안에서 여러 번 실행돼도 재알림 안 함
//      (signals.log는 워크플로가 저장소에 커밋하므로 실전 신호 기록 겸용)

const fs = require('fs');
const CFG = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf-8'));
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';

const API = 'https://api.hyperliquid.xyz/info';
// 화면 표시명 → API 심볼 별칭
const ALIAS = { WTIOIL: 'xyz:CL', SAMSUNG: 'xyz:SMSN', SKHYNIX: 'xyz:SKHX', BRENTOIL: 'xyz:BRENTOIL' };
const IV_MS = { '15m': 9e5, '1h': 36e5, '4h': 144e5 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- config 검증 (오타를 API 에러가 아닌 명확한 메시지로) ---------- */
function validateConfig(c) {
  const errs = [];
  if (!Array.isArray(c.watchlist) || !c.watchlist.length) errs.push('watchlist: 비어있지 않은 배열이어야 함');
  if (!IV_MS[c.interval]) errs.push(`interval: ${Object.keys(IV_MS).join('/')} 중 하나여야 함 (현재 "${c.interval}")`);
  if (!(c.rsiPeriod >= 2)) errs.push('rsiPeriod: 2 이상 숫자여야 함');
  if (!(c.rsiExtreme > 0 && c.rsiExtreme < 50)) errs.push('rsiExtreme: 0~50 사이 숫자여야 함');
  if (typeof c.useFunding !== 'boolean') errs.push('useFunding: true 또는 false여야 함');
  if (c.useFunding && !(c.fundingPercentile > 0 && c.fundingPercentile < 50)) errs.push('fundingPercentile: 0~50 사이 숫자여야 함');
  if (!(c.atrMult > 0)) errs.push('atrMult: 0보다 큰 숫자여야 함');
  if (!(c.rr > 0)) errs.push('rr: 0보다 큰 숫자여야 함');
  if (errs.length) {
    console.error('config.json 설정 오류:\n - ' + errs.join('\n - '));
    process.exit(1);
  }
}

/* ---------- 신호 기록 (signals.log: 같은 봉 재알림 방지 + 실전 기록) ---------- */
const LOG_FILE = __dirname + '/signals.log';
function readLog() {
  try { return fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(l => l && l[0] !== '#'); }
  catch { return []; }
}
function appendLog(cols) {
  if (!fs.existsSync(LOG_FILE))
    fs.writeFileSync(LOG_FILE, '# 알림시각\t종목\t방향\t신호봉시각\tRSI\t현재가\t손절\t목표\n');
  fs.appendFileSync(LOG_FILE, cols.join('\t') + '\n');
}

/* ---------- API (호출 간격 제한 + 타임아웃 + 429·네트워크 오류 재시도) ---------- */
let lastCall = 0;
async function api(body) {
  for (let a = 0; a < 5; a++) {
    const wait = Math.max(0, lastCall + 300 - Date.now());
    if (wait) await sleep(wait);
    lastCall = Date.now();
    let r;
    try {
      r = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
      });
    } catch (e) {
      if (a === 4) throw new Error('API 응답 없음: ' + e.message);
      await sleep(1500 * (a + 1)); continue;
    }
    if (r.status === 429) { await sleep(2000 * (a + 1)); continue; }
    if (!r.ok) throw new Error('API ' + r.status);
    return r.json();
  }
  throw new Error('API 429 지속 — 다음 실행에서 재시도');
}

/* ---------- 지표 ---------- */
function rsiSeries(closes, p) {
  const rsi = new Array(closes.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= p; l /= p;
  rsi[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return rsi;
}
function atrOf(ks, p = 14) {
  const tr = [];
  for (let i = 1; i < ks.length; i++)
    tr.push(Math.max(ks[i].h - ks[i].l, Math.abs(ks[i].h - ks[i - 1].c), Math.abs(ks[i].l - ks[i - 1].c)));
  let atr = tr.slice(0, p).reduce((a, b) => a + b) / p;
  for (let i = p; i < tr.length; i++) atr = (atr * (p - 1) + tr[i]) / p;
  return atr;
}
function percentile(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(q / 100 * s.length)))];
}

/* ---------- 데이터 ---------- */
async function fetchCandles(coin, interval, bars) {
  const end = Date.now(), start = end - IV_MS[interval] * bars;
  const raw = await api({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } });
  return raw.map(k => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c }));
}
async function fetchFunding(coin, startTime) {
  // 페이지 크기를 가정하지 않고, 새 데이터가 더 안 나올 때까지 반복 (최대 60회)
  let out = [], t = startTime;
  for (let i = 0; i < 60; i++) {
    const chunk = await api({ type: 'fundingHistory', coin, startTime: t });
    if (!chunk.length) break;
    out = out.concat(chunk);
    const last = chunk[chunk.length - 1].time;
    if (last <= t) break;
    t = last + 1;
  }
  return out.map(f => ({ t: f.time, r: parseFloat(f.fundingRate) }));
}
async function resolveNames(list) {
  // BTC 같은 메인 심볼은 그대로, WTIOIL 같은 별칭은 변환, TSLA 같은 HIP-3 심볼은 전 dex에서 탐색
  const upper = list.map(c => c.trim().toUpperCase());
  const need = upper.some(c => !c.includes(':') && ALIAS[c] === undefined);
  let all = null;
  if (need) {
    all = [];
    const dexs = await api({ type: 'perpDexs' });
    for (const d of dexs) {
      const dn = d && d.name ? d.name : '';
      try {
        const m = await api(dn ? { type: 'meta', dex: dn } : { type: 'meta' });
        for (const u of m.universe) if (!u.isDelisted) all.push(u.name);
      } catch (e) { /* dex 하나 실패는 무시 */ }
    }
  }
  return upper.map(c => {
    if (ALIAS[c]) return ALIAS[c];
    if (c.includes(':')) return c.split(':')[0].toLowerCase() + ':' + c.split(':')[1];
    if (all) {
      if (all.includes(c)) return c;                        // 메인 dex
      const hip = all.find(x => x.endsWith(':' + c));       // HIP-3 dex
      if (hip) return hip;
    }
    return c; // 못 찾으면 그대로 시도 (캔들 조회 실패 시 로그에 남음)
  });
}

/* ---------- 알림 ---------- */
function fmtP(x) {
  const d = x >= 1000 ? 1 : x >= 10 ? 2 : x >= 0.1 ? 4 : 6;
  return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
async function notify(title, msg) {
  console.log('[알림]', title, '|', msg);
  if (!NTFY_TOPIC) { console.log('  → NTFY_TOPIC 미설정: 발송 생략 (저장소 Secrets에 등록할 것)'); return; }
  try {
    await fetch('https://ntfy.sh/' + encodeURIComponent(NTFY_TOPIC), {
      method: 'POST', body: msg,
      headers: { 'Title': title, 'Priority': 'high', 'Tags': 'rotating_light' },
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) { console.log('  → ntfy 발송 실패:', e.message); }
}

/* ---------- 메인 ---------- */
(async () => {
  validateConfig(CFG);
  const { interval, rsiPeriod, rsiExtreme, useFunding, fundingPercentile, atrMult, rr } = CFG;
  const logLines = readLog();
  console.log(`=== HL 스캐너 시작 ${new Date().toISOString()} ===`);
  console.log(`조건: RSI(${rsiPeriod}) ≤${rsiExtreme} 롱 / ≥${100 - rsiExtreme} 숏` +
    (useFunding ? ` + 펀딩 ${fundingPercentile}% 극단(60일)` : '') + ` · ${interval}봉`);

  // 전체 실패 처리: 스캐너가 조용히 죽어있지 않도록 폰으로도 통지 — 단 6시간에 1회만 (로그로 중복 방지)
  async function totalFailure(reason) {
    console.log(`전체 실패: ${reason}`);
    const lastFail = logLines.filter(l => l.split('\t')[1] === 'SCANNER_FAIL').pop();
    if (!lastFail || Date.now() - Date.parse(lastFail.split('\t')[0]) > 6 * 36e5) {
      await notify('HL 스캐너 오류', `${reason} — GitHub Actions 로그 확인 필요`);
      appendLog([new Date().toISOString(), 'SCANNER_FAIL', '-', '-', reason]);
    }
    process.exit(1);
  }

  let coins;
  try { coins = await resolveNames(CFG.watchlist); }
  catch (e) { return totalFailure(`종목명 조회 실패 (${e.message})`); }
  console.log('감시 종목:', coins.join(', '));
  let alerts = 0, errors = 0;

  for (const coin of coins) {
    try {
      const ks = await fetchCandles(coin, interval, 300);
      if (ks.length < rsiPeriod + 20) { console.log(`${coin}: 캔들 부족(${ks.length}) — 건너뜀`); continue; }
      const closed = ks.slice(0, -1); // 진행 중인 봉 제외 (봉 마감 기준)
      const closes = closed.map(k => k.c);
      const rsi = rsiSeries(closes, rsiPeriod);
      const atr = atrOf(closed.slice(-60));
      const px = ks[ks.length - 1].c;

      // 봉별 펀딩 매핑 (백테스트와 동일)
      let fundAt = null, fLo = 0, fHi = 0;
      if (useFunding) {
        const fh = await fetchFunding(coin, Date.now() - 60 * 864e5);
        if (fh.length < 100) { console.log(`${coin}: 펀딩 데이터 부족(${fh.length}) — 펀딩 필터 없이 판정`); }
        else {
          const vals = fh.map(v => v.r);
          fLo = percentile(vals, fundingPercentile);
          fHi = percentile(vals, 100 - fundingPercentile);
          fundAt = new Array(closed.length).fill(NaN);
          let j = 0;
          for (let i = 0; i < closed.length; i++) {
            while (j + 1 < fh.length && fh[j + 1].t <= closed[i].t) j++;
            if (fh[j].t <= closed[i].t) fundAt[i] = fh[j].r;
          }
        }
      }
      const cond = i => {
        if (!isFinite(rsi[i])) return null;
        const fOk = !fundAt || isFinite(fundAt[i]);
        if (rsi[i] <= rsiExtreme && (!fundAt || (fOk && fundAt[i] <= fLo))) return '롱';
        if (rsi[i] >= 100 - rsiExtreme && (!fundAt || (fOk && fundAt[i] >= fHi))) return '숏';
        return null;
      };
      const nowSig = cond(closed.length - 1);
      const prevSig = cond(closed.length - 2);
      const fresh = nowSig && nowSig !== prevSig; // 이번 봉에서 새로 발생한 시그널만

      console.log(`${coin}: RSI ${rsi[rsi.length - 1].toFixed(1)}` +
        (fundAt ? ` 펀딩 ${(fundAt[fundAt.length - 1] * 100).toFixed(4)}%/h` : '') +
        ` → ${nowSig ? nowSig + ' 시그널' + (fresh ? ' (신규!)' : ' (지속 — 알림 생략)') : '대기'}`);

      if (fresh) {
        // 같은 봉에 대해 이미 알림을 보냈으면 생략 (5분 크론이 1시간 봉 안에서 여러 번 돌아도 1회만)
        const barT = new Date(closed[closed.length - 1].t).toISOString();
        if (logLines.some(l => { const p = l.split('\t'); return p[1] === coin && p[3] === barT; })) {
          console.log(`  → 같은 봉(${barT})에 이미 알림 발송됨 — 생략`);
        } else {
          const d = nowSig === '롱' ? 1 : -1;
          const stop = px - d * atrMult * atr, tgt = px + d * atrMult * atr * rr;
          await notify(`HL 시그널: ${coin} ${nowSig}`,
            `${coin} ${nowSig} | RSI ${rsi[rsi.length - 1].toFixed(1)} | 현재가 ${fmtP(px)} · 손절≈${fmtP(stop)} · 목표≈${fmtP(tgt)} | 계산기 판정 필수`);
          appendLog([new Date().toISOString(), coin, nowSig, barT, rsi[rsi.length - 1].toFixed(1), fmtP(px), fmtP(stop), fmtP(tgt)]);
          alerts++;
        }
      }
    } catch (e) { console.log(`${coin}: 오류 — ${e.message}`); errors++; }
  }
  console.log(`=== 완료: 알림 ${alerts}건, 오류 ${errors}건 ===`);
  // 오류가 있어도 exit 0 (다음 주기에 재시도) — 전 종목 실패 시에만 실패 처리
  if (errors && errors >= coins.length) await totalFailure(`전 종목(${coins.length}개) 조회 실패`);
})();
