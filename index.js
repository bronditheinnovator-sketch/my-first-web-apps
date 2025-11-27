import "dotenv/config";
import express from "express";
import multer from "multer";
import puppeteer from "puppeteer";
import fs from "fs";
import { parse } from "csv-parse/sync";
// removed unused: import os from "os";

const app = express();
const PORT = process.env.PORT || 3000;

// File upload setup (CSV will be stored temporarily in /uploads)
const upload = multer({ dest: "uploads/" });

const YNAB_LOGIN_URL = "https://app.ynab.com/users/sign_in";

// small delay helper
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clickButton(page, xpath) {
  try {
    await page.waitForXPath(xpath, { timeout: 5000 });
    const [btn] = await page.$x(xpath);
    if (!btn) return false;
    await btn.click();
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- HOME PAGE (unchanged UI) ---------- */
app.get("/", (req, res) => {
  res.send(`
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 flex justify-center py-10">
  <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-lg">
    <h1 class="text-2xl font-bold mb-4 text-center">📊 YNAB Automation Tool</h1>

    <form action="/run" method="POST" enctype="multipart/form-data" class="space-y-6">

      <!-- Email -->
      <div>
        <label class="font-medium">Email</label>
        <input type="email" name="email" class="w-full mt-1 p-3 border rounded-lg" required placeholder="Enter YNAB Email">
      </div>

      <!-- Password + Toggle -->
      <div>
        <label class="font-medium">Password</label>
        <div class="flex items-center">
          <input type="password" id="password" name="password" class="w-full mt-1 p-3 border rounded-lg" required placeholder="Enter YNAB Password">
          <button type="button" onclick="togglePass()" class="ml-2 px-3 py-2 text-sm bg-gray-200 rounded">Show</button>
        </div>
      </div>

      <!-- Budget Name -->
      <div>
        <label class="font-medium">Budget Name</label>
        <input type="text" name="budgetName" class="w-full mt-1 p-3 border rounded-lg" required placeholder="Example: Ciwaruga">
      </div>

      <!-- File Upload -->
      <div>
        <label class="font-medium">Upload Categories File</label>
        <input type="file" id="fileInput" name="csvFile" accept=".csv,.xlsx" class="w-full mt-1 p-3 border rounded-lg" required>
        <p id="fileError" class="text-red-500 text-sm hidden">Invalid file. Use CSV or Excel.</p>
      </div>

      <button type="submit" id="submitBtn" class="w-full bg-blue-600 text-white py-3 rounded-xl hover:bg-blue-700">
        🚀 Run Automation
      </button>
    </form>
  </div>

  <script>
    function togglePass() {
      const pass = document.getElementById("password");
      pass.type = pass.type === "password" ? "text" : "password";
    }

    document.getElementById("fileInput").addEventListener("change", function() {
      const file = this.files[0];
      const allowed = ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
      if (!file) return;
      if (!allowed.includes(file.type)) {
        document.getElementById("fileError").classList.remove("hidden");
        document.getElementById("submitBtn").disabled = true;
      } else {
        document.getElementById("fileError").classList.add("hidden");
        document.getElementById("submitBtn").disabled = false;
      }
    });
  </script>
</body>
</html>
  `);
});

/* ---------- RUN AUTOMATION ---------- */
app.post("/run", upload.single("csvFile"), async (req, res) => {
  let logs = "";
  const log = (msg) => {
    console.log(msg);
    logs += msg + "<br>";
  };

  const userEmail = req.body.email?.trim();
  const userPassword = req.body.password?.trim();
  const csvPath = req.file?.path;
  const BUDGET_NAME = req.body.budgetName?.trim();

  if (!userEmail || !userPassword) {
    return res.status(400).send("Missing email or password.");
  }
  if (!BUDGET_NAME || !csvPath) {
    return res.status(400).send("Missing budget name or CSV/XLSX file.");
  }

  try {
    log("✅ Web app starting...");
    log("🚀 Launching headful Chrome (for visibility)...");

    const browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null, // let Chrome follow actual window size
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--no-sandbox",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();

    // 🔧 Ensure Puppeteer always focuses newest active page (YNAB sometimes opens new window)
    browser.on("targetcreated", async (target) => {
      try {
        const newPage = await target.page();
        if (newPage) {
          await newPage.bringToFront();
          console.log("🔄 Switched to newly opened page...");
        }
      } catch (e) {
        console.log("⚠️ Could not switch to new page:", e.message);
      }
    });

    // Stop user events from interfering (best-effort)
    await page.evaluateOnNewDocument(() => {
      ["mousemove", "mousedown", "mouseup", "keydown", "keyup"].forEach(evt =>
        document.addEventListener(evt, e => e.stopPropagation(), true)
      );
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );

    // Anti-detection patches
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3],
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    log("🌐 Opening YNAB login page...");
    await page.goto(YNAB_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(2500);

    // Save debug snapshot
    try { fs.writeFileSync("debug-dashboard.html", await page.content()); log("📄 Saved debug-dashboard.html for inspection."); } catch (e) {}

    // ---------- LOGIN ----------
    const emailSelector = 'input[name="user[email]"], input[type="email"], input#email, input#user_email';
    const passSelector = 'input[name="user[password]"], input[type="password"], input#password, input#user_password';

    await delay(1500); // prevent bot detection
    await clickButton(page, "//button[contains(text(), 'Sign in')]");
    await delay(2000);

    const loginButtonSelector = 'button[type="submit"], button[data-testid="login-submit"], form button';

    const hasLoginForm = await page.$(emailSelector);
    if (hasLoginForm) {
      log("✍️ Logging in...");
      await page.type(emailSelector, userEmail, { delay: 30 });
      await page.type(passSelector, userPassword, { delay: 30 });

      // click submit (try multiple ways)
      const clickAttempt = async () => {
        try {
          await page.click(loginButtonSelector);
          return true;
        } catch {
          // fallback: click by text
          const clicked = await page.evaluate((text) => {
            text = text.toLowerCase();
            const els = Array.from(document.querySelectorAll("button, [role='button'], a"));
            for (const el of els) {
              if ((el.innerText || el.textContent || "").toLowerCase().includes(text)) { el.click(); return true; }
            }
            return false;
          }, "sign in");
          return clicked;
        }
      };
      await clickAttempt();
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
      log("✅ Logged in (attempted).");
    } else {
      log("⚠️ Login form not found — attempting main app page...");
      await page.goto("https://app.ynab.com/", { waitUntil: "domcontentloaded" });
      await delay(2000);
    }







    // =======================
    // Robust CSV/XLSX loader
    // =======================
    log("📥 Reading uploaded file...");
    const fileBuffer = fs.readFileSync(csvPath);
    let fileContent = fileBuffer.toString("utf8").replace(/\uFEFF/g, "");

function repairMalformedLines(text) {
  return text
    .split(/\r?\n/)
    .map(line => {
      line = line.trim();
      if (!line) return line;

      // Case: whole row inside quotes
      // Example: " Pondasi,""Pedestal..."",123"
      if (line.startsWith('"') && line.endsWith('"')) {
        const inner = line.slice(1, -1); // remove outer quotes
        return inner.replace(/""/g, '"'); // unescape ""
      }

      return line;
    })
    .join("\n");
}

fileContent = repairMalformedLines(fileContent);



    // Try CSV parse
    let rawRecords = [];
    try {
      rawRecords = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        quote: '"',
        relax_column_count: true,
      });
      log(`✅ Loaded ${rawRecords.length} rows (CSV parse)`);
    } catch (err) {
      log(`⚠️ CSV parse failed: ${err.message}`);
      // fallback to Excel
      try {
        const xlsx = await import("xlsx");
        const workbook = xlsx.read(fileBuffer, { type: "buffer" });
        const sheet = workbook.SheetNames[0];
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheet], { defval: "" });
        rawRecords = rows.map(r => ({
          "Category Group": r["Category Group"] || r["Category"] || r["group"] || "",
          "Category Name": r["Category Name"] || r["Name"] || r["category"] || "",
          "Amount": r["Amount"] || r["Budget"] || r["amount"] || "",
        }));
        log(`✅ Loaded ${rows.length} rows (Excel .xlsx)`);
      } catch (e) {
        fs.writeFileSync("debug-bad-csv.txt", fileContent.slice(0, 20000));
        throw new Error("❌ Cannot parse CSV/XLSX file. Saved debug-bad-csv.txt for analysis.");
      }
    }

    // Normalize values & convert amount to number
  rawRecords = rawRecords.map(r => {
  const normalized = {};
  Object.keys(r).forEach(k => {
    const cleanKey = k.trim().replace(/^\uFEFF/, ""); // trim and remove BOM
    normalized[cleanKey] = r[k];
  });
  return normalized;
});
    const records = rawRecords.map(r => {
  const group = (r["Category Group"] || r["Category"] || r["group"] || "").trim();
  const category = (r["Category Name"] || r["Name"] || r["category"] || "").trim();
  let amtStr = (r["Amount"] || r["Budget"] || r["amount"] || "").toString().trim();

  amtStr = amtStr.replace(/\./g, "").replace(/,/g, ".");
  const amount = Number(amtStr.replace(/[^\d.-]/g, "")) || 0;

  if (!group || !category) return null;
  return { category_group: group, category_name: category, amount };
}).filter(Boolean);


    if (!records.length) throw new Error("❌ No valid rows found in file. Check CSV/XLSX headers.");
    log(`📚 Parsed ${records.length} rows for processing.`);

    // ---------- open budget (direct attempt) ----------
    async function openBudgetDirect(page, budgetName, log) {
      log(`🔍 Trying to open budget directly: "${budgetName}"`);
      const href = await page.evaluate((name) => {
        name = (name || "").trim().toLowerCase();
        const anchors = Array.from(document.querySelectorAll('a[href*="/budget"], a[href*="/budgets"], a[href*="budget"]'));
        const candidates = anchors.map(a => ({ href: a.href, text: (a.innerText || a.textContent || "").trim() }));
        let match = candidates.find(c => c.text && c.text.toLowerCase() === name);
        if (match) return match.href;
        match = candidates.find(c => c.text && c.text.toLowerCase().includes(name));
        if (match) return match.href;
        match = candidates.find(c => c.href && c.href.toLowerCase().includes(name.replace(/\s+/g, '-')));
        if (match) return match.href;
        return null;
      }, budgetName);

      if (href) {
        log(`🧭 Found budget link -> ${href}`);
        await page.goto(href, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => log(`⚠️ goto failed: ${e.message}`));
        await delay(1200);
        log("📁 Budget opened (direct).");
        return true;
      }

      log("ℹ️ Not found on current page — trying /users/budgets ...");
      try {
        await page.goto('https://app.ynab.com/users/budgets', { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(1000);

        const hrefOnAll = await page.evaluate((name) => {
          name = (name || "").trim().toLowerCase();
          const anchors = Array.from(document.querySelectorAll('a[href*="/budget"]'));
          const candidates = anchors.map(a => ({ href: a.href, text: (a.innerText||"").trim() }));
          let match = candidates.find(c => c.text && c.text.toLowerCase() === name);
          if (match) return match.href;
          match = candidates.find(c => c.text && c.text.toLowerCase().includes(name));
          if (match) return match.href;
          return null;
        }, budgetName);

        if (hrefOnAll) {
          log(`🧭 Found budget link on /users/budgets -> ${hrefOnAll}`);
          await page.goto(hrefOnAll, { waitUntil: 'networkidle2', timeout: 60000 });
          await delay(1000);
          log("📁 Budget opened (from /users/budgets).");
          return true;
        }
      } catch (e) {
        log(`⚠️ Error while searching /users/budgets: ${e.message}`);
      }

      // debug list
      try {
        const debugCandidates = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href*="/budget"], a[href*="/budgets"], a[href*="budget"]'))
            .slice(0, 200)
            .map(a => ({ href: a.href, text: (a.innerText || a.textContent || "").trim() }))
        );
        fs.writeFileSync('debug-budgets.json', JSON.stringify(debugCandidates, null, 2));
        log(`🧾 Saved debug-budgets.json (count: ${debugCandidates.length}).`);
      } catch (e) {
        log(`⚠️ Couldn't write debug-budgets.json: ${e.message}`);
      }

      log(`❌ Unable to find budget "${budgetName}" by direct URL.`);
      return false;
    }

    const ok = await openBudgetDirect(page, BUDGET_NAME, log);
    if (!ok) {
      return res.send(`<h3>❌ Could not open budget "${BUDGET_NAME}".</h3>
        <p>Saved debug-budgets.json. Paste its start here and I will inspect.</p><pre>${logs}</pre>`);
    }

    await delay(800);

    // ---------- DOM helpers (no XPath) ----------
    async function clickButtonByText(page, text) {
      text = (text || "").toString().toLowerCase();
      const clicked = await page.evaluate((needle) => {
        const els = Array.from(document.querySelectorAll("button, a, [role='button']"));
        for (const el of els) {
          const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
          const aria = (el.getAttribute && el.getAttribute("aria-label") || "").toLowerCase();
          const title = (el.getAttribute && el.getAttribute("title") || "").toLowerCase();
          if (txt.includes(needle) || aria.includes(needle) || title.includes(needle)) {
            el.click();
            return true;
          }
        }
        return false;
      }, text);
      return !!clicked;
    }

    // Find master category row by scanning master rows
    async function findMasterRowHandle(page, groupName) {
      groupName = (groupName || "").toString().trim().toLowerCase();
      await page.waitForSelector(".is-master-category, .budget-table-row", { timeout: 5000 }).catch(() => {});
      const handles = await page.$$(".is-master-category, .budget-table-row.is-master-category");
      for (const h of handles) {
        const txt = await h.evaluate(el => {
          const nameEl = el.querySelector(".budget-table-cell-name, .budget-table-row-name");
          return (nameEl && (nameEl.innerText || nameEl.textContent || "").trim()) || "";
        });
        if ((txt || "").toLowerCase() === groupName) return h;
      }
      return null;
    }

    // Ensure group expanded
    async function ensureGroupExpandedByHandle(page, groupHandle) {
      if (!groupHandle) return false;
      // try to detect collapsed state by attribute or class
      const collapsed = await groupHandle.evaluate(el => {
        return el.classList.contains("collapsed") || el.classList.contains("is-collapsed") || el.classList.contains("closed");
      });
      if (collapsed) {
        await groupHandle.click();
        await delay(400);
      }
      return true;
    }

    // Get subsequent rows after master until next master
    async function getSubRowsAfterMaster(page, masterHandle) {
      const allRows = await page.$$(".budget-table-row");
      // find index
      let idx = -1;
      for (let i = 0; i < allRows.length; i++) {
        const same = await allRows[i].evaluate((a, b) => a === b, masterHandle);
        if (same) { idx = i; break; }
      }
      if (idx === -1) return [];
      const subs = [];
      for (let i = idx + 1; i < allRows.length; i++) {
        const isMaster = await allRows[i].evaluate(el => el.classList.contains("is-master-category") || el.classList.contains("budget-table-row-master"));
        if (isMaster) break;
        subs.push(allRows[i]);
      }
      return subs;
    }

    // Check if subcategory exists
    async function subcategoryExists2(page, groupName, catName) {
      const master = await findMasterRowHandle(page, groupName);
      if (!master) return false;
      await ensureGroupExpandedByHandle(page, master);
      const subs = await getSubRowsAfterMaster(page, master);
      for (const rowH of subs) {
        const name = await rowH.evaluate(el => {
          const n = el.querySelector(".budget-table-cell-name, .budget-table-row-name");
          return (n && (n.innerText || n.textContent || "").trim()) || "";
        });
        if ((name || "").toLowerCase() === (catName || "").toLowerCase()) return true;
      }
      return false;
    }

    // Create subcategory
    async function createSubcategory2(page, groupName, catName, log) {
      const master = await findMasterRowHandle(page, groupName);
      if (!master) { log(`⚠️ Master group "${groupName}" not found for subcategory creation`); return false; }
      await ensureGroupExpandedByHandle(page, master);
      // try common + buttons inside the master row or next row
      let addBtn = await master.$("button[data-testid='add-category'], button.budget-table-cell-add-category, button[aria-label='Add Category']");
      if (!addBtn) {
        // try next sibling
        const next = await master.evaluateHandle(el => el.nextElementSibling);
        if (next) addBtn = await next.$("button[data-testid='add-category'], button.budget-table-cell-add-category, button[aria-label='Add Category']");
      }
      if (!addBtn) { log(`⚠️ Add category button not found for group "${groupName}"`); return false; }
      await addBtn.click();
      await delay(400);
      // now find input for new category
      const input = await page.$("input[data-testid='category-name-input'], input[placeholder='New Category'], div[contenteditable='true']");
      if (!input) { log("⚠️ Could not find input to type subcategory"); return false; }
      // prefer text input
      try {
        const isEditable = await input.evaluate(el => el.getAttribute && el.getAttribute("contenteditable") === "true").catch(() => false);
        if (isEditable) {
          await page.evaluate((el, txt) => { el.innerText = txt; }, input, catName);
        } else {
          await input.type(catName, { delay: 20 });
        }
      } catch (e) {
        // fallback: set via evaluate
        await page.evaluate((txt) => {
          const el = document.querySelector("input[data-testid='category-name-input'], input[placeholder='New Category'], div[contenteditable='true']");
          if (!el) return;
          if (el.getAttribute && el.getAttribute("contenteditable") === "true") el.innerText = txt;
          else el.value = txt;
        }, catName);
      }
      await page.keyboard.press("Enter");
      await delay(600);
      log(`✅ Created subcategory: ${catName}`);
      return true;
    }

    
async function setBudgetAmount2(page, subcategoryName, amount, log) {
  try {
    log(`💵 Setting amount for ${subcategoryName} → ${amount}`);

    // Find checkbox element
    const checkbox = await page.$(`button[aria-label="${subcategoryName}"]`);
    if (!checkbox) {
      log(`❌ Checkbox not found for: ${subcategoryName}`);
      return false;
    }

    await checkbox.evaluate(el => el.scrollIntoView({ block: "center" }));
    await delay(100);

    // Find row
    const row = await page.evaluateHandle((name) => {
      const btn = document.querySelector(`button[aria-label="${name}"]`);
      if (!btn) return null;

      let el = btn;
      while (el && !el.classList?.contains("budget-table-row")) {
        el = el.parentElement;
      }
      return el || null;
    }, subcategoryName);

    if (!row) {
      log(`❌ Row not found for: ${subcategoryName}`);
      return false;
    }

    await row.evaluate(el => el.scrollIntoView({ block: "center" }));
    await delay(150);

    await row.click();
    await delay(150);

    // Select the budget input
    const input = await row.$('input.ember-text-field');
    if (!input) {
      log(`❌ Budget input not found for: ${subcategoryName}`);
      return false;
    }

    // focus input
await input.focus();

// select all and delete
await page.keyboard.down("Control");
await page.keyboard.press("A");
await page.keyboard.up("Control");
await page.keyboard.press("Backspace");

// type numeric value only (no thousands separator)
await page.keyboard.type(amount.toString(), { delay: 20 });

// blur to trigger YNAB save
await input.evaluate(el => el.blur());
await page.keyboard.press("Tab");
await delay(300);



    const savedValue = await input.evaluate(el => el.value);
    const numericSaved = Number(savedValue.replace(/[^\d]/g, ""));

    if (numericSaved !== amount) {
      log(`⚠️ YNAB rejected input, retrying…`);

      await delay(300);
      await input.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.keyboard.type(amount.toString(), { delay: 20 });
      await page.keyboard.press("Enter");
      await delay(800);
    }

    log(`✅ Assigned Rp${amount} → ${subcategoryName}`);
    return true;

  } catch (e) {
    log(`❌ Error setBudgetAmount2(${subcategoryName}): ${e.message}`);
    return false;
  }
}



    // ---------- MAIN LOOP ----------
    for (const row of records) {
      const groupName = row.category_group;
      const catName = row.category_name;
      const amount = Number.isFinite(row.amount) ? row.amount : 0;

      log(`\n📂 Processing: ${groupName} → ${catName} → Budget ${amount}`);

      try {
        // Ensure group exists (check page)
        const groupExists = await page.evaluate((name) => {
          const masters = Array.from(document.querySelectorAll(".is-master-category, .budget-table-row.is-master-category"));
          return masters.some(m => {
            const n = m.querySelector(".budget-table-cell-name, .budget-table-row-name");
            return n && (n.innerText || n.textContent || "").trim().toLowerCase() === name.toLowerCase();
          });
        }, groupName);

        if (!groupExists) {
          log(`➕ Creating group: ${groupName}`);
          // try click "Add Category Group" button (by text)
          let clicked = await clickButtonByText(page, "category group");
          if (!clicked) {
            // fallback: try button text "Add group" or "Add category group"
            clicked = await clickButtonByText(page, "add group") || await clickButtonByText(page, "add category group");
          }
          if (clicked) {
            await delay(400);
            const input = await page.$("input[data-testid='category-group-name-input'], input[placeholder*='Category']");
            if (input) {
              await input.focus();
              await page.keyboard.type(groupName, { delay: 20 });
              await page.keyboard.press("Enter");
              await delay(600);
              log(`✅ Created group: ${groupName}`);
            } else {
              log("⚠️ Could not find input for new group after clicking the button.");
            }
          } else {
            log("⚠️ +Category Group button not found.");
          }
        } else {
          log(`✔️ Group exists: ${groupName}`);
        }

        // Expand group and create subcategory if needed
        const exists = await subcategoryExists2(page, groupName, catName);
        if (!exists) {
          await createSubcategory2(page, groupName, catName, log);
        } else {
          log(`✔️ Subcategory exists: ${catName}`);
        }

        // Set budget amount
        if (amount > 0) {
          await setBudgetAmount2(page, catName, amount, log);
        } else {
          log("ℹ️ Amount is 0 or invalid — skipping.");
        }

      } catch (e) {
        log(`❌ Error processing ${groupName} → ${catName}: ${e.message || e}`);
      }
    }

    log("🎉 Finished automation successfully!");

    // close browser gracefully
    try { await browser.close(); } catch (e) { /* ignore */ }

    res.send(`<h3>✅ Automation Complete!</h3><p>${logs}</p>`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`<h3>❌ Error:</h3><pre>${err.message || err}</pre><p>Logs:<br>${logs}</p>`);
  } finally {
    // cleanup uploaded file (safe guard)
    try { if (csvPath && fs.existsSync(csvPath)) fs.unlinkSync(csvPath); } catch (e) {}
  }
});

/* ---------- START SERVER ---------- */
app.listen(PORT, () => console.log(`✅ Web app running on port ${PORT}`));
