// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // Node >=18 has global fetch, but this ensures compatibility
import dotenv from "dotenv";
import puppeteer from "puppeteer";
import pkg from "pdf-parse"; // ✅ Correct import for pdf-parse in ESM
import { Buffer } from "buffer";

dotenv.config();

const SECRET = process.env.SECRET;
const PORT = process.env.PORT || 3000;
const app = express();

app.use(bodyParser.json({ limit: "2mb" }));

function errorJson(res, status, message) {
  return res.status(status).json({ error: message });
}

function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout (${label}) after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

app.post("/task", async (req, res) => {
  const startTime = Date.now();

  if (!req.is("application/json")) {
    return errorJson(res, 400, "Expected application/json");
  }
  const payload = req.body;
  if (!payload || !payload.email || !payload.secret || !payload.url) {
    return errorJson(res, 400, "Missing required fields: email, secret, url");
  }

  if (payload.secret !== SECRET) {
    return errorJson(res, 403, "Invalid secret");
  }

  res.status(200).json({ accepted: true });

  try {
    const TOTAL_BUDGET = 3 * 60 * 1000;
    const elapsed = Date.now() - startTime;
    const remaining = TOTAL_BUDGET - elapsed;
    if (remaining <= 5000) {
      console.error("Not enough time remaining to process the quiz");
      return;
    }

    await withTimeout(processQuiz(payload, remaining), remaining - 1000, "processQuiz");
    console.log("Processing finished for", payload.url);
  } catch (err) {
    console.error("Error processing quiz:", err);
  }
});

async function processQuiz({ email, secret, url }) {
  console.log("Starting to solve:", url);

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: "new",
  });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(45_000);

  try {
    await page.goto(url, { waitUntil: "networkidle2" });
    await page.waitForTimeout(600);

    const pageText = await page.evaluate(() => document.body.innerText);
    console.log("Page text snippet:", pageText.slice(0, 300));

    const extracted = await page.evaluate(() => {
      const pre = document.querySelector("pre");
      const resultDiv = document.querySelector("#result");
      return {
        pre: pre ? pre.innerText : null,
        resultHtml: resultDiv ? resultDiv.innerText : null,
        body: document.body.innerText,
      };
    });

    let candidate = extracted.pre || extracted.resultHtml || pageText;
    const base64Matches = candidate.match(/[A-Za-z0-9+/=\n]{100,}/g);
    let decodedText = null;

    if (base64Matches && base64Matches.length) {
      for (const b64 of base64Matches) {
        try {
          const clean = b64.replace(/\s+/g, "");
          const buf = Buffer.from(clean, "base64");
          const txt = buf.toString("utf8");
          if (txt && (txt.includes("Q834") || txt.includes("Download file") || txt.includes("sum of"))) {
            decodedText = txt;
            break;
          }
          if (!decodedText) decodedText = txt;
        } catch (e) {}
      }
    }

    if (decodedText) {
      console.log("Decoded base64 text sample:", decodedText.slice(0, 400));
      const jsonMatch = decodedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log("Found JSON in decoded text:", parsed);
          if (parsed.url) {
            await handleResourceTask(parsed, { email, secret });
            await browser.close();
            return;
          }
        } catch (e) {
          console.warn("JSON parse failed:", e.message);
        }
      }
    }

    const submitInfo = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a"));
      const submitAnchor = anchors.find(a => /submit/i.test(a.href) || /submit/i.test(a.innerText));
      const plain = document.body.innerText.match(/https?:\/\/\S+/g) || [];
      return {
        submitHref: submitAnchor ? submitAnchor.href : null,
        urls: plain,
      };
    });

    console.log("Submit info:", submitInfo);
  } finally {
    await browser.close();
  }
}

async function handleResourceTask(instruction, { email, secret }) {
  const resourceUrl = instruction.url;
  console.log("Downloading resource:", resourceUrl);
  const resp = await fetch(resourceUrl);
  if (!resp.ok) {
    throw new Error(`Failed download ${resourceUrl}: ${resp.status}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  const buffer = await resp.arrayBuffer();
  const nodeBuf = Buffer.from(buffer);

  if (contentType.includes("pdf") || resourceUrl.endsWith(".pdf")) {
    const parsed = await pkg(nodeBuf); // ✅ Correct usage for pdf-parse
    const text = parsed.text;
    const numbers = Array.from(text.matchAll(/[-+]?[0-9]*\.?[0-9]+/g), m => parseFloat(m[0]));
    const sum = numbers.reduce((a, b) => a + b, 0);
    console.log("Crude sum of all numbers in PDF:", sum);

    const submitUrl = instruction.submit || instruction.submitUrl || instruction.postUrl || "https://example.com/submit";
    const payload = { email, secret, url: instruction.url, answer: Math.round(sum) };

    console.log("Would POST payload to", submitUrl, payload);
    try {
      const r = await fetch(submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      console.log("Submit response:", data);
    } catch (e) {
      console.error("Submit error:", e);
    }
  } else {
    console.log("Unknown content type:", contentType);
  }
}

// ✅ Add simple GET route to confirm server is running
app.get("/", (req, res) => {
  res.send("🚀 LLM Analysis Quiz Server is running successfully!");
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
