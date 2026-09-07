import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

interface CacheEntry {
  timestamp: number;
  data: any;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

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

      const cacheKey = queryParams.toString();
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return res.json({ ...cached.data, cached: true });
      }

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
