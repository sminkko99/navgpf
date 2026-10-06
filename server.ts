import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

interface CacheEntry {
  timestamp: number;
  data: any;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes cache

interface OfficialGpfResult {
  date: string; // YYYY-MM-DD
  plans: Record<string, number>;
  sourceUrl: string;
  fetchedAt: string;
}

let latestOfficialGpf: OfficialGpfResult | null = null;
let lastOfficialFetchTime = 0;

/**
 * Fetch latest NAV published on official GPF website:
 * https://www.gpf.or.th/thai2019/About/main.php?page=memberfund&lang=th&menu=statistic
 */
async function fetchOfficialGpfNav(force = false): Promise<OfficialGpfResult | null> {
  const now = Date.now();
  if (!force && latestOfficialGpf && (now - lastOfficialFetchTime < 60 * 1000)) {
    return latestOfficialGpf;
  }

  try {
    const url = "https://www.gpf.or.th/thai2019/About/main.php?page=memberfund&lang=th&menu=statistic";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`Official GPF responded with HTTP ${res.status}`);
      return latestOfficialGpf;
    }

    const html = await res.text();

    // Extract published date (e.g., วันที่ประกาศใช้ 09/09/2569)
    let dateStr = "";
    const dateMatch = html.match(/วันที่ประกาศใช้[\s\S]*?(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (dateMatch) {
      const day = dateMatch[1].padStart(2, "0");
      const month = dateMatch[2].padStart(2, "0");
      const rawYear = parseInt(dateMatch[3], 10);
      const ceYear = rawYear > 2400 ? (rawYear - 543) : rawYear;
      dateStr = `${ceYear}-${month}-${day}`;
    }

    const planNavMap: Record<string, number> = {};
    const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    if (tableMatches.length > 0) {
      const rows = tableMatches[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
      for (const r of rows) {
        const tds = (r.match(/<td[\s\S]*?<\/td>/gi) || [])
          .map(td => td.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim())
          .filter(t => t.length > 0);
        if (tds.length >= 2) {
          let planRaw = tds[0];
          let valRaw = tds[1];
          if (tds.length >= 3 && isNaN(parseFloat(tds[1])) && !isNaN(parseFloat(tds[2]))) {
            planRaw = tds[1];
            valRaw = tds[2];
          }
          const val = parseFloat(valRaw.replace(/,/g, ""));
          if (!isNaN(val)) {
            let cleanName = planRaw;
            if (cleanName.includes("แผนเชิงรุก 20")) cleanName = "แผนเชิงรุก 20";
            else if (cleanName.includes("แผนเชิงรุก 75")) cleanName = "แผนเชิงรุก 75";
            else if (cleanName.includes("แผนเกษียณสบายใจ")) cleanName = "แผนเกษียณสบายใจ 2569";
            planNavMap[cleanName] = val;
          }
        }
      }
    }

    if (dateStr && Object.keys(planNavMap).length > 0) {
      latestOfficialGpf = {
        date: dateStr,
        plans: planNavMap,
        sourceUrl: url,
        fetchedAt: new Date().toISOString()
      };
      lastOfficialFetchTime = now;
      console.log(`[Official GPF] Synced data for date: ${dateStr} (${Object.keys(planNavMap).length} plans)`);
    }

    return latestOfficialGpf;
  } catch (err: any) {
    console.error("Error scraping official GPF website:", err?.message || err);
    return latestOfficialGpf;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "35mb" }));
  app.use(express.urlencoded({ extended: true, limit: "35mb" }));

  // API Health Check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Real GPF NAV Endpoint
  app.get("/api/nav", async (req, res) => {
    try {
      const planNamesParam = req.query.plan_names;
      const from = (req.query.from as string) || "";
      const to = (req.query.to as string) || "";
      const granularity = (req.query.granularity as string) || "day";
      const mode = (req.query.mode as string) || "absolute";

      // Normalize plan_names into string array
      let planNames: string[] = [];
      if (Array.isArray(planNamesParam)) {
        planNames = planNamesParam.map(p => String(p));
      } else if (typeof planNamesParam === "string" && planNamesParam.length > 0) {
        planNames = [planNamesParam];
      }

      if (planNames.length === 0) {
        // Default to main plans if none specified
        planNames = ["แผนหุ้นต่างประเทศ", "แผนเชิงรุก 65"];
      }

      // Build target URL for gpftool
      const queryParams = new URLSearchParams();
      planNames.forEach(p => queryParams.append("plan_names[]", p));
      if (from) queryParams.append("from", from);
      if (to) queryParams.append("to", to);
      if (granularity) queryParams.append("granularity", granularity);
      if (mode) queryParams.append("mode", mode);

      const isForceRefresh = req.query.refresh === "1" || req.query.refresh === "true" || Boolean(req.query._t);

      const cacheKey = queryParams.toString();
      if (isForceRefresh) {
        cache.delete(cacheKey);
      } else {
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
          return res.json({ ...cached.data, cached: true });
        }
      }

      // Fetch official GPF data (force if user requested refresh)
      const officialGpf = await fetchOfficialGpfNav(isForceRefresh);

      const targetUrl = `https://gpftool.com/api/nav?${queryParams.toString()}`;
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*"
        },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`GPF API responded with HTTP ${response.status}`);
      }

      const data = await response.json();

      // Merge official GPF data if official publication has a newer date
      if (officialGpf && officialGpf.date && data && data.stats_as_of) {
        const officialDate = officialGpf.date;
        const currentStatsDate = data.stats_as_of.date;

        if (officialDate > currentStatsDate) {
          // 1. Add date to labels if not present
          if (Array.isArray(data.labels) && !data.labels.includes(officialDate)) {
            data.labels.push(officialDate);
          }

          // 2. Append new daily point to series
          if (Array.isArray(data.series)) {
            data.series.forEach((s: any) => {
              const officialNav = officialGpf.plans[s.plan_name];
              if (officialNav !== undefined && Array.isArray(s.points)) {
                const alreadyHasPoint = s.points.some((pt: any) => pt.date === officialDate);
                if (!alreadyHasPoint) {
                  s.points.push({
                    date: officialDate,
                    label: officialDate,
                    value: officialNav
                  });
                }
              }
            });
          }

          // 3. Update stats object for each plan
          if (Array.isArray(data.stats)) {
            data.stats.forEach((st: any) => {
              const officialNav = officialGpf.plans[st.plan_name];
              if (officialNav !== undefined && st.latest_date !== officialDate) {
                const oldLatestNav = st.latest_nav;
                const oldLatestDate = st.latest_date;
                st.prev_date = oldLatestDate;
                st.prev_nav = oldLatestNav;
                st.latest_date = officialDate;
                st.latest_nav = officialNav;
                st.day_change = Number((officialNav - oldLatestNav).toFixed(4));
                st.day_change_pct = oldLatestNav > 0 ? Number(((st.day_change / oldLatestNav) * 100).toFixed(4)) : 0;
                
                if (st.first_nav) {
                  st.inception_change = Number((officialNav - st.first_nav).toFixed(4));
                  st.inception_change_pct = Number(((st.inception_change / st.first_nav) * 100).toFixed(4));
                }
                if (st.ytd_nav) {
                  st.ytd_change = Number((officialNav - st.ytd_nav).toFixed(4));
                  st.ytd_change_pct = Number(((st.ytd_change / st.ytd_nav) * 100).toFixed(4));
                }
                if (st.month_nav) {
                  st.month_change = Number((officialNav - st.month_nav).toFixed(4));
                  st.month_change_pct = Number(((st.month_change / st.month_nav) * 100).toFixed(4));
                }
                if (st.max_nav && officialNav >= st.max_nav) {
                  st.max_nav = officialNav;
                  st.is_ath = true;
                } else {
                  st.is_ath = false;
                }
              }
            });
          }

          // 4. Update metadata
          data.stats_as_of.date = officialDate;
          data.stats_as_of.synced_at = officialGpf.fetchedAt;
          data.source = "gpf.or.th (ประกาศทางการ) + gpftool.com";
          data.official_gpf = {
            date: officialGpf.date,
            sourceUrl: officialGpf.sourceUrl,
            fetchedAt: officialGpf.fetchedAt
          };
        }
      }

      // Store in memory cache
      cache.set(cacheKey, { timestamp: Date.now(), data });

      return res.json({ ...data, cached: false });
    } catch (error: any) {
      console.error("Error fetching GPF NAV:", error?.message || error);
      return res.status(502).json({
        ok: false,
        error: error?.message || "Failed to fetch GPF NAV data"
      });
    }
  });

  // Direct Official GPF statistics endpoint
  app.get("/api/gpf-official", async (req, res) => {
    try {
      const force = req.query.refresh === "1" || req.query.refresh === "true";
      const result = await fetchOfficialGpfNav(force);
      return res.json({ ok: true, data: result });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || err });
    }
  });

  // Query NAV by specific date (matches payday or deduction date)
  app.get("/api/nav-by-date", async (req, res) => {
    try {
      const planName = (req.query.plan_name as string) || "แผนหุ้นต่างประเทศ";
      const targetDate = (req.query.date as string) || new Date().toISOString().split("T")[0];

      // Query window from 20 days before targetDate up to targetDate (or slightly after)
      const targetD = new Date(targetDate);
      const fromD = new Date(targetD.getTime() - 20 * 86400000);
      const fromStr = fromD.toISOString().split("T")[0];
      const toStr = targetDate;

      const queryParams = new URLSearchParams();
      queryParams.append("plan_names[]", planName);
      queryParams.append("from", fromStr);
      queryParams.append("to", toStr);
      queryParams.append("granularity", "day");
      queryParams.append("mode", "absolute");

      const targetUrl = `https://gpftool.com/api/nav?${queryParams.toString()}`;
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*"
        }
      });

      if (!response.ok) {
        throw new Error(`GPF API responded with HTTP ${response.status}`);
      }

      const data = await response.json();
      const series = (data.series || []).find((s: any) => s.plan_name === planName);
      const points = series?.points || [];

      if (points.length === 0) {
        // Fallback: fetch without narrow date restriction to get latest available NAV
        const fallbackRes = await fetch(`https://gpftool.com/api/nav?plan_names[]=${encodeURIComponent(planName)}&granularity=day&mode=absolute`, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
        });
        const fallbackData = await fallbackRes.json();
        const fallbackSeries = (fallbackData.series || []).find((s: any) => s.plan_name === planName);
        const fallbackPoints = fallbackSeries?.points || [];
        const lastPt = fallbackPoints[fallbackPoints.length - 1];

        if (lastPt) {
          return res.json({
            ok: true,
            planName,
            targetDate,
            usedDate: lastPt.date,
            nav: lastPt.value,
            isExact: lastPt.date === targetDate,
            isFuture: targetDate > lastPt.date,
            note: targetDate > lastPt.date ? `วันในอนาคต: ใช้ราคา NAV ล่าสุดที่มีการประกาศ (${lastPt.date})` : `ใช้วันทำการล่าสุด (${lastPt.date})`
          });
        }
        return res.status(404).json({ ok: false, error: "ไม่พบข้อมูล NAV ของแผนที่เลือก" });
      }

      // Check exact match
      const exactPoint = points.find((p: any) => p.date === targetDate);
      if (exactPoint) {
        return res.json({
          ok: true,
          planName,
          targetDate,
          usedDate: exactPoint.date,
          nav: exactPoint.value,
          isExact: true,
          isFuture: false,
          note: `ราคา NAV ณ วันที่ ${exactPoint.date} ตรงตามประกาศจริง`
        });
      }

      // Preceding point
      const validPoints = points.filter((p: any) => p.date <= targetDate);
      const lastAvailable = validPoints.length > 0 ? validPoints[validPoints.length - 1] : points[0];

      return res.json({
        ok: true,
        planName,
        targetDate,
        usedDate: lastAvailable.date,
        nav: lastAvailable.value,
        isExact: false,
        isFuture: targetDate > lastAvailable.date,
        note: `วันหยุดหรือเสาร์-อาทิตย์: ใช้วันทำการล่าสุด ณ ${lastAvailable.date}`
      });
    } catch (err: any) {
      console.error("Error looking up NAV by date:", err?.message || err);
      return res.status(500).json({ ok: false, error: err?.message || "Failed to lookup NAV by date" });
    }
  });

  // Statement PDF & Image Parsing via Gemini API
  app.post("/api/parse-statement", async (req, res) => {
    try {
      const { fileBase64, mimeType, fileName } = req.body;
      if (!fileBase64) {
        return res.status(400).json({ ok: false, error: "กรุณาแนบไฟล์สเตทเมนต์ (Base64)" });
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ ok: false, error: "GEMINI_API_KEY is not configured" });
      }

      const ai = new GoogleGenAI();
      const prompt = `คุณคือผู้เชี่ยวชาญด้านการตรวจสอบและแปลงข้อมูลสเตทเมนต์ กบข. (กองทุนบำเหน็จบำนาญข้าราชการ) / BalanceTransactionDetail
จงอ่านเอกสารสเตทเมนต์ที่แนบมานี้อย่างละเอียด และดึงข้อมูลประวัติรายการนำส่งเงินและสับเปลี่ยนแผนทั้งหมดออกมาเป็นโครงสร้าง JSON:

สำคัญมาก:
1. แต่ละรายการ (Transaction) ต้องระบุ:
   - "date": วันที่ทำรายการในรูปแบบ "YYYY-MM-DD" (เช่น ถ้าในเอกสารเป็น พ.ศ. เช่น 26/08/2569 หรือ 26 ส.ค. 2569 ให้แปลงเป็น ค.ศ. คือ "2026-08-26")
   - "thaiDate": วันที่ภาษาไทยตามเอกสาร เช่น "26 ส.ค. 2569"
   - "type": "contribution" สำหรับเงินนำส่งรายเดือน, "switch_in" สำหรับสับเปลี่ยนเข้า, "switch_out" สำหรับสับเปลี่ยนออก
   - "typeName": "เงินนำส่ง" หรือ "สับเปลี่ยน เข้า" หรือ "สับเปลี่ยน ออก"
   - "planName": ชื่อแผนการลงทุน เช่น "แผนหุ้นต่างประเทศ", "แผนเชิงรุก 65", "แผนตราสารหนี้", "แผนหลัก"
   - "totalAmount": ยอดเงินรวม (บาท เป็นตัวเลขทศนิยมบวกเสมอ เช่น 1243.20)
   - "nav": มูลค่าต่อหน่วย (NAV) หากมีระบุในเอกสาร (ตัวเลขทศนิยม 4 ตำแหน่ง เช่น 38.9041) หรือถ้าไม่มีระบุให้ใส่ null
   - "units": จำนวนหน่วย หากมีระบุในเอกสาร หรือถ้าไม่มีระบุให้ใส่ null
   - "saving": เงินสะสม (บาท) หากมีแยกรายละเอียด
   - "matching": เงินสมทบ (บาท) หากมีแยกรายละเอียด
   - "compensation": เงินชดเชย (บาท) หากมีแยกรายละเอียด
   - "extraSaving": เงินสะสมส่วนเพิ่ม (บาท) หากมีแยกรายละเอียด
   - "initialFund": เงินประเดิม (บาท) หากมีระบุ

2. จงส่งผลลัพธ์เป็น JSON Object รูปแบบ:
{
  "memberInfo": {
    "memberName": string หรือ null,
    "memberId": string หรือ null,
    "statementPeriod": string หรือ null
  },
  "transactions": [
    ...รายการธุรกรรมเรียงตามวันที่...
  ]
}
`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: mimeType || "application/pdf",
                  data: fileBase64
                }
              },
              {
                text: prompt
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json"
        }
      });

      const responseText = response.text || "{}";
      let parsedResult: any = {};
      try {
        parsedResult = JSON.parse(responseText);
      } catch (e) {
        const cleaned = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
        parsedResult = JSON.parse(cleaned);
      }

      const txList = Array.isArray(parsedResult.transactions) ? parsedResult.transactions : [];

      // For transactions where NAV is not present or user wants to reference contribution date NAV:
      for (const tx of txList) {
        if (!tx.nav || tx.nav <= 0) {
          try {
            const planQ = encodeURIComponent(tx.planName || "แผนหุ้นต่างประเทศ");
            const navRes = await fetch(`https://gpftool.com/api/nav?plan_names[]=${planQ}&from=${tx.date}&to=${tx.date}&granularity=day&mode=absolute`, {
              headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
            });
            if (navRes.ok) {
              const navData = await navRes.json();
              const series = (navData.series || []).find((s: any) => s.plan_name === (tx.planName || "แผนหุ้นต่างประเทศ"));
              const pt = series?.points?.find((p: any) => p.date === tx.date);
              if (pt && pt.value > 0) {
                tx.nav = pt.value;
                if (!tx.units || tx.units <= 0) {
                  tx.units = Number((tx.totalAmount / pt.value).toFixed(4));
                }
              }
            }
          } catch (e) {
            // Silently continue
          }
        }
      }

      return res.json({
        ok: true,
        fileName: fileName || "statement.pdf",
        memberInfo: parsedResult.memberInfo || {},
        transactions: txList
      });
    } catch (err: any) {
      console.error("Error parsing statement with Gemini:", err?.message || err);
      return res.status(500).json({
        ok: false,
        error: err?.message || "Failed to parse statement document"
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
